import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * The visible time window, and nothing else.
 *
 * SPEC.md is explicit that Redux holds UI state only and never raw samples.
 * That is not an arbitrary rule: 2.4M points live in the worker's ring buffers,
 * and putting even one frame's worth through a store — immutably updated,
 * diffed, and handed to React — is how the M2 renderers died. The store holds a
 * window descriptor and a duration. Bounds are milliseconds because that is
 * what ECharts' time axis speaks and what stays JSON-serialisable; the
 * nanosecond conversion happens at the renderer boundary.
 */

/**
 * "Paused" and "zoomed" are the same condition: the window stopped following
 * the clock. Modelling them as one union rather than two booleans makes the
 * contradictory state — paused but still tracking live — unrepresentable.
 */
export type ViewWindow =
  | { kind: "live" }
  | { kind: "pinned"; startMs: number; endMs: number };

export interface ViewState {
  window: ViewWindow;
  /** Live window size, remembered across pinning so resume restores it. */
  durationMs: number;
}

export const WINDOW_SIZES = [
  { label: "5s", ms: 5_000 },
  { label: "30s", ms: 30_000 },
  { label: "2m", ms: 120_000 },
  { label: "10m", ms: 600_000 },
] as const;

/** Ten minutes at 1kHz — the ring buffer's capacity, and so the pannable range. */
export const RETENTION_MS = 600_000;

/**
 * Narrowest window the user can reach: 100ms, about 100 samples per channel.
 * Below this the view stops being a trace and starts being a few dots.
 */
export const MIN_SPAN_MS = 100;

export const initialViewState: ViewState = {
  window: { kind: "live" },
  durationMs: 600_000,
};

interface ZoomPayload {
  startMs: number;
  endMs: number;
  /** Supplied by the caller so the reducer stays pure and testable. */
  nowMs: number;
  retentionMs: number;
}

const viewSlice = createSlice({
  name: "view",
  initialState: initialViewState,
  reducers: {
    /** Freeze the window currently on screen. */
    pause(state, action: PayloadAction<{ nowMs: number }>) {
      if (state.window.kind === "pinned") return;

      state.window = {
        kind: "pinned",
        startMs: action.payload.nowMs - state.durationMs,
        endMs: action.payload.nowMs,
      };
    },

    /** Follow the clock again. Also serves the Jump to Live button. */
    jumpToLive(state) {
      state.window = { kind: "live" };
    },

    /**
     * Pick a live window size. Always returns to live: the control means "show
     * me the last N", which is a statement about the present.
     */
    setWindowSize(state, action: PayloadAction<number>) {
      if (!WINDOW_SIZES.some((w) => w.ms === action.payload)) return;

      state.durationMs = action.payload;
      state.window = { kind: "live" };
    },

    /**
     * Pin to an explicit range, from a zoom or pan gesture.
     *
     * Doing this in one transition matters: pinning and pausing as separate
     * actions would leave a frame in which the view was still live, and the
     * frame loop would snap it back to now before the pin landed.
     */
    zoomTo(state, action: PayloadAction<ZoomPayload>) {
      const { startMs, endMs, nowMs, retentionMs } = action.payload;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
      if (endMs <= startMs) return;

      // Nothing exists before the ring buffer's horizon or after now, so a
      // gesture that reaches past either is trimmed to what can be served.
      const earliest = nowMs - retentionMs;
      const clampedStart = Math.max(startMs, earliest);
      const clampedEnd = Math.min(endMs, nowMs);

      // A range entirely outside the retained span collapses under clamping.
      // Storing it would pin the view to an empty window with no way back
      // except Jump to Live, so it is refused instead.
      if (clampedEnd <= clampedStart) return;

      state.window = { kind: "pinned", startMs: clampedStart, endMs: clampedEnd };
    },

    /**
     * Zoom by a multiplicative factor about a point in the view.
     *
     * Relative, not absolute, and that is the whole point. The first version of
     * this read ECharts' dataZoom percentages and used them directly, which
     * created a feedback loop: the chart reports a fraction of the data it
     * currently holds, and applying the result replaced that data with exactly
     * the range selected. Zoom-out could then never exceed 100% of an
     * ever-narrowing window, so it behaved like zoom-in. Expressing the gesture
     * against the window we already own removes the loop entirely.
     */
    zoomBy(
      state,
      action: PayloadAction<{
        factor: number;
        /** Where the cursor sat across the plot, 0 (left) to 1 (right). */
        anchorFraction: number;
        nowMs: number;
        retentionMs: number;
      }>,
    ) {
      const { factor, anchorFraction, nowMs, retentionMs } = action.payload;
      if (!Number.isFinite(factor) || factor <= 0) return;
      if (!Number.isFinite(anchorFraction)) return;

      const current = resolveBounds(state, nowMs);
      const span = current.endMs - current.startMs;

      // Zooming out past everything retained is a request to see it all, which
      // is just live at the full window.
      const wanted = span * factor;
      if (wanted >= retentionMs) {
        state.window = { kind: "live" };
        state.durationMs = retentionMs;
        return;
      }

      const nextSpan = Math.max(wanted, MIN_SPAN_MS);

      // Hold the instant under the cursor still, so zooming feels anchored
      // rather than recentring.
      const anchor = current.startMs + anchorFraction * span;
      const start = anchor - anchorFraction * nextSpan;

      state.window = fitWindow(start, nextSpan, nowMs, retentionMs);
    },

    /** Slide the window by a fraction of its own span. Positive is forwards. */
    panBy(
      state,
      action: PayloadAction<{ fraction: number; nowMs: number; retentionMs: number }>,
    ) {
      const { fraction, nowMs, retentionMs } = action.payload;
      if (!Number.isFinite(fraction)) return;

      const current = resolveBounds(state, nowMs);
      const span = current.endMs - current.startMs;

      state.window = fitWindow(current.startMs + fraction * span, span, nowMs, retentionMs);
    },
  },
});

/** The concrete bounds a state is currently showing. */
function resolveBounds(state: ViewState, nowMs: number): { startMs: number; endMs: number } {
  return state.window.kind === "pinned"
    ? { startMs: state.window.startMs, endMs: state.window.endMs }
    : { startMs: nowMs - state.durationMs, endMs: nowMs };
}

/**
 * Place a window of a given span inside the retained range.
 *
 * Slides rather than truncates when it runs off an edge, so panning to the end
 * of the buffer keeps the span the user chose instead of squashing the view.
 */
function fitWindow(
  startMs: number,
  spanMs: number,
  nowMs: number,
  retentionMs: number,
): ViewWindow {
  const earliest = nowMs - retentionMs;
  const span = Math.min(spanMs, retentionMs);

  let start = startMs;
  if (start + span > nowMs) start = nowMs - span;
  if (start < earliest) start = earliest;

  return { kind: "pinned", startMs: start, endMs: start + span };
}

export const { pause, jumpToLive, setWindowSize, zoomTo, zoomBy, panBy } = viewSlice.actions;
export default viewSlice.reducer;

/**
 * What the renderer needs to draw a window.
 *
 * The store keeps `durationMs` beside the window rather than inside it, so that
 * resuming from a pin restores the size the user last chose. A renderer has no
 * use for that distinction — it just needs to know how far back "live" reaches —
 * so the two are resolved into one value here.
 */
export type RenderWindow =
  | { kind: "live"; durationMs: number }
  | { kind: "pinned"; startMs: number; endMs: number };

export function selectRenderWindow(state: ViewState): RenderWindow {
  return state.window.kind === "live"
    ? { kind: "live", durationMs: state.durationMs }
    : state.window;
}

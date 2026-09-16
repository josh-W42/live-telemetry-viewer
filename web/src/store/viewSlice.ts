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
  },
});

export const { pause, jumpToLive, setWindowSize, zoomTo } = viewSlice.actions;
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

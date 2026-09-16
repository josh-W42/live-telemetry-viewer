import { describe, expect, it } from "vitest";

import reducer, {
  initialViewState,
  jumpToLive,
  MIN_SPAN_MS,
  panBy,
  pause,
  RETENTION_MS,
  setWindowSize,
  WINDOW_SIZES,
  zoomBy,
  zoomTo,
  type ViewState,
} from "./viewSlice";

const NOW = 1_700_000_000_000; // fixed "now" in ms, so tests never read a clock

/** State pinned to an explicit range. */
function pinned(startMs: number, endMs: number, durationMs = 30_000): ViewState {
  return { window: { kind: "pinned", startMs, endMs }, durationMs };
}

describe("initial state", () => {
  it("starts live at the largest window, matching the M3 default", () => {
    expect(initialViewState.window).toEqual({ kind: "live" });
    expect(initialViewState.durationMs).toBe(600_000);
  });

  it("offers the window sizes the spec names", () => {
    expect(WINDOW_SIZES.map((w) => w.ms)).toEqual([5_000, 30_000, 120_000, 600_000]);
  });
});

describe("pause", () => {
  it("pins the window that was showing, not a recomputed one", () => {
    const state = reducer({ window: { kind: "live" }, durationMs: 30_000 }, pause({ nowMs: NOW }));

    expect(state.window).toEqual({
      kind: "pinned",
      startMs: NOW - 30_000,
      endMs: NOW,
    });
  });

  it("keeps the selected duration so resuming returns to the same size", () => {
    const state = reducer({ window: { kind: "live" }, durationMs: 5_000 }, pause({ nowMs: NOW }));
    expect(state.durationMs).toBe(5_000);
  });

  it("leaves an already-pinned window untouched", () => {
    const before = pinned(NOW - 1000, NOW - 500);
    expect(reducer(before, pause({ nowMs: NOW }))).toEqual(before);
  });
});

describe("resuming", () => {
  it("jumpToLive returns to live at the current duration", () => {
    const state = reducer(pinned(NOW - 9000, NOW - 4000, 120_000), jumpToLive());

    expect(state.window).toEqual({ kind: "live" });
    expect(state.durationMs).toBe(120_000);
  });

  it("is a no-op when already live", () => {
    const before: ViewState = { window: { kind: "live" }, durationMs: 5_000 };
    expect(reducer(before, jumpToLive())).toEqual(before);
  });
});

describe("setWindowSize", () => {
  it("changes the duration and returns to live from a pinned state", () => {
    const state = reducer(pinned(NOW - 9000, NOW - 4000), setWindowSize(5_000));

    expect(state.window).toEqual({ kind: "live" });
    expect(state.durationMs).toBe(5_000);
  });

  it("changes the duration while already live", () => {
    const state = reducer(
      { window: { kind: "live" }, durationMs: 600_000 },
      setWindowSize(120_000),
    );

    expect(state.window).toEqual({ kind: "live" });
    expect(state.durationMs).toBe(120_000);
  });

  it("ignores a size that is not on the menu", () => {
    const before: ViewState = { window: { kind: "live" }, durationMs: 30_000 };
    expect(reducer(before, setWindowSize(99_999))).toEqual(before);
  });
});

describe("zoomTo", () => {
  const base = { nowMs: NOW, retentionMs: RETENTION_MS };

  // Zooming while live has to do two things at once, and doing them as one
  // transition is what stops the view snapping back to now on the next frame.
  it("pins and auto-pauses in a single transition when live", () => {
    const state = reducer(
      { window: { kind: "live" }, durationMs: 600_000 },
      zoomTo({ ...base, startMs: NOW - 5_000, endMs: NOW - 1_000 }),
    );

    expect(state.window).toEqual({
      kind: "pinned",
      startMs: NOW - 5_000,
      endMs: NOW - 1_000,
    });
  });

  it("replaces the range and stays pinned when already pinned", () => {
    const state = reducer(
      pinned(NOW - 60_000, NOW),
      zoomTo({ ...base, startMs: NOW - 8_000, endMs: NOW - 2_000 }),
    );

    expect(state.window).toEqual({
      kind: "pinned",
      startMs: NOW - 8_000,
      endMs: NOW - 2_000,
    });
  });

  it("does not disturb the selected duration", () => {
    const state = reducer(
      { window: { kind: "live" }, durationMs: 5_000 },
      zoomTo({ ...base, startMs: NOW - 400_000, endMs: NOW - 300_000 }),
    );

    expect(state.durationMs).toBe(5_000);
  });

  describe("clamping", () => {
    // The ring buffer only retains ten minutes. Panning further back would ask
    // the worker for samples that have already been overwritten.
    it("clamps a start earlier than the retained data", () => {
      const state = reducer(
        { window: { kind: "live" }, durationMs: 600_000 },
        zoomTo({ ...base, startMs: NOW - RETENTION_MS - 120_000, endMs: NOW - 1_000 }),
      );

      expect(state.window).toEqual({
        kind: "pinned",
        startMs: NOW - RETENTION_MS,
        endMs: NOW - 1_000,
      });
    });

    it("clamps an end in the future", () => {
      const state = reducer(
        { window: { kind: "live" }, durationMs: 600_000 },
        zoomTo({ ...base, startMs: NOW - 5_000, endMs: NOW + 60_000 }),
      );

      expect(state.window).toEqual({ kind: "pinned", startMs: NOW - 5_000, endMs: NOW });
    });

    it("clamps both ends at once", () => {
      const state = reducer(
        { window: { kind: "live" }, durationMs: 600_000 },
        zoomTo({ ...base, startMs: NOW - RETENTION_MS * 2, endMs: NOW + 1_000 }),
      );

      expect(state.window).toEqual({
        kind: "pinned",
        startMs: NOW - RETENTION_MS,
        endMs: NOW,
      });
    });
  });

  describe("rejecting nonsense", () => {
    it("ignores an inverted range", () => {
      const before: ViewState = { window: { kind: "live" }, durationMs: 30_000 };
      expect(reducer(before, zoomTo({ ...base, startMs: NOW, endMs: NOW - 5_000 }))).toEqual(before);
    });

    it("ignores a zero-width range", () => {
      const before: ViewState = { window: { kind: "live" }, durationMs: 30_000 };
      expect(reducer(before, zoomTo({ ...base, startMs: NOW, endMs: NOW }))).toEqual(before);
    });

    it("ignores a range that lies entirely beyond retention", () => {
      // Clamping would collapse this to zero width, so it must be rejected
      // rather than stored as an empty window.
      const before: ViewState = { window: { kind: "live" }, durationMs: 30_000 };
      const far = NOW - RETENTION_MS * 3;

      expect(reducer(before, zoomTo({ ...base, startMs: far, endMs: far + 1_000 }))).toEqual(before);
    });

    it("ignores non-finite values", () => {
      const before: ViewState = { window: { kind: "live" }, durationMs: 30_000 };
      expect(reducer(before, zoomTo({ ...base, startMs: NaN, endMs: NOW }))).toEqual(before);
    });
  });
});

// SPEC.md: Redux holds UI state only, never raw samples. This is the assertion
// that keeps that true as the slice grows.
describe("the store holds no telemetry", () => {
  it("contains only a window descriptor and a duration", () => {
    const states: ViewState[] = [
      initialViewState,
      reducer(initialViewState, pause({ nowMs: NOW })),
      reducer(initialViewState, setWindowSize(5_000)),
      reducer(
        initialViewState,
        zoomTo({ nowMs: NOW, retentionMs: RETENTION_MS, startMs: NOW - 5_000, endMs: NOW }),
      ),
    ];

    for (const state of states) {
      expect(Object.keys(state).sort()).toEqual(["durationMs", "window"]);
      expect(typeof state.durationMs).toBe("number");

      // No arrays anywhere: samples would have to arrive as one.
      for (const value of Object.values(state)) {
        expect(Array.isArray(value)).toBe(false);
      }
      for (const value of Object.values(state.window)) {
        expect(["string", "number"]).toContain(typeof value);
      }
    }
  });
});

// --- Relative gestures ----------------------------------------------------
//
// The first cut of zoom read ECharts' dataZoom percentages and used them as the
// window. That created a feedback loop: the chart reports a fraction of the data
// it currently holds, and applying the resulting window replaced that data with
// exactly the range selected. Zoom-out could then never exceed 100% of an
// ever-narrowing window, so it silently behaved like zoom-in.
//
// Gestures are therefore expressed relative to the window we already own.

describe("zoomBy", () => {
  const base = { nowMs: NOW, retentionMs: RETENTION_MS, anchorFraction: 0.5 };

  it("narrows the window when the factor is below 1", () => {
    const before = pinned(NOW - 20_000, NOW - 10_000);
    const state = reducer(before, zoomBy({ ...base, factor: 0.5 }));

    const w = state.window as { startMs: number; endMs: number };
    expect(w.endMs - w.startMs).toBe(5_000);
  });

  // The regression: this must actually widen.
  it("widens the window when the factor is above 1", () => {
    const before = pinned(NOW - 20_000, NOW - 10_000);
    const state = reducer(before, zoomBy({ ...base, factor: 2 }));

    const w = state.window as { startMs: number; endMs: number };
    expect(w.endMs - w.startMs).toBe(20_000);
  });

  it("keeps widening across repeated zoom-outs", () => {
    let state: ViewState = pinned(NOW - 2_000, NOW - 1_000);
    const spans: number[] = [];

    for (let i = 0; i < 4; i++) {
      state = reducer(state, zoomBy({ ...base, factor: 1.5 }));
      const w = state.window as { startMs: number; endMs: number };
      spans.push(w.endMs - w.startMs);
    }

    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!).toBeGreaterThan(spans[i - 1]!);
    }
  });

  it("holds the point under the cursor still", () => {
    const before = pinned(NOW - 20_000, NOW - 10_000);
    // Anchor a quarter of the way in: t = start + 0.25 * 10_000
    const anchorTime = NOW - 20_000 + 2_500;

    const state = reducer(before, zoomBy({ ...base, anchorFraction: 0.25, factor: 0.5 }));
    const w = state.window as { startMs: number; endMs: number };

    expect(w.startMs + 0.25 * (w.endMs - w.startMs)).toBeCloseTo(anchorTime, 6);
  });

  it("pins and pauses when zooming from live", () => {
    const state = reducer(
      { window: { kind: "live" }, durationMs: 30_000 },
      zoomBy({ ...base, factor: 0.5 }),
    );

    expect(state.window.kind).toBe("pinned");
    const w = state.window as { startMs: number; endMs: number };
    expect(w.endMs - w.startMs).toBe(15_000);
  });

  it("returns to live once zoomed out past the retained span", () => {
    const state = reducer(pinned(NOW - 400_000, NOW), zoomBy({ ...base, factor: 4 }));

    expect(state.window).toEqual({ kind: "live" });
    expect(state.durationMs).toBe(RETENTION_MS);
  });

  it("refuses to zoom in below a floor, so the window never collapses", () => {
    let state: ViewState = pinned(NOW - 1_000, NOW);
    for (let i = 0; i < 20; i++) state = reducer(state, zoomBy({ ...base, factor: 0.5 }));

    const w = state.window as { startMs: number; endMs: number };
    expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it("ignores a non-positive or non-finite factor", () => {
    const before = pinned(NOW - 20_000, NOW - 10_000);
    for (const factor of [0, -1, NaN, Infinity]) {
      expect(reducer(before, zoomBy({ ...base, factor }))).toEqual(before);
    }
  });
});

describe("panBy", () => {
  const base = { nowMs: NOW, retentionMs: RETENTION_MS };

  it("shifts the window forward by a fraction of its span", () => {
    const state = reducer(pinned(NOW - 30_000, NOW - 20_000), panBy({ ...base, fraction: 0.5 }));

    expect(state.window).toEqual({
      kind: "pinned",
      startMs: NOW - 25_000,
      endMs: NOW - 15_000,
    });
  });

  it("shifts backwards for a negative fraction", () => {
    const state = reducer(pinned(NOW - 30_000, NOW - 20_000), panBy({ ...base, fraction: -0.5 }));

    expect(state.window).toEqual({
      kind: "pinned",
      startMs: NOW - 35_000,
      endMs: NOW - 25_000,
    });
  });

  it("preserves the span when clamped at the live edge", () => {
    const state = reducer(pinned(NOW - 10_000, NOW), panBy({ ...base, fraction: 5 }));

    const w = state.window as { startMs: number; endMs: number };
    expect(w.endMs).toBe(NOW);
    expect(w.endMs - w.startMs).toBe(10_000);
  });

  it("preserves the span when clamped at the retention edge", () => {
    const state = reducer(
      pinned(NOW - RETENTION_MS + 5_000, NOW - RETENTION_MS + 15_000),
      panBy({ ...base, fraction: -50 }),
    );

    const w = state.window as { startMs: number; endMs: number };
    expect(w.startMs).toBe(NOW - RETENTION_MS);
    expect(w.endMs - w.startMs).toBe(10_000);
  });

  it("pins and pauses when panning from live", () => {
    const state = reducer(
      { window: { kind: "live" }, durationMs: 30_000 },
      panBy({ ...base, fraction: -0.25 }),
    );

    expect(state.window.kind).toBe("pinned");
  });

  it("ignores a non-finite fraction", () => {
    const before = pinned(NOW - 30_000, NOW - 20_000);
    expect(reducer(before, panBy({ ...base, fraction: NaN }))).toEqual(before);
  });
});

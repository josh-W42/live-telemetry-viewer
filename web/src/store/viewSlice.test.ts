import { describe, expect, it } from "vitest";

import reducer, {
  initialViewState,
  jumpToLive,
  pause,
  RETENTION_MS,
  setWindowSize,
  WINDOW_SIZES,
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

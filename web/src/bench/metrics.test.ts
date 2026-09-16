import { describe, expect, it } from "vitest";

import {
  defaultStopConfig,
  evaluateStop,
  fpsFromFrameTimes,
  readHeapMB,
  type Sample,
  type StopConfig,
} from "./metrics";

// A sample with sensible defaults, so each test states only what it cares about.
function sampleAt(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    fps: 60,
    heapMB: 100,
    longTasks: 0,
    maxLongTaskMs: 0,
    pointsHeld: 0,
    pointsRendered: 0,
    batches: 0,
    gaps: 0,
    visible: true,
    pushMsTotal: 0,
    maxPushMs: 0,
    ...over,
  };
}

// Frame timestamps for `count` frames at a steady rate, starting at `start`.
function framesAt(fps: number, count: number, start = 0): number[] {
  const step = 1000 / fps;
  return Array.from({ length: count }, (_, i) => start + i * step);
}

describe("fpsFromFrameTimes", () => {
  it("measures a steady 60fps", () => {
    expect(fpsFromFrameTimes(framesAt(60, 61))).toBeCloseTo(60, 1);
  });

  it("measures a steady 10fps", () => {
    expect(fpsFromFrameTimes(framesAt(10, 11))).toBeCloseTo(10, 1);
  });

  it("reports the average across a mid-run collapse", () => {
    // Half a second at 60fps, then half a second at 4fps.
    const fast = framesAt(60, 30, 0);
    const slow = framesAt(4, 2, 500);
    const fps = fpsFromFrameTimes([...fast, ...slow]);

    expect(fps).toBeGreaterThan(4);
    expect(fps).toBeLessThan(60);
  });

  it("returns 0 when there are too few frames to measure an interval", () => {
    expect(fpsFromFrameTimes([])).toBe(0);
    expect(fpsFromFrameTimes([16.7])).toBe(0);
  });

  it("returns 0 rather than Infinity when timestamps do not advance", () => {
    expect(fpsFromFrameTimes([100, 100, 100])).toBe(0);
  });
});

describe("readHeapMB", () => {
  it("converts bytes to megabytes", () => {
    expect(readHeapMB({ memory: { usedJSHeapSize: 52_428_800 } })).toBeCloseTo(50, 5);
  });

  it("returns null outside Chromium, where performance.memory does not exist", () => {
    expect(readHeapMB({})).toBeNull();
  });

  it("returns null rather than throwing when the accessor misbehaves", () => {
    const hostile = {
      get memory(): never {
        throw new Error("blocked");
      },
    };
    expect(readHeapMB(hostile)).toBeNull();
  });
});

describe("evaluateStop", () => {
  const cfg: StopConfig = { ...defaultStopConfig, durationMs: 10_000 };

  it("keeps running on a healthy series", () => {
    const samples = [sampleAt(1000), sampleAt(2000), sampleAt(3000)];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: false, status: "running" });
  });

  it("completes, not fails, once the duration elapses", () => {
    const samples = [sampleAt(9000), sampleAt(10_000)];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: true, status: "completed" });
  });

  it("fails when a single long task exceeds the threshold", () => {
    const samples = [sampleAt(1000), sampleAt(2000, { maxLongTaskMs: 2500, longTasks: 1 })];

    const out = evaluateStop(samples, cfg);
    expect(out).toMatchObject({ stop: true, status: "failed" });
    expect(out.reason).toMatch(/long task/i);
  });

  it("ignores a single fps dip", () => {
    const samples = [sampleAt(1000), sampleAt(2000, { fps: 4 }), sampleAt(3000)];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: false, status: "running" });
  });

  it("ignores two consecutive fps dips", () => {
    const samples = [sampleAt(1000, { fps: 4 }), sampleAt(2000, { fps: 4 })];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: false, status: "running" });
  });

  it("fails after three consecutive samples below the fps floor", () => {
    const samples = [
      sampleAt(1000, { fps: 4 }),
      sampleAt(2000, { fps: 4 }),
      sampleAt(3000, { fps: 4 }),
    ];

    const out = evaluateStop(samples, cfg);
    expect(out).toMatchObject({ stop: true, status: "failed" });
    expect(out.reason).toMatch(/fps/i);
  });

  it("requires the low-fps samples to be consecutive", () => {
    const samples = [
      sampleAt(1000, { fps: 4 }),
      sampleAt(2000, { fps: 4 }),
      sampleAt(3000, { fps: 60 }),
      sampleAt(4000, { fps: 4 }),
    ];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: false, status: "running" });
  });

  it("does nothing with no samples yet", () => {
    expect(evaluateStop([], cfg)).toMatchObject({ stop: false, status: "running" });
  });

  it("reports a long task even when it arrives on the same sample as the duration", () => {
    // A failure is more informative than "it finished", so it wins the tie.
    const samples = [sampleAt(10_000, { maxLongTaskMs: 3000, longTasks: 1 })];
    expect(evaluateStop(samples, cfg)).toMatchObject({ stop: true, status: "failed" });
  });

  // A hidden tab does not run requestAnimationFrame at all, so fps reads as 0
  // and every run would report a spurious failure. Such a run has measured
  // nothing and must not be mistaken for a slow one.
  describe("when the tab is hidden", () => {
    it("invalidates the run rather than failing it", () => {
      const samples = [sampleAt(1000), sampleAt(2000, { visible: false, fps: 0 })];

      const out = evaluateStop(samples, cfg);
      expect(out).toMatchObject({ stop: true, status: "invalid" });
      expect(out.reason).toMatch(/hidden|visib/i);
    });

    it("takes precedence over an fps failure", () => {
      const samples = [
        sampleAt(1000, { visible: false, fps: 0 }),
        sampleAt(2000, { visible: false, fps: 0 }),
        sampleAt(3000, { visible: false, fps: 0 }),
      ];
      expect(evaluateStop(samples, cfg)).toMatchObject({ status: "invalid" });
    });

    it("invalidates even if visibility was lost earlier in the run", () => {
      const samples = [
        sampleAt(1000),
        sampleAt(2000, { visible: false, fps: 0 }),
        sampleAt(3000),
      ];
      expect(evaluateStop(samples, cfg)).toMatchObject({ stop: true, status: "invalid" });
    });
  });
});

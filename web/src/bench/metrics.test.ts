import { describe, expect, it } from "vitest";

import {
  BenchRun,
  defaultStopConfig,
  FrameMeter,
  evaluateStop,
  fpsFromFrameTimes,
  readHeapMB,
  type Sample,
  type StopConfig,
} from "./metrics";

const noCounters = {
  pointsHeld: () => 0,
  pointsRendered: () => 0,
  batches: () => 0,
  droppedBatches: () => 0,
  takePushStats: () => ({ totalMs: 0, maxMs: 0 }),
};

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
    droppedBatches: 0,
    visible: true,
    frames: 60,
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

  // An occluded window is worse than a hidden one: the Page Visibility API can
  // still report "visible" while the compositor schedules no frames at all. The
  // giveaway is zero frames alongside an idle main thread — a genuinely frozen
  // renderer also produces no frames, but it is never idle while doing it.
  describe("when the page is rendering no frames", () => {
    const occluded = { fps: 0, frames: 0, pushMsTotal: 0, maxPushMs: 0 };

    it("invalidates rather than reporting a false fps failure", () => {
      const samples = [
        sampleAt(1000, occluded),
        sampleAt(2000, occluded),
        sampleAt(3000, occluded),
      ];

      const out = evaluateStop(samples, cfg);
      expect(out).toMatchObject({ stop: true, status: "invalid" });
      expect(out.reason).toMatch(/frame/i);
    });

    it("still fails the run when no frames land but the thread is busy", () => {
      // This is a real freeze: the renderer is saturating the thread, which is
      // exactly why nothing is being painted.
      const frozen = { fps: 0, frames: 0, pushMsTotal: 990, maxPushMs: 800 };
      const samples = [
        sampleAt(1000, frozen),
        sampleAt(2000, frozen),
        sampleAt(3000, frozen),
      ];

      expect(evaluateStop(samples, cfg)).toMatchObject({ stop: true, status: "failed" });
    });

    it("tolerates a single frameless sample", () => {
      const samples = [sampleAt(1000), sampleAt(2000, occluded), sampleAt(3000)];
      expect(evaluateStop(samples, cfg)).toMatchObject({ stop: false, status: "running" });
    });
  });
});

describe("BenchRun.invalidate", () => {
  it("marks the run invalid and records the reason", () => {
    const run = new BenchRun("worker", noCounters);

    run.invalidate("tab was switched away");

    expect(run.status).toBe("invalid");
    expect(run.reason).toBe("tab was switched away");
  });

  it("notifies the listener so the app can close its streams", () => {
    let notified: BenchRun | null = null;
    const run = new BenchRun("worker", noCounters, defaultStopConfig, (r) => {
      notified = r;
    });

    run.invalidate("hidden");

    expect(notified).toBe(run);
  });

  it("does not overwrite a run that already finished", () => {
    const run = new BenchRun("naive", noCounters);
    run.stop(); // ends as "completed"

    run.invalidate("too late");

    expect(run.status).toBe("completed");
    expect(run.reason).toBeNull();
  });

  it("is safe to call twice", () => {
    const run = new BenchRun("naive", noCounters);

    run.invalidate("first");
    run.invalidate("second");

    expect(run.reason).toBe("first");
  });
});

/*
The status bar needs a frame rate whether or not a benchmark is running, and
BenchRun only measures one while a run is in progress. This is what fills the
rest of the time.

Frames are fed in directly rather than waited for: a test that depends on the
host actually painting would be slow and would fail on a machine with no
compositor at all.
*/
describe("FrameMeter", () => {
  it("reads zero before two frames have landed", () => {
    const meter = new FrameMeter();
    expect(meter.fps()).toBe(0);

    meter.record(0);
    expect(meter.fps()).toBe(0);
  });

  it("reports the rate across the frames it holds", () => {
    const meter = new FrameMeter();
    // 61 frames at 16.67ms is one second of 60fps.
    for (let i = 0; i <= 60; i++) meter.record((i * 1000) / 60);

    expect(meter.fps()).toBeCloseTo(60, 5);
  });

  // Without this the reported figure would be a lifetime average, so a page
  // that stuttered once would read slow for as long as it stayed open.
  it("forgets frames older than its window", () => {
    const meter = new FrameMeter(1000);

    // A slow second, then a fast one.
    for (let i = 0; i < 10; i++) meter.record(i * 100);
    for (let i = 0; i <= 60; i++) meter.record(1000 + (i * 1000) / 60);

    expect(meter.fps()).toBeCloseTo(60, 0);
  });

  it("reports zero again once stopped", () => {
    const meter = new FrameMeter();
    for (let i = 0; i <= 60; i++) meter.record((i * 1000) / 60);

    meter.stop();

    expect(meter.fps()).toBe(0);
  });
});

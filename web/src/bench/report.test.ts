import { describe, expect, it } from "vitest";

import type { RunResult, Sample } from "./metrics";
import { percentile, summarize } from "./report";

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

function runOf(samples: Sample[], over: Partial<RunResult> = {}): RunResult {
  return {
    mode: "naive",
    status: "completed",
    reason: null,
    startedAt: 0,
    endedAt: samples.at(-1)?.t ?? 0,
    samples,
    ...over,
  };
}

describe("percentile", () => {
  it("returns the median of an odd-length series", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("returns the lower-middle value of an even-length series", () => {
    // Nearest-rank, so no interpolation between 2 and 3.
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("sorts before selecting", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
  });

  it("returns the maximum at p100 and the minimum at p0", () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it("handles a single sample", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("returns 0 for an empty series rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes p95 over a hundred values", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });
});

describe("summarize", () => {
  it("reports fps percentiles and the minimum", () => {
    const run = runOf([
      sampleAt(1000, { fps: 60 }),
      sampleAt(2000, { fps: 30 }),
      sampleAt(3000, { fps: 12 }),
    ]);

    const s = summarize(run);
    expect(s.fps.min).toBe(12);
    expect(s.fps.p50).toBe(30);
  });

  it("tracks heap start, peak and end", () => {
    const run = runOf([
      sampleAt(1000, { heapMB: 50 }),
      sampleAt(2000, { heapMB: 400 }),
      sampleAt(3000, { heapMB: 380 }),
    ]);

    expect(summarize(run).heapMB).toEqual({ start: 50, peak: 400, end: 380 });
  });

  it("returns a null heap summary when no sample carried a reading", () => {
    const run = runOf([sampleAt(1000, { heapMB: null }), sampleAt(2000, { heapMB: null })]);
    expect(summarize(run).heapMB).toBeNull();
  });

  it("ignores null heap readings mixed into a real series", () => {
    const run = runOf([
      sampleAt(1000, { heapMB: null }),
      sampleAt(2000, { heapMB: 200 }),
      sampleAt(3000, { heapMB: 300 }),
    ]);

    expect(summarize(run).heapMB).toEqual({ start: 200, peak: 300, end: 300 });
  });

  it("reports time-to-break as the first failing sample", () => {
    const run = runOf(
      [sampleAt(1000), sampleAt(2000, { fps: 4 }), sampleAt(3000, { fps: 4 })],
      { status: "failed", reason: "fps below floor" },
    );

    expect(summarize(run).timeToBreakMs).toBe(2000);
  });

  it("reports no time-to-break on a clean run", () => {
    expect(summarize(runOf([sampleAt(1000), sampleAt(2000)])).timeToBreakMs).toBeNull();
  });

  it("carries the peak point counts and long-task totals", () => {
    const run = runOf([
      sampleAt(1000, { pointsHeld: 1000, pointsRendered: 500, longTasks: 1, maxLongTaskMs: 80 }),
      sampleAt(2000, { pointsHeld: 9000, pointsRendered: 900, longTasks: 4, maxLongTaskMs: 2400 }),
    ]);

    const s = summarize(run);
    expect(s.points).toEqual({ held: 9000, rendered: 900 });
    expect(s.longTasks).toEqual({ count: 4, maxMs: 2400 });
  });

  it("survives an empty run without throwing", () => {
    const s = summarize(runOf([]));
    expect(s.fps).toEqual({ p50: 0, p95: 0, min: 0 });
    expect(s.heapMB).toBeNull();
    expect(s.timeToBreakMs).toBeNull();
  });

  it("reports the share of each second spent inside push", () => {
    // 900ms of every 1000ms sample window spent re-rendering.
    const run = runOf([
      sampleAt(1000, { pushMsTotal: 200, maxPushMs: 20 }),
      sampleAt(2000, { pushMsTotal: 900, maxPushMs: 140 }),
    ]);

    const s = summarize(run);
    expect(s.push.peakMsPerSec).toBe(900);
    expect(s.push.maxSingleMs).toBe(140);
    expect(s.push.peakBusyPercent).toBe(90);
  });

  it("flags a run that lost visibility so its numbers are not quoted", () => {
    const run = runOf([sampleAt(1000), sampleAt(2000, { visible: false })], {
      status: "invalid",
      reason: "page was hidden",
    });

    expect(summarize(run).visibilityLost).toBe(true);
  });

  it("does not flag a fully visible run", () => {
    expect(summarize(runOf([sampleAt(1000), sampleAt(2000)])).visibilityLost).toBe(false);
  });
});

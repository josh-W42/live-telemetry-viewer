import { describe, expect, it } from "vitest";

import { lttb } from "./lttb";

/**
 * A mostly-smooth series with one narrow spike.
 *
 * The spike sits at an index that simple every-Nth decimation will step over,
 * which is the whole point of the comparison below.
 */
function seriesWithSpike(length: number, spikeIndex: number, spikeValue: number) {
  const timestamps = new Float64Array(length);
  const values = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    timestamps[i] = i * 1e6; // 1ms apart, in nanoseconds
    values[i] = Math.sin(i / 200) * 2;
  }
  values[spikeIndex] = spikeValue;
  return { timestamps, values };
}

function ramp(length: number) {
  const timestamps = new Float64Array(length);
  const values = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    timestamps[i] = i * 1e6;
    values[i] = i;
  }
  return { timestamps, values };
}

describe("lttb", () => {
  describe("output size", () => {
    it("returns exactly `threshold` points when downsampling", () => {
      const { timestamps, values } = ramp(10_000);

      for (const threshold of [3, 10, 100, 2000]) {
        const out = lttb(timestamps, values, threshold);
        expect(out.timestamps).toHaveLength(threshold);
        expect(out.values).toHaveLength(threshold);
      }
    });

    it("returns the input unchanged when the threshold meets or exceeds the length", () => {
      const { timestamps, values } = ramp(50);

      for (const threshold of [50, 51, 1000]) {
        const out = lttb(timestamps, values, threshold);
        expect(Array.from(out.values)).toEqual(Array.from(values));
        expect(Array.from(out.timestamps)).toEqual(Array.from(timestamps));
      }
    });
  });

  describe("endpoints", () => {
    // ECharts joins the downsampled points with straight lines, so if the
    // first or last point moved, the trace would visibly detach from the edge
    // of the window on every redraw.
    it("always preserves the first and last point", () => {
      const { timestamps, values } = seriesWithSpike(5000, 1234, 99);
      const out = lttb(timestamps, values, 250);

      expect(out.timestamps[0]).toBe(timestamps[0]);
      expect(out.values[0]).toBe(values[0]);
      expect(out.timestamps[out.timestamps.length - 1]).toBe(timestamps[timestamps.length - 1]);
      expect(out.values[out.values.length - 1]).toBe(values[values.length - 1]);
    });

    it("keeps timestamps monotonically increasing", () => {
      const { timestamps, values } = seriesWithSpike(8000, 4321, 50);
      const out = lttb(timestamps, values, 300);

      for (let i = 1; i < out.timestamps.length; i++) {
        expect(out.timestamps[i]!).toBeGreaterThan(out.timestamps[i - 1]!);
      }
    });
  });

  describe("spike preservation", () => {
    // This is the reason LTTB is worth writing rather than taking every Nth
    // point. An anomaly is exactly the kind of narrow feature that decimation
    // drops, and dropping it would make the M5 rules engine look broken.
    it("keeps a narrow spike that every-Nth decimation would miss", () => {
      const length = 10_000;
      const threshold = 200;
      const spikeIndex = 5013; // deliberately not a multiple of the stride
      const spikeValue = 100;

      const { timestamps, values } = seriesWithSpike(length, spikeIndex, spikeValue);

      const out = lttb(timestamps, values, threshold);
      expect(Math.max(...out.values)).toBe(spikeValue);

      // And the contrast: naive decimation at the same budget steps over it.
      const stride = Math.floor(length / threshold);
      let decimatedMax = -Infinity;
      for (let i = 0; i < length; i += stride) decimatedMax = Math.max(decimatedMax, values[i]!);
      expect(decimatedMax).toBeLessThan(spikeValue);
    });

    it("keeps a negative spike too", () => {
      const { timestamps, values } = seriesWithSpike(10_000, 3007, -100);
      const out = lttb(timestamps, values, 200);

      expect(Math.min(...out.values)).toBe(-100);
    });
  });

  describe("degenerate inputs", () => {
    it("handles empty input", () => {
      const out = lttb(new Float64Array(0), new Float64Array(0), 100);
      expect(out.timestamps).toHaveLength(0);
      expect(out.values).toHaveLength(0);
    });

    it("handles a single point", () => {
      const out = lttb(new Float64Array([5e6]), new Float64Array([42]), 100);
      expect(Array.from(out.timestamps)).toEqual([5e6]);
      expect(Array.from(out.values)).toEqual([42]);
    });

    it("handles two points", () => {
      const out = lttb(new Float64Array([0, 1e6]), new Float64Array([1, 2]), 100);
      expect(Array.from(out.values)).toEqual([1, 2]);
    });

    // LTTB's bucketing needs at least one interior bucket, so anything below 3
    // cannot be expressed. Collapsing to the endpoints is well defined and
    // keeps the chart's edges anchored.
    it("collapses to the endpoints when the threshold is below 3", () => {
      const { timestamps, values } = ramp(1000);

      for (const threshold of [0, 1, 2]) {
        const out = lttb(timestamps, values, threshold);
        expect(Array.from(out.values)).toEqual([values[0], values[999]]);
      }
    });

    it("rejects mismatched input lengths rather than reading past the end", () => {
      expect(() => lttb(new Float64Array(10), new Float64Array(9), 5)).toThrow();
    });
  });

  describe("purity", () => {
    it("does not modify its inputs", () => {
      const { timestamps, values } = seriesWithSpike(2000, 999, 77);
      const tsCopy = Float64Array.from(timestamps);
      const vCopy = Float64Array.from(values);

      lttb(timestamps, values, 100);

      expect(Array.from(timestamps)).toEqual(Array.from(tsCopy));
      expect(Array.from(values)).toEqual(Array.from(vCopy));
    });

    it("returns arrays that do not alias the input", () => {
      const { timestamps, values } = ramp(500);
      const out = lttb(timestamps, values, 500); // the pass-through path

      out.values[0] = -12345;
      expect(values[0]).toBe(0);
    });
  });
});

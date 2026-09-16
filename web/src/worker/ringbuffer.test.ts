import { describe, expect, it } from "vitest";

import { RingBuffer } from "./ringbuffer";

const BASE = 1_700_000_000_000_000_000n; // a realistic epoch-nanosecond base

/** Push `count` samples spaced 1ms apart, starting `startMs` after the base. */
function fill(buf: RingBuffer, count: number, startMs = 0, valueAt = (i: number) => i) {
  const timestamps = new Array<bigint>(count);
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    timestamps[i] = BASE + BigInt((startMs + i) * 1_000_000);
    values[i] = valueAt(startMs + i);
  }
  buf.push(timestamps, values);
}

/** Absolute nanosecond timestamp for the sample `ms` milliseconds after base. */
function atMs(ms: number): bigint {
  return BASE + BigInt(ms * 1_000_000);
}

describe("RingBuffer", () => {
  describe("capacity", () => {
    it("reports its configured capacity and starts empty", () => {
      const buf = new RingBuffer(1000, BASE);
      expect(buf.capacity).toBe(1000);
      expect(buf.length).toBe(0);
    });

    it("grows up to capacity", () => {
      const buf = new RingBuffer(1000, BASE);
      fill(buf, 400);
      expect(buf.length).toBe(400);
    });

    it("never exceeds capacity however much is pushed", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 10_000);
      expect(buf.length).toBe(100);
    });

    // The whole point of the structure: memory is fixed at construction, so a
    // run of any length occupies the same bytes.
    it("allocates once and never reallocates", () => {
      const buf = new RingBuffer(1000, BASE);
      const bytesBefore = buf.byteLength;

      fill(buf, 50_000);

      expect(buf.byteLength).toBe(bytesBefore);
      expect(bytesBefore).toBe(1000 * 8 * 2); // two Float64Arrays
    });
  });

  describe("eviction", () => {
    it("discards the oldest samples, keeping the newest", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 250); // values 0..249, only the last 100 should survive

      const out = buf.sliceByTime(atMs(0), atMs(1000));
      expect(out.values).toHaveLength(100);
      expect(out.values[0]).toBe(150);
      expect(out.values[99]).toBe(249);
    });

    it("keeps working across many wraps", () => {
      const buf = new RingBuffer(10, BASE);
      for (let round = 0; round < 20; round++) fill(buf, 10, round * 10);

      const out = buf.sliceByTime(atMs(0), atMs(1000));
      expect(out.values).toHaveLength(10);
      expect(out.values[0]).toBe(190);
      expect(out.values[9]).toBe(199);
    });
  });

  describe("sliceByTime", () => {
    it("returns exactly the samples inside the range, inclusive of both ends", () => {
      const buf = new RingBuffer(1000, BASE);
      fill(buf, 500);

      const out = buf.sliceByTime(atMs(100), atMs(199));
      expect(out.values).toHaveLength(100);
      expect(out.values[0]).toBe(100);
      expect(out.values[99]).toBe(199);
    });

    it("clamps a range that starts before the retained data", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 250); // retains ms 150..249

      const out = buf.sliceByTime(atMs(0), atMs(200));
      expect(out.values[0]).toBe(150);
      expect(out.values[out.values.length - 1]).toBe(200);
    });

    it("returns empty for a range entirely before the retained data", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 250); // retains ms 150..249

      const out = buf.sliceByTime(atMs(0), atMs(100));
      expect(out.values).toHaveLength(0);
      expect(out.timestamps).toHaveLength(0);
    });

    it("returns empty for a range entirely after the retained data", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 250);

      const out = buf.sliceByTime(atMs(5000), atMs(6000));
      expect(out.values).toHaveLength(0);
    });

    it("returns empty when nothing has been pushed", () => {
      const buf = new RingBuffer(100, BASE);
      expect(buf.sliceByTime(atMs(0), atMs(1000)).values).toHaveLength(0);
    });

    it("reads correctly across the wrap boundary", () => {
      // Capacity 100, pushed 150, so the live window straddles the physical
      // end of the array: logical 50..149 lives at physical 50..99 then 0..49.
      const buf = new RingBuffer(100, BASE);
      fill(buf, 150);

      const out = buf.sliceByTime(atMs(50), atMs(149));
      expect(out.values).toHaveLength(100);
      for (let i = 0; i < 100; i++) expect(out.values[i]).toBe(50 + i);
    });

    it("handles a single-sample range", () => {
      const buf = new RingBuffer(1000, BASE);
      fill(buf, 500);

      const out = buf.sliceByTime(atMs(250), atMs(250));
      expect(out.values).toHaveLength(1);
      expect(out.values[0]).toBe(250);
    });
  });

  describe("timestamp encoding", () => {
    // Timestamps are stored as nanosecond offsets from the base so they stay
    // exactly representable; raw epoch nanoseconds in a Float64 quantise to
    // 256ns.
    it("round-trips absolute nanosecond timestamps exactly", () => {
      const buf = new RingBuffer(1000, BASE);
      fill(buf, 10);

      const out = buf.sliceByTime(atMs(0), atMs(9));
      for (let i = 0; i < 10; i++) {
        expect(buf.toAbsoluteNs(out.timestamps[i]!)).toBe(atMs(i));
      }
    });

    it("distinguishes timestamps one nanosecond apart", () => {
      const buf = new RingBuffer(10, BASE);
      buf.push([BASE + 1n, BASE + 2n, BASE + 3n], new Float64Array([10, 20, 30]));

      const out = buf.sliceByTime(BASE + 2n, BASE + 3n);
      expect(out.values).toHaveLength(2);
      expect(buf.toAbsoluteNs(out.timestamps[0]!)).toBe(BASE + 2n);
      expect(buf.toAbsoluteNs(out.timestamps[1]!)).toBe(BASE + 3n);
    });

    it("exposes offsets, not absolute values, in the slice", () => {
      const buf = new RingBuffer(100, BASE);
      fill(buf, 5);

      const out = buf.sliceByTime(atMs(0), atMs(4));
      expect(out.timestamps[0]).toBe(0);
      expect(out.timestamps[1]).toBe(1_000_000);
    });
  });

  describe("input validation", () => {
    it("rejects mismatched timestamp and value lengths", () => {
      const buf = new RingBuffer(100, BASE);
      expect(() => buf.push([BASE, BASE + 1n], new Float64Array([1]))).toThrow();
    });

    it("accepts an empty push", () => {
      const buf = new RingBuffer(100, BASE);
      buf.push([], new Float64Array(0));
      expect(buf.length).toBe(0);
    });
  });
});

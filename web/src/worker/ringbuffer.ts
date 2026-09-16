/**
 * A fixed-capacity circular buffer for one channel's samples.
 *
 * Two packed Float64Arrays, allocated once. At 1kHz with a ten-minute window
 * that is 600,000 samples, 9.2 MB per channel and 36.6 MB for four - and it
 * stays there however long the app runs. M2's naive renderer used 211 MB to
 * hold 85,600 points, because every point was a two-element JS array with its
 * own heap object and header. Packing the same data into typed arrays is where
 * most of that difference comes from.
 *
 * Timestamps are stored as nanosecond *offsets* from a base. Absolute epoch
 * nanoseconds are around 1.7e18, past Number.MAX_SAFE_INTEGER, so a Float64
 * quantises them to 256ns steps. A ten-minute offset is 6e11, comfortably
 * exact.
 */
export interface Slice {
  /** Nanosecond offsets from the buffer's base. */
  timestamps: Float64Array;
  values: Float64Array;
}

export class RingBuffer {
  private readonly ts: Float64Array;
  private readonly vals: Float64Array;

  /**
   * Total samples ever written. Logical index i lives at physical
   * i % capacity, and the live window is [total - capacity, total).
   * Monotonic, so binary search over logical indices just works.
   */
  private total = 0;

  constructor(
    readonly capacity: number,
    readonly baseNs: bigint,
  ) {
    if (capacity < 1) throw new RangeError(`capacity must be positive, got ${capacity}`);
    this.ts = new Float64Array(capacity);
    this.vals = new Float64Array(capacity);
  }

  /** Samples currently retained. */
  get length(): number {
    return Math.min(this.total, this.capacity);
  }

  /** Bytes occupied by the sample arrays. Constant for the buffer's lifetime. */
  get byteLength(): number {
    return this.ts.byteLength + this.vals.byteLength;
  }

  /** Convert a stored offset back to an absolute nanosecond timestamp. */
  toAbsoluteNs(offsetNs: number): bigint {
    return this.baseNs + BigInt(Math.round(offsetNs));
  }

  /** Append samples, overwriting the oldest once full. */
  push(timestampsNs: readonly bigint[], values: Float64Array | readonly number[]): void {
    if (timestampsNs.length !== values.length) {
      throw new RangeError(
        `timestamps (${timestampsNs.length}) and values (${values.length}) must be the same length`,
      );
    }

    for (let i = 0; i < timestampsNs.length; i++) {
      const at = this.total % this.capacity;
      this.ts[at] = Number(timestampsNs[i]! - this.baseNs);
      this.vals[at] = values[i]!;
      this.total += 1;
    }
  }

  /** The oldest logical index still retained. */
  private get firstLogical(): number {
    return Math.max(0, this.total - this.capacity);
  }

  private offsetAt(logical: number): number {
    return this.ts[logical % this.capacity]!;
  }

  /**
   * First logical index whose timestamp is >= target, or `total` if none is.
   *
   * Plain binary search: timestamps increase monotonically, so the logical
   * ordering is sorted even though the physical layout wraps.
   */
  private lowerBound(targetOffset: number): number {
    let lo = this.firstLogical;
    let hi = this.total;

    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      if (this.offsetAt(mid) < targetOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Samples whose timestamps fall within [startNs, endNs], both inclusive.
   *
   * Returns freshly allocated arrays rather than views: the caller transfers
   * them to the main thread, and a transfer neuters the underlying buffer,
   * which would destroy the ring buffer if it shared storage.
   */
  sliceByTime(startNs: bigint, endNs: bigint): Slice {
    const startOffset = Number(startNs - this.baseNs);
    const endOffset = Number(endNs - this.baseNs);

    if (this.total === 0 || endOffset < startOffset) return empty();

    const from = this.lowerBound(startOffset);
    // One past the last sample <= endOffset.
    const to = this.lowerBound(endOffset + 1);

    const count = to - from;
    if (count <= 0) return empty();

    const timestamps = new Float64Array(count);
    const values = new Float64Array(count);

    // Copy in at most two runs: from `from` to the physical end of the array,
    // then the wrapped remainder.
    let written = 0;
    let logical = from;
    while (written < count) {
      const physical = logical % this.capacity;
      const run = Math.min(count - written, this.capacity - physical);

      timestamps.set(this.ts.subarray(physical, physical + run), written);
      values.set(this.vals.subarray(physical, physical + run), written);

      written += run;
      logical += run;
    }

    return { timestamps, values };
  }
}

function empty(): Slice {
  return { timestamps: new Float64Array(0), values: new Float64Array(0) };
}

/**
 * Largest Triangle Three Buckets downsampling.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS JOSH'S TO IMPLEMENT. Only the signature and contract are here.
 * The behaviour is fully specified by `lttb.test.ts` — run `npx vitest run
 * src/lib` and make it green.
 * ---------------------------------------------------------------------------
 *
 * Why this exists rather than taking every Nth point: decimation drops narrow
 * features, and a narrow feature is exactly what an anomaly looks like. LTTB
 * splits the series into `threshold - 2` buckets and picks, from each, the
 * point forming the largest triangle with the previously chosen point and the
 * mean of the next bucket. Outliers win that contest, so spikes survive.
 *
 * The sketch:
 *   1. Keep the first point.
 *   2. For each bucket, compute the average x and y of the *next* bucket.
 *   3. Choose the point in this bucket maximising the triangle area formed by
 *      (previously chosen point, candidate, next-bucket average).
 *   4. Keep the last point.
 *
 * Triangle area for points a, b, c is
 *   abs((a.x - c.x) * (b.y - a.y) - (a.x - b.x) * (c.y - a.y)) / 2
 * and the halving can be skipped since only the comparison matters.
 *
 * Contract, as pinned by the tests:
 * - `threshold >= timestamps.length` returns a copy of the input. The result
 *   must never alias the input arrays.
 * - `threshold < 3` on an input longer than 2 returns just the first and last
 *   points; LTTB's bucketing cannot express fewer than three.
 * - Otherwise the output is exactly `threshold` points, with the first and last
 *   input points preserved and timestamps still increasing.
 * - Inputs are never modified.
 * - Mismatched input lengths throw.
 *
 * @param timestamps Sample times. Nanosecond offsets from the ring buffer's
 *                   base, so the values stay well inside the exactly
 *                   representable integer range.
 * @param values     Sample values, one per timestamp.
 * @param threshold  Maximum points to return. The worker passes roughly twice
 *                   the chart's pixel width.
 */
export interface Downsampled {
  timestamps: Float64Array;
  values: Float64Array;
}

export function lttb(
  timestamps: Float64Array,
  values: Float64Array,
  threshold: number,
): Downsampled {
  void timestamps;
  void values;
  void threshold;
  throw new Error(
    "lttb is not implemented yet — see src/lib/lttb.test.ts for the contract",
  );
}

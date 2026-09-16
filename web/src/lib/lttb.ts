/**
 * Largest Triangle Three Buckets downsampling.
 *
 * Why this exists rather than taking every Nth point: decimation drops narrow
 * features, and a narrow feature is exactly what an anomaly looks like. LTTB
 * splits the series into `threshold - 2` buckets and picks, from each, the
 * point forming the largest triangle with the previously chosen point and the
 * mean of the next bucket. Outliers win that contest, so spikes survive.
 *
 * Contract, as pinned by lttb.test.ts:
 * - `threshold >= length`, or a length of 2 or less, returns a copy of the
 *   input. The result never aliases the input arrays.
 * - `threshold < 3` on a longer input returns just the first and last points;
 *   LTTB's bucketing cannot express fewer than three.
 * - Otherwise the output is exactly `threshold` points, with the first and last
 *   input points preserved and timestamps still increasing.
 * - Inputs are never modified. Mismatched input lengths throw.
 *
 * @param timestamps Sample times, as nanosecond offsets from the ring buffer's
 *                   base, which keeps them exactly representable.
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
  if (timestamps.length !== values.length) {
    throw new RangeError(
      `timestamps (${timestamps.length}) and values (${values.length}) must be the same length`,
    );
  }

  const length = timestamps.length;

  // Nothing to reduce: too short to have an interior, or the budget already
  // covers every point. `.slice()` copies, so the result never aliases the
  // caller's arrays - the worker transfers these buffers, and a transfer
  // neuters whatever it hands over.
  if (length <= 2 || threshold >= length) {
    return { timestamps: timestamps.slice(), values: values.slice() };
  }

  // Below three there is no room for an interior bucket, so the endpoints are
  // all that can be expressed. Keeping them anchors the chart's edges.
  if (threshold < 3) {
    return {
      timestamps: Float64Array.of(timestamps[0]!, timestamps[length - 1]!),
      values: Float64Array.of(values[0]!, values[length - 1]!),
    };
  }

  const outTimestamps = new Float64Array(threshold);
  const outValues = new Float64Array(threshold);

  // The first and last points are never up for selection. Pinning them is what
  // stops the trace detaching from the edges of the window as it redraws.
  outTimestamps[0] = timestamps[0]!;
  outValues[0] = values[0]!;
  outTimestamps[threshold - 1] = timestamps[length - 1]!;
  outValues[threshold - 1] = values[length - 1]!;

  // The interior (everything but those two endpoints) is divided into
  // `threshold - 2` buckets, one output point each. Fractional so buckets stay
  // evenly sized across the series instead of the remainder piling up at the
  // end; the floor happens at each boundary.
  const bucketSize = (length - 2) / (threshold - 2);

  // Index of the point chosen in the previous bucket: vertex A of the triangle.
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    // --- Vertex C: the average of the NEXT bucket ------------------------
    //
    // A real point from the next bucket would make the choice depend on a
    // selection not yet made. The average is a stable stand-in, and it is what
    // makes the algorithm look one bucket ahead rather than purely backwards.
    const nextStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, length);

    let avgTimestamp = 0;
    let avgValue = 0;
    const nextCount = nextEnd - nextStart;

    if (nextCount > 0) {
      for (let j = nextStart; j < nextEnd; j++) {
        avgTimestamp += timestamps[j]!;
        avgValue += values[j]!;
      }
      avgTimestamp /= nextCount;
      avgValue /= nextCount;
    } else {
      // Only reachable on the final bucket, where the "next bucket" is the last
      // point itself.
      avgTimestamp = timestamps[length - 1]!;
      avgValue = values[length - 1]!;
    }

    // --- Vertex B: every candidate in THIS bucket -------------------------
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, length - 1);

    const aTimestamp = timestamps[a]!;
    const aValue = values[a]!;

    let maxArea = -1;
    let chosen = rangeStart;

    for (let j = rangeStart; j < rangeEnd; j++) {
      // Twice the area of triangle (A, B, C) via the cross product. The factor
      // of two is left in: only the comparison matters, so halving every
      // candidate would change nothing.
      const area = Math.abs(
        (aTimestamp - avgTimestamp) * (values[j]! - aValue) -
          (aTimestamp - timestamps[j]!) * (avgValue - aValue),
      );

      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }

    outTimestamps[i + 1] = timestamps[chosen]!;
    outValues[i + 1] = values[chosen]!;

    // The winner becomes vertex A for the next bucket, so the chain of chosen
    // points is what the next triangle is measured against.
    a = chosen;
  }

  return { timestamps: outTimestamps, values: outValues };
}

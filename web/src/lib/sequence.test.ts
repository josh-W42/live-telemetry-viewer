import { describe, expect, it } from "vitest";

import { droppedSince } from "./sequence";

describe("droppedSince", () => {
  it("counts nothing for consecutive batches", () => {
    expect(droppedSince(10n, 11n)).toBe(0);
  });

  /*
  The reason this function exists. The client used to increment a counter once
  per discontinuity, so a subscriber that fell far enough behind for the
  broadcaster to drop four hundred of its queued batches was reported as having
  lost one. "Dropped batches" has to mean batches.
  */
  it("counts every missing batch, not the fact that some went missing", () => {
    expect(droppedSince(10n, 15n)).toBe(4);
    expect(droppedSince(1n, 401n)).toBe(399);
  });

  // The first batch establishes the baseline; there is nothing before it to be
  // late relative to.
  it("counts nothing before the first batch arrives", () => {
    expect(droppedSince(0n, 1n)).toBe(0);
    expect(droppedSince(0n, 5_000n)).toBe(0);
  });

  // A restarted server begins its sequence again. That is a new stream, not a
  // loss of everything in between.
  it("counts nothing when the sequence goes backwards", () => {
    expect(droppedSince(500n, 1n)).toBe(0);
    expect(droppedSince(500n, 500n)).toBe(0);
  });

  // Sequence is uint64 on the wire, so the arithmetic stays in BigInt until the
  // difference is known to be small.
  it("handles sequence numbers past Number.MAX_SAFE_INTEGER", () => {
    const huge = 2n ** 60n;
    expect(droppedSince(huge, huge + 3n)).toBe(2);
  });
});

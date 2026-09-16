/**
 * How many batches went missing between two sequence numbers.
 *
 * The broadcaster drops a slow subscriber's **oldest queued batch** rather than
 * blocking the simulator, so a stall that swallows four hundred batches leaves a
 * gap of four hundred in the sequence. Counting stalls instead of batches would
 * report that client identically to one that lost a single batch, which is not
 * what "dropped batches" means on a status bar.
 *
 * `last` of 0 means nothing has arrived yet: the first batch establishes the
 * baseline and can no more be "late" than it can be early.
 */
export function droppedSince(last: bigint, next: bigint): number {
  if (last === 0n) return 0;

  const missing = next - last - 1n;
  // A sequence that goes backwards means a restarted stream, not a loss.
  return missing > 0n ? Number(missing) : 0;
}

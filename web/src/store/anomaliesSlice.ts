import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { Anomaly } from "../worker/rules";

/**
 * Anomalies detected by the worker.
 *
 * These are metadata, not telemetry: six scalar fields per entry, at most a
 * handful at a time, pruned to the ring buffer's ten minutes. That is why they
 * belong in the store when samples emphatically do not.
 *
 * The worker sends the whole list rather than deltas. An anomaly that is still
 * open keeps growing, so deltas would need identity, ordering and a merge path
 * on this side — all avoidable when the list is this small. Replacing wholesale
 * is idempotent, so the store and the worker cannot drift apart.
 */
export interface AnomaliesState {
  items: Anomaly[];
}

export const initialAnomaliesState: AnomaliesState = { items: [] };

const anomaliesSlice = createSlice({
  name: "anomalies",
  initialState: initialAnomaliesState,
  reducers: {
    setAnomalies(state, action: PayloadAction<Anomaly[]>) {
      // Keeping the existing array when nothing has changed is not a
      // micro-optimisation here. The worker resends the whole list twice a
      // second whether or not anything happened, and a fresh array identity
      // propagates: the selector returns a new object, the effect watching it
      // fires, and the renderer runs a full chart.setOption to redraw bands
      // that are already correct. Anomalies are occasional, so most ticks
      // carry the same content as the last one.
      if (sameAnomalies(state.items, action.payload)) return;
      state.items = action.payload;
    },
  },
});

/**
 * Whether two lists describe the same anomalies.
 *
 * Field by field rather than by id alone, because an open anomaly keeps the
 * same id while its end and peak move — that is a change the chart has to see.
 */
function sameAnomalies(a: readonly Anomaly[], b: readonly Anomaly[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.startMs !== y.startMs ||
      x.endMs !== y.endMs ||
      x.open !== y.open ||
      x.peak !== y.peak
    ) {
      return false;
    }
  }

  return true;
}

export const { setAnomalies } = anomaliesSlice.actions;
export default anomaliesSlice.reducer;

/** Newest first, which is the order a sidebar wants to read them. */
export function selectAnomaliesNewestFirst(state: AnomaliesState): Anomaly[] {
  return [...state.items].sort((a, b) => b.startMs - a.startMs);
}

/** Anomalies for one channel, for that series' markArea. */
export function selectAnomaliesForChannel(state: AnomaliesState, channelId: string): Anomaly[] {
  return state.items.filter((a) => a.channelId === channelId);
}

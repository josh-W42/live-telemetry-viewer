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
      state.items = action.payload;
    },
  },
});

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

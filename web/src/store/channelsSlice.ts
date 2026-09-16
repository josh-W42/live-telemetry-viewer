import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * Which channels are drawn.
 *
 * UI state, so it belongs here rather than in the worker — the worker owns the
 * samples, the store owns what the user asked to see. The list is pushed down
 * in the view request, which is what keeps hiding a channel from touching its
 * ring buffer or its rules.
 *
 * It records the channels that are **hidden**, not the ones that are visible.
 * That way the store needs no knowledge of what channels exist: a channel the
 * server adds tomorrow is visible by default, with no initialisation step that
 * could run before `ListChannels` returns and leave the chart blank.
 */
export interface ChannelsState {
  hidden: string[];
}

export const initialChannelsState: ChannelsState = { hidden: [] };

const channelsSlice = createSlice({
  name: "channels",
  initialState: initialChannelsState,
  reducers: {
    toggleChannel(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.hidden = state.hidden.includes(id)
        ? state.hidden.filter((h) => h !== id)
        : [...state.hidden, id];
    },

    setChannelVisible(state, action: PayloadAction<{ id: string; visible: boolean }>) {
      const { id, visible } = action.payload;
      if (visible) {
        state.hidden = state.hidden.filter((h) => h !== id);
      } else if (!state.hidden.includes(id)) {
        state.hidden = [...state.hidden, id];
      }
    },

    showAllChannels(state) {
      state.hidden = [];
    },
  },
});

export const { toggleChannel, setChannelVisible, showAllChannels } = channelsSlice.actions;
export default channelsSlice.reducer;

/**
 * The visible ids, in the order the channels were declared.
 *
 * Hiding every channel yields an empty array, which is a legitimate request and
 * distinct from "no filter" — the view request carries `null` for the latter.
 */
export function selectVisibleChannelIds(state: ChannelsState, allIds: string[]): string[] {
  if (state.hidden.length === 0) return allIds;
  return allIds.filter((id) => !state.hidden.includes(id));
}

export function isChannelVisible(state: ChannelsState, id: string): boolean {
  return !state.hidden.includes(id);
}

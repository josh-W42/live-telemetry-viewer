import { describe, expect, it } from "vitest";

import reducer, {
  initialChannelsState,
  isChannelVisible,
  selectVisibleChannelIds,
  setChannelVisible,
  showAllChannels,
  toggleChannel,
} from "./channelsSlice";

const ALL = ["chamber_pressure", "chamber_temp", "vibration", "fuel_flow"];

describe("channel visibility", () => {
  // The store is initialised before ListChannels returns, so "everything is
  // visible" has to be the state of knowing nothing rather than a list that
  // someone remembered to populate.
  it("shows every channel before anything is toggled", () => {
    expect(initialChannelsState.hidden).toEqual([]);
    expect(selectVisibleChannelIds(initialChannelsState, ALL)).toEqual(ALL);
  });

  it("shows a channel the store has never heard of", () => {
    const hidden = reducer(initialChannelsState, toggleChannel("vibration"));
    expect(selectVisibleChannelIds(hidden, [...ALL, "nozzle_temp"])).toContain("nozzle_temp");
  });

  it("toggles off and back on", () => {
    const off = reducer(initialChannelsState, toggleChannel("vibration"));
    expect(isChannelVisible(off, "vibration")).toBe(false);
    expect(selectVisibleChannelIds(off, ALL)).toEqual([
      "chamber_pressure",
      "chamber_temp",
      "fuel_flow",
    ]);

    const on = reducer(off, toggleChannel("vibration"));
    expect(selectVisibleChannelIds(on, ALL)).toEqual(ALL);
  });

  it("keeps the declared channel order regardless of toggle order", () => {
    let state = reducer(initialChannelsState, toggleChannel("chamber_pressure"));
    state = reducer(state, toggleChannel("chamber_pressure"));

    expect(selectVisibleChannelIds(state, ALL)).toEqual(ALL);
  });

  it("does not hide the same channel twice", () => {
    let state = reducer(initialChannelsState, setChannelVisible({ id: "vibration", visible: false }));
    state = reducer(state, setChannelVisible({ id: "vibration", visible: false }));

    expect(state.hidden).toEqual(["vibration"]);
  });

  /*
  Hiding everything is a legitimate request, and the reason the view request
  carries `string[] | null` rather than following the subscription's
  empty-means-all convention: an empty array there would be read as "no filter"
  and answer "show me nothing" by drawing all four channels.
  */
  it("yields an empty list when every channel is hidden", () => {
    const state = ALL.reduce((acc, id) => reducer(acc, toggleChannel(id)), initialChannelsState);

    expect(selectVisibleChannelIds(state, ALL)).toEqual([]);
  });

  it("restores everything at once", () => {
    const none = ALL.reduce((acc, id) => reducer(acc, toggleChannel(id)), initialChannelsState);
    const all = reducer(none, showAllChannels());

    expect(selectVisibleChannelIds(all, ALL)).toEqual(ALL);
  });

  // Same assertion the view and anomaly slices make: the store holds
  // descriptors, never telemetry.
  it("holds no sample data", () => {
    const state = reducer(initialChannelsState, toggleChannel("vibration"));
    expect(JSON.stringify(state).length).toBeLessThan(200);
  });
});

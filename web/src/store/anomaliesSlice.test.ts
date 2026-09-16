import { describe, expect, it } from "vitest";

import type { Anomaly } from "../worker/rules";
import reducer, {
  initialAnomaliesState,
  selectAnomaliesForChannel,
  selectAnomaliesNewestFirst,
  setAnomalies,
} from "./anomaliesSlice";

function anomaly(over: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "overpressure:1",
    ruleId: "overpressure",
    channelId: "chamber_pressure",
    label: "Chamber overpressure",
    startMs: 1_000,
    endMs: 1_050,
    open: false,
    peak: 1180,
    ...over,
  };
}

describe("setAnomalies", () => {
  it("starts empty", () => {
    expect(initialAnomaliesState.items).toEqual([]);
  });

  it("replaces the list rather than appending", () => {
    const first = reducer(initialAnomaliesState, setAnomalies([anomaly({ id: "a" })]));
    const second = reducer(first, setAnomalies([anomaly({ id: "b" })]));

    expect(second.items.map((a) => a.id)).toEqual(["b"]);
  });

  // The worker resends the whole list every 500ms, so the common case is
  // applying the same content repeatedly. It must not accumulate.
  it("is idempotent when the same list arrives again", () => {
    const list = [anomaly({ id: "a" }), anomaly({ id: "b" })];

    let state = reducer(initialAnomaliesState, setAnomalies(list));
    for (let i = 0; i < 5; i++) state = reducer(state, setAnomalies(list));

    expect(state.items).toHaveLength(2);
  });

  it("carries an updated open anomaly through without duplicating it", () => {
    const open = anomaly({ id: "a", open: true, endMs: 1_050 });
    const grown = anomaly({ id: "a", open: true, endMs: 1_200 });
    const closed = anomaly({ id: "a", open: false, endMs: 1_260 });

    let state = reducer(initialAnomaliesState, setAnomalies([open]));
    state = reducer(state, setAnomalies([grown]));
    state = reducer(state, setAnomalies([closed]));

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "a", open: false, endMs: 1_260 });
  });

  it("empties when the worker reports nothing, so pruned entries disappear", () => {
    const state = reducer(initialAnomaliesState, setAnomalies([anomaly()]));
    expect(reducer(state, setAnomalies([])).items).toEqual([]);
  });
});

describe("selectors", () => {
  it("orders newest first", () => {
    const state = reducer(
      initialAnomaliesState,
      setAnomalies([
        anomaly({ id: "old", startMs: 1_000 }),
        anomaly({ id: "new", startMs: 9_000 }),
        anomaly({ id: "mid", startMs: 5_000 }),
      ]),
    );

    expect(selectAnomaliesNewestFirst(state).map((a) => a.id)).toEqual(["new", "mid", "old"]);
  });

  it("does not mutate the stored order while sorting", () => {
    const state = reducer(
      initialAnomaliesState,
      setAnomalies([anomaly({ id: "a", startMs: 1 }), anomaly({ id: "b", startMs: 2 })]),
    );

    selectAnomaliesNewestFirst(state);
    expect(state.items.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("filters to one channel for that series' markArea", () => {
    const state = reducer(
      initialAnomaliesState,
      setAnomalies([
        anomaly({ id: "p", channelId: "chamber_pressure" }),
        anomaly({ id: "v", channelId: "vibration" }),
      ]),
    );

    expect(selectAnomaliesForChannel(state, "vibration").map((a) => a.id)).toEqual(["v"]);
    expect(selectAnomaliesForChannel(state, "fuel_flow")).toEqual([]);
  });
});

// The same guarantee the view slice makes: this store holds metadata about
// telemetry, never telemetry itself.
describe("the store holds no telemetry", () => {
  it("keeps only scalar fields per entry", () => {
    const state = reducer(initialAnomaliesState, setAnomalies([anomaly()]));

    for (const item of state.items) {
      for (const value of Object.values(item)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
  });
});

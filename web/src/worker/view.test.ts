import { describe, expect, it } from "vitest";

import type { ChannelMeta } from "./protocol";
import { RingBuffer } from "./ringbuffer";
import { RuleEvaluator, type Rule } from "./rules";
import { buildView } from "./view";

const BASE = 1_700_000_000_000_000_000n;
const CAPACITY = 10_000;

const CHANNELS: ChannelMeta[] = [
  { id: "chamber_pressure", name: "Chamber Pressure", unit: "psi", sampleRateHz: 1000 },
  { id: "chamber_temp", name: "Chamber Temperature", unit: "K", sampleRateHz: 1000 },
  { id: "vibration", name: "Vibration", unit: "g", sampleRateHz: 1000 },
  { id: "fuel_flow", name: "Fuel Flow", unit: "kg/s", sampleRateHz: 1000 },
];

function atMs(ms: number): bigint {
  return BASE + BigInt(ms * 1_000_000);
}

/** Timestamps 1ms apart starting at `startMs`, with `valueAt` giving each value. */
function samples(count: number, startMs = 0, valueAt: (i: number) => number = (i) => i) {
  const timestamps = new Array<bigint>(count);
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    timestamps[i] = atMs(startMs + i);
    values[i] = valueAt(startMs + i);
  }
  return { timestamps, values };
}

function filledBuffers(count = 2_000): Map<string, RingBuffer> {
  const buffers = new Map<string, RingBuffer>();
  for (const c of CHANNELS) {
    const buf = new RingBuffer(CAPACITY, BASE);
    const s = samples(count);
    buf.push(s.timestamps, s.values);
    buffers.set(c.id, buf);
  }
  return buffers;
}

const WHOLE_WINDOW = { startNs: atMs(0), endNs: atMs(10_000), maxPoints: 200 };

describe("buildView", () => {
  it("returns every channel when the filter is null", () => {
    const view = buildView(CHANNELS, filledBuffers(), {
      ...WHOLE_WINDOW,
      channelIds: null,
    });

    expect(view.channels.map((c) => c.channelId)).toEqual(CHANNELS.map((c) => c.id));
  });

  it("returns only the channels asked for", () => {
    const view = buildView(CHANNELS, filledBuffers(), {
      ...WHOLE_WINDOW,
      channelIds: ["chamber_pressure", "vibration"],
    });

    expect(view.channels.map((c) => c.channelId)).toEqual(["chamber_pressure", "vibration"]);
  });

  it("keeps the declared channel order, not the order asked for", () => {
    const view = buildView(CHANNELS, filledBuffers(), {
      ...WHOLE_WINDOW,
      channelIds: ["fuel_flow", "chamber_pressure"],
    });

    expect(view.channels.map((c) => c.channelId)).toEqual(["chamber_pressure", "fuel_flow"]);
  });

  /*
  An empty array is a request to draw nothing, and has to be distinguishable
  from "no filter". The subscription's channelIds uses empty-means-all, which is
  why this one is nullable instead.
  */
  it("returns nothing when asked for nothing", () => {
    const view = buildView(CHANNELS, filledBuffers(), {
      ...WHOLE_WINDOW,
      channelIds: [],
    });

    expect(view.channels).toEqual([]);
    expect(view.pointsRendered).toBe(0);
  });

  /*
  The claim the status bar makes: hiding a channel changes what is *drawn*, not
  what is *held*. Retention belongs to the ring buffers and is unaffected by the
  view, which is the whole reason visibility is applied here rather than by
  re-subscribing with a narrower channel list.
  */
  it("counts every retained sample regardless of what is visible", () => {
    const buffers = filledBuffers(2_000);

    const all = buildView(CHANNELS, buffers, { ...WHOLE_WINDOW, channelIds: null });
    const one = buildView(CHANNELS, buffers, {
      ...WHOLE_WINDOW,
      channelIds: ["chamber_pressure"],
    });
    const none = buildView(CHANNELS, buffers, { ...WHOLE_WINDOW, channelIds: [] });

    expect(all.pointsHeld).toBe(8_000);
    expect(one.pointsHeld).toBe(8_000);
    expect(none.pointsHeld).toBe(8_000);
  });

  it("renders proportionally fewer points as channels are hidden", () => {
    const buffers = filledBuffers();

    const all = buildView(CHANNELS, buffers, { ...WHOLE_WINDOW, channelIds: null });
    const half = buildView(CHANNELS, buffers, {
      ...WHOLE_WINDOW,
      channelIds: ["chamber_pressure", "chamber_temp"],
    });

    expect(half.pointsRendered).toBe(all.pointsRendered / 2);
  });

  it("holds each channel to the point budget", () => {
    const view = buildView(CHANNELS, filledBuffers(5_000), {
      ...WHOLE_WINDOW,
      channelIds: null,
    });

    for (const c of view.channels) {
      expect(c.values.length).toBeLessThanOrEqual(WHOLE_WINDOW.maxPoints);
    }
  });

  it("survives a channel with no buffer", () => {
    const buffers = filledBuffers();
    buffers.delete("vibration");

    const view = buildView(CHANNELS, buffers, { ...WHOLE_WINDOW, channelIds: null });

    expect(view.channels.map((c) => c.channelId)).not.toContain("vibration");
    expect(view.pointsHeld).toBe(6_000);
  });
});

/*
The property that justifies filtering at the view rather than the subscription.

Ingestion and rule evaluation never consult the view request, so a channel
nobody is looking at keeps filling its buffer and keeps being checked for
faults. Untick a channel, let it fault, tick it back on, and both the anomaly
and the history that produced it are there.
*/
describe("a hidden channel", () => {
  const RULE: Rule = {
    id: "overpressure",
    channelId: "chamber_pressure",
    op: ">",
    threshold: 1100,
    minDurationMs: 20,
    label: "Chamber overpressure",
  };

  it("still ingests, and still raises anomalies, while it is not being drawn", () => {
    const buffers = filledBuffers(0);
    const evaluator = new RuleEvaluator([RULE]);

    // Nominal, then a 50ms excursion, then nominal again — all arriving while
    // the channel is hidden.
    const nominal = samples(500, 0, () => 1000);
    const spike = samples(50, 500, () => 1180);
    const after = samples(450, 550, () => 1000);

    for (const s of [nominal, spike, after]) {
      buffers.get("chamber_pressure")!.push(s.timestamps, s.values);
      evaluator.push("chamber_pressure", s.timestamps, s.values);
    }

    const hidden = buildView(CHANNELS, buffers, {
      ...WHOLE_WINDOW,
      channelIds: ["vibration"],
    });

    // Not drawn...
    expect(hidden.channels.map((c) => c.channelId)).not.toContain("chamber_pressure");
    // ...but retained...
    expect(hidden.pointsHeld).toBe(1_000);
    // ...and detected.
    const found = evaluator.anomalies(atMs(1_000), 600_000);
    expect(found).toHaveLength(1);
    expect(found[0]!.peak).toBeCloseTo(1180);

    // Ticking it back on reveals the whole history, not just what arrived since.
    const shown = buildView(CHANNELS, buffers, {
      ...WHOLE_WINDOW,
      channelIds: ["chamber_pressure"],
    });
    expect(shown.channels[0]!.values.length).toBeGreaterThan(0);
  });
});

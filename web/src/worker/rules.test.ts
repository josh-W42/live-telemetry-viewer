import { describe, expect, it } from "vitest";

import { RuleEvaluator, type Rule } from "./rules";

const BASE = 1_700_000_000_000_000_000n; // epoch nanoseconds
const MS = 1_000_000n;

const high: Rule = {
  id: "overpressure",
  channelId: "chamber_pressure",
  op: ">",
  threshold: 1100,
  minDurationMs: 20,
  label: "Chamber overpressure",
};

const low: Rule = {
  id: "unpressurised",
  channelId: "chamber_pressure",
  op: "<",
  threshold: 100,
  minDurationMs: 1000,
  label: "Chamber not pressurised",
};

/** Timestamps 1ms apart starting `startMs` after the base. */
function stamps(startMs: number, count: number): bigint[] {
  return Array.from({ length: count }, (_, i) => BASE + BigInt(startMs + i) * MS);
}

/**
 * A run of samples: `count` at `value`, starting at `startMs`.
 * Values are returned alongside their timestamps so a test reads as a story.
 */
function run(startMs: number, count: number, value: number) {
  return { timestamps: stamps(startMs, count), values: new Float64Array(count).fill(value) };
}

function evaluator(...rules: Rule[]): RuleEvaluator {
  return new RuleEvaluator(rules.length ? rules : [high]);
}

/** Every anomaly the evaluator currently knows about, oldest first. */
function anomaliesOf(ev: RuleEvaluator, nowMsAfterBase = 10_000): ReturnType<RuleEvaluator["anomalies"]> {
  return ev
    .anomalies(BASE + BigInt(nowMsAfterBase) * MS, 600_000)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
}

describe("duration threshold", () => {
  it("fires once the excursion reaches minDurationMs", () => {
    const ev = evaluator();
    // 25 samples at 1ms = 24ms of excursion, past the 20ms minimum.
    const r = run(100, 25, 1200);
    ev.push("chamber_pressure", r.timestamps, r.values);

    const found = anomaliesOf(ev);
    expect(found).toHaveLength(1);
    expect(found[0]!.ruleId).toBe("overpressure");
  });

  it("ignores an excursion that is too short", () => {
    const ev = evaluator();
    // 10ms, well under the 20ms minimum: a threshold crossing, not an anomaly.
    const r = run(100, 11, 1200);
    ev.push("chamber_pressure", r.timestamps, r.values);

    expect(anomaliesOf(ev)).toHaveLength(0);
  });

  it("treats a value exactly at the threshold as not crossing", () => {
    const ev = evaluator();
    const r = run(100, 50, 1100); // strictly greater is required
    ev.push("chamber_pressure", r.timestamps, r.values);

    expect(anomaliesOf(ev)).toHaveLength(0);
  });
});

describe("incremental evaluation", () => {
  // Samples arrive in 50ms batches, so an excursion routinely straddles a
  // boundary. A detector that reset per batch would miss most of them.
  it("gives identical results whether fed as one batch or many", () => {
    const whole = evaluator();
    const split = evaluator();

    const r = run(100, 60, 1200);
    whole.push("chamber_pressure", r.timestamps, r.values);

    for (let i = 0; i < 60; i += 7) {
      split.push(
        "chamber_pressure",
        r.timestamps.slice(i, i + 7),
        r.values.slice(i, i + 7),
      );
    }

    expect(anomaliesOf(split)).toEqual(anomaliesOf(whole));
  });

  it("confirms an excursion that crosses the minimum duration mid-batch", () => {
    const ev = evaluator();
    const r = run(100, 40, 1200);

    // 15 samples is 14ms elapsed, still short of the 20ms minimum.
    ev.push("chamber_pressure", r.timestamps.slice(0, 15), r.values.slice(0, 15));
    expect(anomaliesOf(ev)).toHaveLength(0);

    // The rest carries it past 20ms, so it confirms without the excursion ever
    // having started and finished inside one batch.
    ev.push("chamber_pressure", r.timestamps.slice(15), r.values.slice(15));
    expect(anomaliesOf(ev)).toHaveLength(1);
  });
});

describe("one anomaly per excursion", () => {
  it("does not emit per sample", () => {
    const ev = evaluator();
    const r = run(100, 500, 1200);
    ev.push("chamber_pressure", r.timestamps, r.values);

    expect(anomaliesOf(ev)).toHaveLength(1);
  });

  it("separates back-to-back excursions", () => {
    const ev = evaluator();

    const first = run(100, 30, 1200);
    const calm = run(130, 50, 1000);
    const second = run(180, 30, 1200);

    ev.push("chamber_pressure", first.timestamps, first.values);
    ev.push("chamber_pressure", calm.timestamps, calm.values);
    ev.push("chamber_pressure", second.timestamps, second.values);

    const found = anomaliesOf(ev);
    expect(found).toHaveLength(2);
    expect(found[0]!.id).not.toBe(found[1]!.id);
    expect(found[0]!.endMs).toBeLessThan(found[1]!.startMs);
  });
});

describe("open and closed", () => {
  it("reports an anomaly as open while the excursion continues", () => {
    const ev = evaluator();
    const r = run(100, 30, 1200);
    ev.push("chamber_pressure", r.timestamps, r.values);

    const found = anomaliesOf(ev);
    expect(found[0]!.open).toBe(true);
  });

  it("closes the same entry when the excursion ends", () => {
    const ev = evaluator();

    const spike = run(100, 30, 1200);
    ev.push("chamber_pressure", spike.timestamps, spike.values);
    const openId = anomaliesOf(ev)[0]!.id;

    const calm = run(130, 10, 1000);
    ev.push("chamber_pressure", calm.timestamps, calm.values);

    const found = anomaliesOf(ev);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(openId); // same record, not a second one
    expect(found[0]!.open).toBe(false);
  });

  it("extends the end time while the excursion is still open", () => {
    const ev = evaluator();

    const a = run(100, 30, 1200);
    ev.push("chamber_pressure", a.timestamps, a.values);
    const firstEnd = anomaliesOf(ev)[0]!.endMs;

    const b = run(130, 30, 1200);
    ev.push("chamber_pressure", b.timestamps, b.values);

    expect(anomaliesOf(ev)[0]!.endMs).toBeGreaterThan(firstEnd);
  });
});

describe("the < operator", () => {
  it("fires on the low side", () => {
    const ev = evaluator(low);
    const r = run(0, 1500, 14.7); // ambient, well under 100, for 1.5s
    ev.push("chamber_pressure", r.timestamps, r.values);

    const found = anomaliesOf(ev, 5_000);
    expect(found).toHaveLength(1);
    expect(found[0]!.ruleId).toBe("unpressurised");
  });

  it("does not fire while the value stays above the threshold", () => {
    const ev = evaluator(low);
    const r = run(0, 2000, 1000);
    ev.push("chamber_pressure", r.timestamps, r.values);

    expect(anomaliesOf(ev, 5_000)).toHaveLength(0);
  });
});

describe("peak", () => {
  it("records the highest value seen for a > rule", () => {
    const ev = evaluator();
    const ts = stamps(100, 30);
    const values = new Float64Array(30).fill(1150);
    values[10] = 1400; // the true peak, mid-excursion

    ev.push("chamber_pressure", ts, values);
    expect(anomaliesOf(ev)[0]!.peak).toBe(1400);
  });

  it("records the lowest value seen for a < rule", () => {
    const ev = evaluator(low);
    const ts = stamps(0, 1500);
    const values = new Float64Array(1500).fill(50);
    values[700] = 2;

    ev.push("chamber_pressure", ts, values);
    expect(anomaliesOf(ev, 5_000)[0]!.peak).toBe(2);
  });
});

describe("scoping and retention", () => {
  it("only applies a rule to its own channel", () => {
    const ev = evaluator();
    const r = run(100, 50, 1200);

    ev.push("vibration", r.timestamps, r.values);
    expect(anomaliesOf(ev)).toHaveLength(0);
  });

  it("prunes anomalies older than the retention window", () => {
    const ev = evaluator();
    const r = run(100, 50, 1200);
    ev.push("chamber_pressure", r.timestamps, r.values);

    expect(anomaliesOf(ev, 10_000)).toHaveLength(1);

    // Ten minutes later, the samples behind it have been overwritten.
    const later = ev.anomalies(BASE + BigInt(700_000) * MS, 600_000);
    expect(later).toHaveLength(0);
  });
});

describe("degenerate input", () => {
  it("handles an empty push", () => {
    const ev = evaluator();
    ev.push("chamber_pressure", [], new Float64Array(0));
    expect(anomaliesOf(ev)).toHaveLength(0);
  });

  it("handles a channel no rule mentions", () => {
    const ev = evaluator();
    const r = run(100, 50, 1200);
    ev.push("fuel_flow", r.timestamps, r.values);
    expect(anomaliesOf(ev)).toHaveLength(0);
  });

  it("rejects mismatched timestamp and value lengths", () => {
    const ev = evaluator();
    expect(() => ev.push("chamber_pressure", stamps(0, 3), new Float64Array(2))).toThrow();
  });
});

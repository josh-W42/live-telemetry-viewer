/**
 * Threshold rules, evaluated as samples arrive.
 *
 * These run on *ingestion*, not on what gets drawn, and that distinction is the
 * whole point. LTTB discards well over 99% of samples before the chart sees
 * them; at a ten-minute window a 30ms spike survives as at most a single point,
 * and quite possibly none. A detector fed the rendered view would miss exactly
 * the events it exists to find. Running here means rules see all 4,000 samples
 * a second - including everything that arrives while the view is paused.
 */

export interface Rule {
  id: string;
  channelId: string;
  op: ">" | "<";
  threshold: number;
  /**
   * How long the threshold must be exceeded before it counts.
   *
   * This is what separates an anomaly from noise brushing a limit. Vibration
   * crosses its band 120 times a second; pressure noise clips a threshold for a
   * sample or two. Neither is an event. Duration is the filter.
   */
  minDurationMs: number;
  label: string;
}

export interface Anomaly {
  /** `${ruleId}:${startNs}` — stable from the moment the excursion begins. */
  id: string;
  ruleId: string;
  channelId: string;
  label: string;
  startMs: number;
  endMs: number;
  /** True while the excursion is still going. */
  open: boolean;
  /** Most extreme value seen: the maximum for `>`, the minimum for `<`. */
  peak: number;
}

/** Per-rule progress through the sample stream. */
interface RuleState {
  /** Start of the current excursion, or null when not crossing. */
  startNs: bigint | null;
  lastNs: bigint;
  peak: number;
  /** Set once the excursion has lasted long enough to count. */
  confirmed: Anomaly | null;
}

const MS = 1_000_000n;

export class RuleEvaluator {
  private readonly state = new Map<string, RuleState>();

  /** Confirmed anomalies, in the order they began. */
  private readonly found: Anomaly[] = [];

  constructor(private readonly rules: Rule[]) {
    for (const rule of rules) {
      this.state.set(rule.id, { startNs: null, lastNs: 0n, peak: 0, confirmed: null });
    }
  }

  /**
   * Feed one channel's samples.
   *
   * State persists across calls because samples arrive in 50ms batches and an
   * excursion routinely straddles a boundary. Resetting per batch would miss
   * most of them.
   */
  push(channelId: string, timestampsNs: readonly bigint[], values: Float64Array): void {
    if (timestampsNs.length !== values.length) {
      throw new RangeError(
        `timestamps (${timestampsNs.length}) and values (${values.length}) must be the same length`,
      );
    }

    for (const rule of this.rules) {
      if (rule.channelId !== channelId) continue;
      this.applyRule(rule, timestampsNs, values);
    }
  }

  private applyRule(rule: Rule, timestampsNs: readonly bigint[], values: Float64Array): void {
    const state = this.state.get(rule.id)!;
    const minDurationNs = BigInt(rule.minDurationMs) * MS;

    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      const ts = timestampsNs[i]!;

      // Strictly beyond the threshold. A value sitting exactly on the limit is
      // within spec, not outside it.
      const crossing = rule.op === ">" ? value > rule.threshold : value < rule.threshold;

      if (!crossing) {
        this.closeIfOpen(state);
        continue;
      }

      if (state.startNs === null) {
        state.startNs = ts;
        state.peak = value;
      } else {
        state.peak = rule.op === ">" ? Math.max(state.peak, value) : Math.min(state.peak, value);
      }
      state.lastNs = ts;

      if (state.confirmed === null) {
        if (ts - state.startNs < minDurationNs) continue;

        // Long enough to count. Publish it now rather than waiting for the
        // excursion to end, so a live view shows it while it is happening.
        state.confirmed = {
          id: `${rule.id}:${state.startNs}`,
          ruleId: rule.id,
          channelId: rule.channelId,
          label: rule.label,
          startMs: nsToMs(state.startNs),
          endMs: nsToMs(ts),
          open: true,
          peak: state.peak,
        };
        this.found.push(state.confirmed);
        continue;
      }

      // Already published: keep the same record growing.
      state.confirmed.endMs = nsToMs(ts);
      state.confirmed.peak = state.peak;
    }
  }

  private closeIfOpen(state: RuleState): void {
    if (state.confirmed !== null) {
      state.confirmed.open = false;
      state.confirmed.endMs = nsToMs(state.lastNs);
    }
    state.startNs = null;
    state.confirmed = null;
  }

  /**
   * Anomalies still within the retained window.
   *
   * Pruned against the ring buffer's horizon: an anomaly whose samples have
   * been overwritten can no longer be shown or jumped to, so keeping it would
   * only offer the user a dead link.
   */
  anomalies(nowNs: bigint, retentionMs: number): Anomaly[] {
    const earliestMs = nsToMs(nowNs) - retentionMs;

    // Drop from the front; `found` is in start order, so this stays O(dropped).
    while (this.found.length > 0 && this.found[0]!.endMs < earliestMs) {
      this.found.shift();
    }
    return this.found;
  }
}

function nsToMs(ns: bigint): number {
  return Number(ns / 1000n) / 1000;
}

/**
 * The rules that ship, hardcoded for now (SPEC.md makes a rule-editing form a
 * stretch goal).
 *
 * Both fire against the simulator, deliberately: a rule that never triggers is
 * indistinguishable from a broken one, so each operator is exercised by
 * something observable rather than by unit tests alone.
 */
export const DEFAULT_RULES: Rule[] = [
  {
    // Steady-state chamber pressure is 1000 psi with 8 psi of drift and sigma
    // of 9, so 1100 sits about 11 sigma out: unreachable by noise. The
    // simulator injects a +180 psi spike lasting 30-100ms into every
    // steady-state phase, which clears it easily.
    id: "overpressure",
    channelId: "chamber_pressure",
    op: ">",
    threshold: 1100,
    minDurationMs: 20,
    label: "Chamber overpressure",
  },
  {
    // Fires through idle and chill-down, where the chamber sits at ambient
    // 14.7 psi. Exists so the `<` path is exercised end to end.
    id: "unpressurised",
    channelId: "chamber_pressure",
    op: "<",
    threshold: 100,
    minDurationMs: 1000,
    label: "Chamber not pressurised",
  },
];

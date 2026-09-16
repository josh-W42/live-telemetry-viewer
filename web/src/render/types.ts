import type { Channel, TelemetryBatch } from "../gen/telemetry/v1/telemetry_pb";

/**
 * The seam between the data stream and whatever draws it.
 *
 * M2 has two implementations, both naive and both on the main thread. M3 adds a
 * worker-backed one. The benchmark harness talks only to this interface, which
 * is what keeps the M2 and M3 numbers comparable: swapping the renderer changes
 * what is measured, never how.
 */
export interface ChartRenderer {
  /**
   * True when the renderer opens its own telemetry stream, as the worker-backed
   * one does. The app must not feed such a renderer, or the data would arrive
   * twice — and routing batches through the main thread is precisely what mode
   * C exists to avoid.
   */
  readonly ownsDataSource: boolean;

  init(el: HTMLDivElement, channels: Channel[]): void;
  /** Called once per incoming batch. Ignored when ownsDataSource is true. */
  push(batch: TelemetryBatch): void;
  /** Points currently retained in memory. */
  pointsHeld(): number;
  /** Points actually handed to the chart to draw. */
  pointsRendered(): number;

  /**
   * Main-thread milliseconds spent rendering since the last call, and the
   * longest single occurrence. Reading resets the accumulator.
   *
   * Each renderer times its own work rather than the app timing it from
   * outside: M2's renderers are pushed to, while the worker-backed one is
   * driven by its own animation frame loop, so there is no single call site to
   * wrap. The metric keeps the same meaning across all three, which is what
   * keeps the M2 and M3 numbers comparable.
   */
  takeRenderStats(): { totalMs: number; maxMs: number };

  /** Stream counters, for renderers that own their own data source. */
  streamStats?(): { batches: number; gaps: number };

  resize(): void;
  dispose(): void;
}

/** Accumulates main-thread render time. Shared by all three renderers. */
export class RenderTimer {
  private totalMs = 0;
  private maxMs = 0;

  /** Time `fn` and fold the result into the running totals. */
  measure<T>(fn: () => T): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - started;
      this.totalMs += elapsed;
      if (elapsed > this.maxMs) this.maxMs = elapsed;
    }
  }

  take(): { totalMs: number; maxMs: number } {
    const out = { totalMs: this.totalMs, maxMs: this.maxMs };
    this.totalMs = 0;
    this.maxMs = 0;
    return out;
  }
}

/**
 * Nanosecond timestamp to milliseconds, as a float.
 *
 * Going via BigInt division first matters: a raw nanosecond timestamp is around
 * 1.7e18, well past Number.MAX_SAFE_INTEGER, so Number(ns) alone quantises to
 * roughly 256ns. Dividing to microseconds in BigInt keeps the value inside the
 * safe range before it becomes a float.
 */
export function nsToMs(ns: bigint): number {
  return Number(ns / 1000n) / 1000;
}

/** Channels split across two y-axes, since psi/K and g/(kg/s) differ by orders of magnitude. */
export function axisIndexFor(channelId: string): number {
  return channelId === "chamber_pressure" || channelId === "chamber_temp" ? 0 : 1;
}

const palette: Record<string, string> = {
  chamber_pressure: "#2563eb",
  chamber_temp: "#dc2626",
  vibration: "#7c3aed",
  fuel_flow: "#059669",
};

export function colorFor(channelId: string): string {
  return palette[channelId] ?? "#666";
}

/**
 * Chart options shared by both naive modes.
 *
 * Deliberately omits ECharts' own `sampling: 'lttb'`. Letting the library
 * downsample would hide the very cost M3 exists to remove, and would make the
 * before/after comparison meaningless. Animation is off because animating 20
 * updates a second is pure overhead nobody can perceive.
 */
export function baseOption(channels: Channel[]) {
  return {
    animation: false,
    grid: { left: 64, right: 64, top: 28, bottom: 28 },
    xAxis: { type: "time" as const, axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: "value" as const, scale: true, name: "psi / K" },
      { type: "value" as const, scale: true, name: "g / kg·s⁻¹" },
    ],
    legend: { data: channels.map((c) => c.name), top: 0 },
    series: channels.map((c) => ({
      name: c.name,
      type: "line" as const,
      showSymbol: false,
      lineStyle: { width: 1 },
      itemStyle: { color: colorFor(c.id) },
      yAxisIndex: axisIndexFor(c.id),
      data: [] as number[][],
    })),
  };
}

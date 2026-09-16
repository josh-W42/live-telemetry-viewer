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
  init(el: HTMLDivElement, channels: Channel[]): void;
  /** Called once per incoming batch, roughly 20 times a second. */
  push(batch: TelemetryBatch): void;
  /** Points currently retained in memory. */
  pointsHeld(): number;
  /** Points actually handed to the chart to draw. */
  pointsRendered(): number;
  resize(): void;
  dispose(): void;
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

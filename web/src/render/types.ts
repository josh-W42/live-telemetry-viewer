import type { RenderWindow } from "../store/viewSlice";
import type { Anomaly } from "../worker/rules";
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

  /**
   * Start or stop consuming data.
   *
   * Streams are tied to this rather than to the renderer's lifetime. An idle
   * page has no business holding a subscription open: the server would keep
   * pushing 4,000 samples a second at a client that is throwing them away, and
   * a worker-backed renderer would go on filling ring buffers and redrawing
   * long after a benchmark reported `completed`.
   */
  setActive(active: boolean): void;

  /**
   * Set the visible time window.
   *
   * A `live` window follows the clock and is re-requested each frame. A
   * `pinned` one does not move, so it is requested once when it changes —
   * redrawing identical pixels thirty times a second would be pure waste.
   *
   * Only the worker-backed renderer honours this; the M2 baselines are
   * live-only by design, so their measurements stay comparable.
   */
  setWindow(window: RenderWindow): void;

  /**
   * Called when the user zooms or pans.
   *
   * Gestures are reported *relatively* — a factor and an anchor, not a range.
   * An earlier version reported absolute ranges taken from ECharts' own
   * dataZoom, which fed back on itself: the chart expresses zoom as a
   * percentage of the data it holds, and applying the result replaced that data
   * with exactly the selected range, so zoom-out could never exceed 100% of an
   * ever-shrinking window. Relative gestures leave the store as the only thing
   * that knows where the window actually is.
   */
  onGesture(handler: (gesture: ViewGesture) => void): void;

  /**
   * Report anomalies the worker detected. The renderer forwards rather than
   * acting: the store stays the single authority, so the chart and the sidebar
   * cannot disagree about what was found.
   */
  onAnomalies(handler: (anomalies: Anomaly[]) => void): void;

  /** Anomalies to shade on the chart. */
  setAnomalies(anomalies: Anomaly[]): void;

  /**
   * Which channels the user wants drawn.
   *
   * Honoured only by the worker-backed renderer, which passes the list down in
   * its view request so the filtering happens where the data is. The two
   * baselines ignore it: they have no view request to put it in, and changing
   * what they draw would change what M2 measured.
   */
  setVisibleChannels(channelIds: string[]): void;

  /**
   * Report the state of the renderer's own connection.
   *
   * Only a renderer that owns its data source has one to report. Before this
   * existed the app simply assumed mode C was streaming whenever it was active,
   * so a stopped server still showed a healthy indicator.
   */
  onStatus(handler: (status: ConnectionStatus) => void): void;

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
  streamStats?(): { batches: number; droppedBatches: number };

  /** Retained samples per channel, for renderers that retain anything. */
  heldPerChannel?(): Record<string, number>;

  resize(): void;
  dispose(): void;
}

/**
 * What the status indicator shows.
 *
 * `connecting` covers the unary ListChannels call as well as opening the
 * stream; `streaming` means batches are actually arriving.
 */
export type ConnectionState = "idle" | "connecting" | "streaming" | "error";

export interface ConnectionStatus {
  state: ConnectionState;
  /** Set only on `error`. */
  message?: string;
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

/**
 * A user gesture on the chart, expressed relative to whatever is on screen.
 *
 * `factor` below 1 zooms in, above 1 zooms out. `anchorFraction` is where the
 * cursor sat across the plot area, so the instant under it can be held still.
 * `fraction` on a pan is a proportion of the current span, positive forwards.
 */
export type ViewGesture =
  | { kind: "zoom"; factor: number; anchorFraction: number }
  | { kind: "pan"; fraction: number };

/** Grid insets from baseOption, needed to map a pixel to a plot fraction. */
export const GRID_LEFT = 64;
export const GRID_RIGHT = 64;

/** Where `clientX` falls across the plot area, 0 (left edge) to 1 (right). */
export function plotFraction(clientX: number, rect: DOMRect): number {
  const plotWidth = rect.width - GRID_LEFT - GRID_RIGHT;
  if (plotWidth <= 0) return 0.5;

  const f = (clientX - rect.left - GRID_LEFT) / plotWidth;
  return Math.min(Math.max(f, 0), 1);
}

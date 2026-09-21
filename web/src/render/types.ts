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
   * Main-thread milliseconds spent rendering since the last call, the longest
   * single occurrence, and how many renders made it up. Reading resets the
   * accumulator, so exactly one consumer may call it — the benchmark harness.
   * A live readout wants `renderCount()` instead.
   *
   * Each renderer times its own work rather than the app timing it from
   * outside: M2's renderers are pushed to, while the worker-backed one is
   * driven by its own animation frame loop, so there is no single call site to
   * wrap. The metric keeps the same meaning across all three, which is what
   * keeps the M2 and M3 numbers comparable.
   */
  takeRenderStats(): RenderStats;

  /**
   * Renders since this renderer was created. Cumulative and non-destructive, so
   * a status bar can difference it for a live rate while a benchmark is using
   * the resetting accumulator above.
   */
  renderCount(): number;

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

/** One reading from a RenderTimer. */
export interface RenderStats {
  totalMs: number;
  maxMs: number;
  /**
   * Renders in the period. The denominator for `totalMs`: it is what separates
   * "each render got slower" from "more renders landed".
   */
  count: number;
}

/**
 * Accumulates main-thread render time. Shared by all three renderers.
 *
 * Counts operations as well as timing them. Without the count, `totalMs` for a
 * second is ambiguous: twice the cost could mean each render got twice as slow,
 * or that twice as many landed. That ambiguity was left unresolved by two
 * separate runs before the counter was added.
 */
export class RenderTimer {
  private totalMs = 0;
  private maxMs = 0;
  private count = 0;

  /**
   * Renders since construction, never reset.
   *
   * Separate from the resettable `count` so a live readout can watch the rate
   * without disturbing a benchmark run. `take()` is destructive, and two
   * consumers sharing it would mean whichever called first silently ate the
   * other's data — the harness would report a fraction of the real work.
   */
  private lifetime = 0;

  /** Time `fn` and fold the result into the running totals. */
  measure<T>(fn: () => T): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - started;
      this.totalMs += elapsed;
      if (elapsed > this.maxMs) this.maxMs = elapsed;
      this.count += 1;
      this.lifetime += 1;
    }
  }

  take(): RenderStats {
    const out = { totalMs: this.totalMs, maxMs: this.maxMs, count: this.count };
    this.totalMs = 0;
    this.maxMs = 0;
    this.count = 0;
    return out;
  }

  /** Cumulative render count. Reading it disturbs nothing. */
  renderCount(): number {
    return this.lifetime;
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

/** Horizontal room one y-axis needs for its line, ticks and labels. */
export const AXIS_WIDTH = 56;

/** Colour of an axis whose channel is currently hidden. */
const AXIS_DIMMED = "#c8c8c8";

/**
 * Grid insets for the viewer, sized to fit one axis per channel.
 *
 * Takes a count rather than a visible set, deliberately. Plot geometry must not
 * depend on what is on screen: if hiding a channel narrowed the insets, the
 * plot would widen and every remaining trace would change apparent width and
 * position — horizontal instability in place of the vertical kind the fixed
 * axes remove.
 */
export function viewerGridInsets(channelCount: number): { left: number; right: number } {
  const leftCount = Math.ceil(channelCount / 2);
  return {
    left: Math.max(AXIS_WIDTH, leftCount * AXIS_WIDTH),
    right: Math.max(AXIS_WIDTH, (channelCount - leftCount) * AXIS_WIDTH),
  };
}

/**
 * One y-axis per channel, at the fixed range the server declared.
 *
 * `visible` affects colour and nothing else. Every channel keeps its axis
 * whether or not its trace is drawn, because an axis that disappeared would let
 * the others slide over — and each range comes from the channel metadata rather
 * than from the data, so it cannot move when a neighbour is hidden. That pair
 * of properties is exactly what the old shared `scale: true` axes lacked:
 * unticking fuel flow rescaled vibration, which made a trace change apparent
 * amplitude without its data changing.
 */
export function yAxes(channels: Channel[], visible: string[] | null) {
  const shown = visible === null ? null : new Set(visible);
  const leftCount = Math.ceil(channels.length / 2);

  return channels.map((c, index) => {
    const onLeft = index < leftCount;
    const lit = shown === null || shown.has(c.id);
    const color = lit ? colorFor(c.id) : AXIS_DIMMED;

    return {
      type: "value" as const,
      position: (onLeft ? "left" : "right") as "left" | "right",
      // Each axis sits one slot further out than the last on its side.
      offset: (onLeft ? index : index - leftCount) * AXIS_WIDTH,
      name: c.unit,
      min: c.displayMin,
      max: c.displayMax,
      nameTextStyle: { color },
      axisLine: { show: true, lineStyle: { color } },
      axisLabel: { color },
      // Four sets of gridlines would be a moiré pattern, so only the first
      // axis draws them.
      splitLine: { show: index === 0 },
    };
  });
}

/** Grid insets for the two frozen baseline renderers. */
export const GRID_LEFT = 64;
export const GRID_RIGHT = 64;

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
    grid: { left: GRID_LEFT, right: GRID_RIGHT, top: 28, bottom: 28 },
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
 * Chart options for the viewer.
 *
 * Separate from `baseOption` rather than an edit to it: modes A and B are
 * frozen references whose numbers are quoted throughout NOTES.md, and changing
 * what they draw would make those numbers unreproducible.
 *
 * No legend, unlike the baselines. The channel checkboxes are the one authority
 * on visibility, and an ECharts legend is a second one — clicking it hides a
 * series without the store knowing, leaving the chart and the channel list
 * disagreeing about what is on screen.
 */
export function viewerOption(channels: Channel[]) {
  const insets = viewerGridInsets(channels.length);

  return {
    animation: false,
    grid: { left: insets.left, right: insets.right, top: 28, bottom: 28 },
    xAxis: { type: "time" as const, axisLabel: { hideOverlap: true } },
    yAxis: yAxes(channels, null),
    series: channels.map((c, index) => ({
      name: c.name,
      type: "line" as const,
      showSymbol: false,
      lineStyle: { width: 1 },
      itemStyle: { color: colorFor(c.id) },
      yAxisIndex: index,
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

/**
 * Where `clientX` falls across the plot area, 0 (left edge) to 1 (right).
 *
 * The insets are passed in rather than read from a module constant: the viewer
 * and the two baselines have different grids now, and mapping the viewer's
 * pixels with the baselines' narrower insets would put every zoom anchor
 * slightly off — a silent drift in the code the zoom-out bug lived in.
 */
export function plotFraction(
  clientX: number,
  rect: DOMRect,
  insets: { left: number; right: number },
): number {
  const plotWidth = rect.width - insets.left - insets.right;
  if (plotWidth <= 0) return 0.5;

  const f = (clientX - rect.left - insets.left) / plotWidth;
  return Math.min(Math.max(f, 0), 1);
}

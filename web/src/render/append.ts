import * as echarts from "echarts";

import type { Channel, TelemetryBatch } from "../gen/telemetry/v1/telemetry_pb";
import {
  baseOption,
  nsToMs,
  RenderTimer,
  type ChartRenderer,
  type ViewGesture,
} from "./types";
import type { Anomaly } from "../worker/rules";
import type { RenderWindow } from "../store/viewSlice";

/**
 * Mode B: ECharts' own streaming path.
 *
 * appendData hands the chart only the new points, so none of mode A's quadratic
 * re-serialisation happens. This is what someone who read the documentation
 * writes, and it is a far more honest baseline than mode A alone.
 *
 * It still loses to a worker, for two reasons mode A also suffers: every point
 * stays in memory forever, and all the drawing happens on the main thread.
 *
 * The catch, from ECharts' own notes: appendData runs a restricted update cycle
 * in which only data may be modified, and coordinate systems and axes are
 * rebuilt only on a full update. So appendData alone cannot advance a scrolling
 * time axis. The axis is nudged separately, at most once a second rather than on
 * every batch, because that call is the expensive one.
 */
export class AppendRenderer implements ChartRenderer {
  readonly ownsDataSource = false;

  private readonly timer = new RenderTimer();

  private chart: echarts.ECharts | null = null;
  private channelIds: string[] = [];
  private held = 0;

  private firstMs = 0;
  private lastMs = 0;
  private lastAxisUpdate = 0;

  /** How often the axis may be moved, in milliseconds. */
  private static readonly axisIntervalMs = 1000;

  init(el: HTMLDivElement, channels: Channel[]): void {
    this.chart = echarts.init(el, undefined, { renderer: "canvas" });
    this.channelIds = channels.map((c) => c.id);
    this.held = 0;
    this.firstMs = 0;
    this.lastMs = 0;
    this.lastAxisUpdate = 0;
    this.chart.setOption(baseOption(channels));
  }

  push(batch: TelemetryBatch): void {
    if (!this.chart) return;

    for (const ch of batch.channels) {
      const seriesIndex = this.channelIds.indexOf(ch.channelId);
      if (seriesIndex < 0) continue;

      const data: number[][] = new Array(ch.values.length);
      for (let i = 0; i < ch.values.length; i++) {
        const t = nsToMs(ch.timestampsNs[i]!);
        data[i] = [t, ch.values[i]!];
        if (this.firstMs === 0) this.firstMs = t;
        this.lastMs = t;
      }

      this.timer.measure(() => this.chart!.appendData({ seriesIndex, data }));
      this.held += data.length;
    }

    this.timer.measure(() => this.moveAxisIfDue());
  }

  /**
   * Extend the x-axis to cover the data appended since the last update.
   *
   * Throttled because this is a full update cycle: doing it per batch would
   * reintroduce most of the cost appendData exists to avoid. The series data is
   * deliberately left out of the option, since including it would reset what
   * appendData has accumulated.
   */
  private moveAxisIfDue(): void {
    const now = performance.now();
    if (now - this.lastAxisUpdate < AppendRenderer.axisIntervalMs) return;
    this.lastAxisUpdate = now;

    this.chart?.setOption(
      { xAxis: { min: this.firstMs, max: this.lastMs } },
      { lazyUpdate: true, silent: true },
    );
  }

  // Baselines are live-only: they render whatever they are fed, in arrival
  // order, with no notion of a window. Giving them interaction would change
  // what M2 measured.
  setWindow(_window: RenderWindow): void {
    void _window;
  }

  onGesture(_handler: (gesture: ViewGesture) => void): void {
    void _handler;
  }

  // No worker, so nothing detects and nothing to draw.
  onAnomalies(_handler: (anomalies: Anomaly[]) => void): void {
    void _handler;
  }

  setAnomalies(_anomalies: Anomaly[]): void {
    void _anomalies;
  }

  // This renderer does not own a stream; App gates what reaches push().
  setActive(_active: boolean): void {
    void _active;
  }

  takeRenderStats(): { totalMs: number; maxMs: number } {
    return this.timer.take();
  }

  pointsHeld(): number {
    return this.held;
  }

  pointsRendered(): number {
    return this.held;
  }

  resize(): void {
    this.chart?.resize();
  }

  dispose(): void {
    this.chart?.dispose();
    this.chart = null;
    this.held = 0;
  }
}

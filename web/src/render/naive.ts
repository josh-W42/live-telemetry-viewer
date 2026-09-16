import * as echarts from "echarts";

import type { Channel, TelemetryBatch } from "../gen/telemetry/v1/telemetry_pb";
import {
  baseOption,
  nsToMs,
  RenderTimer,
  type ChartRenderer,
  type ViewGesture,
} from "./types";
import type { RenderWindow } from "../store/viewSlice";

/**
 * Mode A: the obvious wrong way.
 *
 * Every sample is kept in a plain JS array, and every incoming batch hands
 * ECharts the *entire* dataset again via setOption. That is the naive thing a
 * person writes first, and it is quadratic over a run: batch n re-serialises
 * all n*50 points already sent, so total work grows with the square of elapsed
 * time. At 20 batches a second, five minutes in, each setOption is shipping well
 * over a million points and there are twenty of them per second.
 *
 * This exists to be measured, not to be used.
 */
export class NaiveRenderer implements ChartRenderer {
  readonly ownsDataSource = false;

  private readonly timer = new RenderTimer();

  private chart: echarts.ECharts | null = null;
  private channelIds: string[] = [];
  private series: number[][][] = [];
  private held = 0;

  init(el: HTMLDivElement, channels: Channel[]): void {
    this.chart = echarts.init(el, undefined, { renderer: "canvas" });
    this.channelIds = channels.map((c) => c.id);
    this.series = channels.map(() => []);
    this.held = 0;
    this.chart.setOption(baseOption(channels));
  }

  push(batch: TelemetryBatch): void {
    if (!this.chart) return;

    for (const ch of batch.channels) {
      const index = this.channelIds.indexOf(ch.channelId);
      if (index < 0) continue;

      const target = this.series[index]!;
      for (let i = 0; i < ch.values.length; i++) {
        target.push([nsToMs(ch.timestampsNs[i]!), ch.values[i]!]);
        this.held += 1;
      }
    }

    // The naive move: the whole dataset, again, on every batch.
    this.timer.measure(() => {
      this.chart!.setOption({
        series: this.series.map((data) => ({ data })),
      });
    });
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

  // Everything held is handed to the chart, which is precisely the problem.
  pointsRendered(): number {
    return this.held;
  }

  resize(): void {
    this.chart?.resize();
  }

  dispose(): void {
    this.chart?.dispose();
    this.chart = null;
    this.series = [];
    this.held = 0;
  }
}

import * as echarts from "echarts";

import type { Channel, TelemetryBatch } from "../gen/telemetry/v1/telemetry_pb";
import type { ViewMessage, WorkerMessage, WorkerRequest } from "../worker/protocol";
import type { RenderWindow } from "../store/viewSlice";
import {
  baseOption,
  GRID_LEFT,
  GRID_RIGHT,
  plotFraction,
  RenderTimer,
  type ChartRenderer,
  type ViewGesture,
} from "./types";

/** Ten minutes at 1kHz. Sized once; the worker never grows past it. */
const CAPACITY = 600_000;

/** ~30fps. Faster than this redraws frames nobody sees. */
const FRAME_INTERVAL_MS = 33;

/**
 * Mode C: ring buffers and LTTB in a worker.
 *
 * The main thread never sees a raw batch. It asks for a window, and gets back a
 * few thousand already-downsampled points. M2 showed the cost is in *drawing* N
 * points, not ingesting them, so the only fix that matters is drawing fewer —
 * which is what this arranges.
 *
 * The renderer pulls rather than being pushed to: a frame loop requests a view,
 * and applies whatever comes back. That is why it owns its own data source.
 */
export class WorkerRenderer implements ChartRenderer {
  readonly ownsDataSource = true;

  private readonly timer = new RenderTimer();
  private chart: echarts.ECharts | null = null;
  private worker: Worker | null = null;

  private channelIds: string[] = [];
  private seriesIndex = new Map<string, number>();

  private rafHandle = 0;
  private lastRequestAt = 0;
  private nextRequestId = 1;
  /** Id of the request awaiting a reply, or 0 when idle. */
  private inFlight = 0;

  private window: RenderWindow = { kind: "live", durationMs: 600_000 };
  private gestureHandler: ((g: ViewGesture) => void) | null = null;
  private container: HTMLDivElement | null = null;
  private dragLastX: number | null = null;

  private held = 0;
  private rendered = 0;
  private batches = 0;
  private gaps = 0;

  constructor(private readonly baseUrl: string) {}

  init(el: HTMLDivElement, channels: Channel[]): void {
    this.chart = echarts.init(el, undefined, { renderer: "canvas" });
    // No ECharts dataZoom component. It keeps its own notion of the visible
    // range as a percentage of the data it holds, which fights with ours: we
    // replace that data with exactly the window selected, so its 0-100% shrinks
    // to the current window and zoom-out can never escape. Gestures are handled
    // here instead and reported relatively.
    this.chart.setOption(baseOption(channels));

    this.container = el;
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onPointerDown);

    this.channelIds = channels.map((c) => c.id);
    this.seriesIndex = new Map(channels.map((c, i) => [c.id, i]));

    this.worker = new Worker(new URL("../worker/telemetry.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onMessage(e.data);

    // Deliberately does not start streaming. Nothing is consumed until
    // setActive(true), so an idle page holds no subscription.
  }

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;

    if (active) {
      this.send({
        type: "start",
        baseUrl: this.baseUrl,
        capacity: CAPACITY,
        channelIds: [],
      });

      // Counters are cheap and independent of rendering, so they keep updating
      // even if a view request fails.
      this.statsTimer = setInterval(() => this.send({ type: "stats" }), 500);
      this.loop();
      return;
    }

    // Stopping means all three: the stream, the counters, and the frame loop.
    // Leaving any one running would keep the server pushing, or keep redrawing
    // a chart nobody is measuring.
    this.send({ type: "stop" });

    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.inFlight = 0;
  }

  /** Mode C feeds itself; batches never come through here. */
  push(_batch: TelemetryBatch): void {
    void _batch;
  }

  private send(req: WorkerRequest): void {
    this.worker?.postMessage(req);
  }

  private loop = (): void => {
    this.rafHandle = requestAnimationFrame(this.loop);

    // A pinned window does not move, so re-requesting it would redraw pixels
    // that are already correct. It is served once by setWindow instead.
    if (this.window.kind === "pinned") return;

    const now = performance.now();
    if (now - this.lastRequestAt < FRAME_INTERVAL_MS) return;

    // At most one request outstanding. If the worker has not answered yet,
    // skip this frame rather than queueing work it is already behind on —
    // the same reason the server drops batches instead of blocking.
    if (this.inFlight !== 0) return;

    this.lastRequestAt = now;
    this.requestView();
  };

  /**
   * Set the window the chart should show.
   *
   * A pinned window is requested once, here, because it does not move. A live
   * one is left to the frame loop, which recomputes `now` each tick.
   */
  setWindow(window: RenderWindow): void {
    this.window = window;
    if (!this.active) return;

    if (window.kind === "pinned") {
      // Nothing will re-request this, so do it now.
      this.inFlight = 0;
      this.requestView();
    }
  }

  onGesture(handler: (gesture: ViewGesture) => void): void {
    this.gestureHandler = handler;
  }

  /** One notch of wheel zooms by this much; the inverse zooms back out. */
  private static readonly ZOOM_STEP = 0.8;

  private onWheel = (e: WheelEvent): void => {
    if (!this.container) return;
    // Otherwise the page scrolls while the user is trying to zoom the chart.
    e.preventDefault();

    const factor = e.deltaY < 0 ? WorkerRenderer.ZOOM_STEP : 1 / WorkerRenderer.ZOOM_STEP;
    this.gestureHandler?.({
      kind: "zoom",
      factor,
      anchorFraction: plotFraction(e.clientX, this.container.getBoundingClientRect()),
    });
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.container || e.button !== 0) return;

    this.dragLastX = e.clientX;
    this.container.setPointerCapture(e.pointerId);
    this.container.addEventListener("pointermove", this.onPointerMove);
    this.container.addEventListener("pointerup", this.onPointerUp);
    this.container.addEventListener("pointercancel", this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.container || this.dragLastX === null) return;

    const rect = this.container.getBoundingClientRect();
    const plotWidth = rect.width - GRID_LEFT - GRID_RIGHT;
    if (plotWidth <= 0) return;

    const dx = e.clientX - this.dragLastX;
    this.dragLastX = e.clientX;

    // Dragging right should pull earlier data into view, so the window moves
    // backwards in time - hence the negation.
    this.gestureHandler?.({ kind: "pan", fraction: -dx / plotWidth });
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragLastX = null;
    this.container?.releasePointerCapture?.(e.pointerId);
    this.container?.removeEventListener("pointermove", this.onPointerMove);
    this.container?.removeEventListener("pointerup", this.onPointerUp);
    this.container?.removeEventListener("pointercancel", this.onPointerUp);
  };

  private requestView(): void {
    const width = this.chart?.getWidth() ?? 1200;
    const { startNs, endNs } = this.bounds();

    this.inFlight = this.nextRequestId++;
    this.send({
      type: "view",
      id: this.inFlight,
      startNs,
      endNs,
      // Two points per pixel: enough that the line is pixel-accurate, few
      // enough that the count is bounded by the display, not the dataset.
      // Narrowing the window does not change this number - it changes how much
      // detail each point carries, which is why zooming reveals real structure.
      maxPoints: Math.max(2, width * 2),
    });
  }

  private bounds(): { startNs: bigint; endNs: bigint } {
    const msToNs = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;

    if (this.window.kind === "pinned") {
      return { startNs: msToNs(this.window.startMs), endNs: msToNs(this.window.endMs) };
    }

    const endNs = BigInt(Date.now()) * 1_000_000n;
    return { startNs: endNs - BigInt(this.window.durationMs) * 1_000_000n, endNs };
  }

  private onMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case "ready":
        break;
      case "error":
        console.error("telemetry worker:", msg.message);
        // Release the slot, or the frame loop would wait forever on a reply
        // that is never coming.
        this.inFlight = 0;
        break;
      case "stats":
        // Counters keep flowing even when views fail, so the UI still shows
        // the ring buffers filling.
        this.held = msg.pointsHeld;
        this.batches = msg.batches;
        this.gaps = msg.gaps;
        this.bufferBytes = msg.bytes;
        break;
      case "view":
        this.applyView(msg);
        break;
    }
  }

  /** Bytes held by the worker's ring buffers. Fixed once allocated. */
  bufferBytes = 0;

  private applyView(msg: ViewMessage): void {
    // A reply to a superseded request would redraw stale data.
    if (msg.id !== this.inFlight) return;
    this.inFlight = 0;

    this.held = msg.pointsHeld;
    this.rendered = msg.pointsRendered;
    this.batches = msg.batches;
    this.gaps = msg.gaps;

    if (!this.chart) return;

    const series = new Array<{ data: number[][] }>(this.channelIds.length);
    for (let i = 0; i < series.length; i++) series[i] = { data: [] };

    for (const view of msg.channels) {
      const index = this.seriesIndex.get(view.channelId);
      if (index === undefined) continue;

      const data = new Array<number[]>(view.values.length);
      for (let i = 0; i < view.values.length; i++) {
        // Offsets are nanoseconds from baseNs; ECharts' time axis wants ms.
        data[i] = [Number(msg.baseNs / 1_000_000n) + view.timestamps[i]! / 1e6, view.values[i]!];
      }
      series[index] = { data };
    }

    this.timer.measure(() => this.chart!.setOption({ series }));
  }

  pointsHeld(): number {
    return this.held;
  }

  pointsRendered(): number {
    return this.rendered;
  }

  streamStats(): { batches: number; gaps: number } {
    return { batches: this.batches, gaps: this.gaps };
  }

  takeRenderStats(): { totalMs: number; maxMs: number } {
    return this.timer.take();
  }

  resize(): void {
    this.chart?.resize();
  }

  dispose(): void {
    this.setActive(false);

    this.container?.removeEventListener("wheel", this.onWheel);
    this.container?.removeEventListener("pointerdown", this.onPointerDown);
    this.onPointerUp({ pointerId: -1 } as PointerEvent);
    this.container = null;

    this.worker?.terminate();
    this.worker = null;

    this.chart?.dispose();
    this.chart = null;

    this.held = 0;
    this.rendered = 0;
    this.inFlight = 0;
  }
}

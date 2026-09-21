import * as echarts from "echarts";

import type { Channel, TelemetryBatch } from "../gen/telemetry/v1/telemetry_pb";
import type { ViewMessage, WorkerMessage, WorkerRequest } from "../worker/protocol";
import type { RenderWindow } from "../store/viewSlice";
import type { Anomaly } from "../worker/rules";
import {
  colorFor,
  plotFraction,
  RenderTimer,
  viewerGridInsets,
  viewerOption,
  yAxes,
  type ChartRenderer,
  type ConnectionStatus,
  type RenderStats,
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

  private channels: Channel[] = [];
  private channelIds: string[] = [];
  private seriesIndex = new Map<string, number>();

  /**
   * Grid insets this chart was built with.
   *
   * Held rather than imported, because the viewer's grid is wider than the
   * baselines' now — one axis per channel instead of two shared ones — and the
   * gesture maths has to map pixels with the insets actually in use.
   */
  private insets = { left: 64, right: 64 };

  private rafHandle = 0;
  private lastRequestAt = 0;
  private nextRequestId = 1;
  /** Id of the request awaiting a reply, or 0 when idle. */
  private inFlight = 0;

  private window: RenderWindow = { kind: "live", durationMs: 600_000 };
  private gestureHandler: ((g: ViewGesture) => void) | null = null;
  private anomalyHandler: ((a: Anomaly[]) => void) | null = null;
  private anomalies: Anomaly[] = [];
  private container: HTMLDivElement | null = null;
  private dragLastX: number | null = null;

  private held = 0;
  private rendered = 0;
  private batches = 0;
  private dropped = 0;
  private perChannel: Record<string, number> = {};

  /** `null` until the app says otherwise, which the worker reads as all of them. */
  private visible: string[] | null = null;
  private statusHandler: ((status: ConnectionStatus) => void) | null = null;

  /**
   * @param backend ECharts renderer. Canvas is what ships; `svg` exists so the
   * two can be measured against each other on the same harness rather than
   * compared from first principles.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly backend: "canvas" | "svg" = "canvas",
  ) {}

  init(el: HTMLDivElement, channels: Channel[]): void {
    this.chart = echarts.init(el, undefined, { renderer: this.backend });
    // No ECharts dataZoom component. It keeps its own notion of the visible
    // range as a percentage of the data it holds, which fights with ours: we
    // replace that data with exactly the window selected, so its 0-100% shrinks
    // to the current window and zoom-out can never escape. Gestures are handled
    // here instead and reported relatively.
    this.insets = viewerGridInsets(channels.length);
    this.chart.setOption(viewerOption(channels));

    this.container = el;
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onPointerDown);

    this.channels = channels;
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

    this.report(active ? "connecting" : "idle");

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

  private report(state: ConnectionStatus["state"], message?: string): void {
    this.statusHandler?.({ state, message });
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

  onAnomalies(handler: (anomalies: Anomaly[]) => void): void {
    this.anomalyHandler = handler;
  }

  onStatus(handler: (status: ConnectionStatus) => void): void {
    this.statusHandler = handler;
  }

  /**
   * Draw only these channels.
   *
   * The list goes down in the view request rather than being applied here, so
   * the worker skips slicing and downsampling a channel nobody is looking at
   * and `pointsRendered` stays a count of points that were actually drawn.
   * Ingestion is untouched: the hidden channel's ring buffer keeps filling and
   * its rules keep firing, so ticking it back on reveals the whole history
   * rather than starting from the moment it reappeared.
   */
  setVisibleChannels(channelIds: string[]): void {
    this.visible = channelIds;
    if (!this.chart) return;

    // Colour only. Every axis keeps its range, its side and its slot, so
    // nothing on the chart moves or rescales when a channel goes away — which
    // is the entire point of the per-channel axes.
    this.timer.measure(() =>
      this.chart!.setOption({ yAxis: yAxes(this.channels, this.visible) }),
    );

    // A pinned window is served once, so without this the change would not
    // appear until something else moved the view.
    if (this.active && this.window.kind === "pinned") {
      this.inFlight = 0;
      this.requestView();
    }
  }

  /**
   * Shade the anomalies on the chart.
   *
   * Applied on its own rather than waiting for the next view, so a newly
   * detected anomaly appears immediately even on a pinned window where no view
   * is being requested.
   */
  setAnomalies(anomalies: Anomaly[]): void {
    this.anomalies = anomalies;
    if (this.chart) this.timer.measure(() => this.chart!.setOption({ series: this.markAreas() }));
  }

  /**
   * markArea entries per series, each tinted with that channel's own colour so
   * the chart says which sensor tripped without a trip to the sidebar.
   */
  private markAreas(): { markArea: unknown }[] {
    const shown = this.visible === null ? null : new Set(this.visible);

    return this.channelIds.map((id) => {
      // A band belonging to a hidden trace would shade a region of the chart
      // with nothing in it to explain the shading.
      const mine =
        shown !== null && !shown.has(id)
          ? []
          : this.anomalies.filter((a) => a.channelId === id);
      return {
        markArea: {
          silent: true,
          itemStyle: { color: colorFor(id), opacity: 0.18 },
          // Only an x range: ECharts then spans the full height of the plot,
          // which reads as "during this period" rather than "at this value".
          data: mine.map((a) => [{ xAxis: a.startMs }, { xAxis: a.endMs }]),
        },
      };
    });
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
      anchorFraction: plotFraction(
        e.clientX,
        this.container.getBoundingClientRect(),
        this.insets,
      ),
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
    const plotWidth = rect.width - this.insets.left - this.insets.right;
    if (plotWidth <= 0) return;

    const dx = e.clientX - this.dragLastX;
    this.dragLastX = e.clientX;

    // Dragging right should pull earlier data into view, so the window moves
    // backwards in time - hence the negation.
    this.gestureHandler?.({ kind: "pan", fraction: -dx / plotWidth });
  };

  private onPointerUp = (e: PointerEvent): void => {
    // Only release a capture we actually hold. releasePointerCapture throws
    // NotFoundError for an unknown pointer id, and this runs from teardown as
    // well as from a real pointerup.
    if (this.container?.hasPointerCapture?.(e.pointerId)) {
      this.container.releasePointerCapture(e.pointerId);
    }
    this.endDrag();
  };

  /** Detach drag listeners and forget the gesture. Safe to call at any time. */
  private endDrag(): void {
    this.dragLastX = null;
    this.container?.removeEventListener("pointermove", this.onPointerMove);
    this.container?.removeEventListener("pointerup", this.onPointerUp);
    this.container?.removeEventListener("pointercancel", this.onPointerUp);
  }

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
      channelIds: this.visible,
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
        this.report("streaming");
        break;
      case "error":
        console.error("telemetry worker:", msg.message);
        this.report("error", msg.message);
        // Release the slot, or the frame loop would wait forever on a reply
        // that is never coming.
        this.inFlight = 0;
        break;
      case "stats":
        // Counters keep flowing even when views fail, so the UI still shows
        // the ring buffers filling.
        this.held = msg.pointsHeld;
        this.batches = msg.batches;
        this.dropped = msg.droppedBatches;
        this.perChannel = msg.perChannel;
        this.bufferBytes = msg.bytes;
        this.anomalyHandler?.(msg.anomalies);
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
    this.dropped = msg.droppedBatches;

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

    // The view replaces every series, so the bands have to ride along or they
    // would be wiped on the next frame. Built once: markAreas() returns an entry
    // per channel, so calling it inside the map rebuilt all four every time and
    // refiltered the anomaly list sixteen times a frame instead of four.
    const bands = this.markAreas();
    const withBands = series.map((s, i) => ({ ...s, ...bands[i] }));
    this.timer.measure(() => this.chart!.setOption({ series: withBands }));
  }

  pointsHeld(): number {
    return this.held;
  }

  pointsRendered(): number {
    return this.rendered;
  }

  streamStats(): { batches: number; droppedBatches: number } {
    return { batches: this.batches, droppedBatches: this.dropped };
  }

  /** Retained samples per channel, for the channel list. */
  heldPerChannel(): Record<string, number> {
    return this.perChannel;
  }

  takeRenderStats(): RenderStats {
    return this.timer.take();
  }

  renderCount(): number {
    return this.timer.renderCount();
  }

  resize(): void {
    this.chart?.resize();
  }

  /**
   * Tear everything down.
   *
   * The detach step runs inside try/finally because it touches the DOM, and a
   * throw there previously stranded the rest: the ECharts instance stayed alive
   * on the container, so the next init found one already there and rendered
   * nothing, and the worker kept its stream open. Cleanup that can abort
   * halfway is worse than no cleanup, because it fails silently and compounds
   * on every mode switch.
   */
  dispose(): void {
    try {
      this.setActive(false);
      this.detachGestures();
    } finally {
      this.container = null;

      this.worker?.terminate();
      this.worker = null;

      this.chart?.dispose();
      this.chart = null;

      this.held = 0;
      this.rendered = 0;
      this.inFlight = 0;
      this.channels = [];
      this.gestureHandler = null;
      this.anomalyHandler = null;
      this.statusHandler = null;
      this.anomalies = [];
      this.perChannel = {};
    }
  }

  private detachGestures(): void {
    this.container?.removeEventListener("wheel", this.onWheel);
    this.container?.removeEventListener("pointerdown", this.onPointerDown);
    this.endDrag();
  }
}

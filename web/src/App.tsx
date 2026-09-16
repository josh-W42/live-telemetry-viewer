import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { Tooltip } from "radix-ui";

import { telemetryClient } from "./client";
import type { Channel } from "./gen/telemetry/v1/telemetry_pb";
import {
  BenchRun,
  defaultStopConfig,
  FrameMeter,
  type RenderMode,
  type RunResult,
} from "./bench/metrics";
import { downloadReport, summarize, type Summary } from "./bench/report";
import { droppedSince } from "./lib/sequence";
import { AppendRenderer } from "./render/append";
import { NaiveRenderer } from "./render/naive";
import { WorkerRenderer } from "./render/worker";
import type { ChartRenderer, ConnectionStatus } from "./render/types";
import { useAppDispatch, useAppSelector } from "./store";
import {
  jumpToLive,
  pause,
  RETENTION_MS,
  selectRenderWindow,
  panBy,
  setWindowSize,
  zoomBy,
  zoomTo,
} from "./store/viewSlice";
import { selectVisibleChannelIds, toggleChannel } from "./store/channelsSlice";
import { selectAnomaliesNewestFirst, setAnomalies } from "./store/anomaliesSlice";
import type { Anomaly } from "./worker/rules";
import { AnomalySidebar } from "./components/AnomalySidebar";
import { BenchPanel } from "./components/BenchPanel";
import { ChannelList } from "./components/ChannelList";
import { StatusBar } from "./components/StatusBar";
import { ViewControls } from "./components/ViewControls";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

function makeRenderer(mode: RenderMode): ChartRenderer {
  switch (mode) {
    case "append":
      return new AppendRenderer();
    case "worker":
      return new WorkerRenderer(API_URL);
    case "worker-svg":
      return new WorkerRenderer(API_URL, "svg");
    default:
      return new NaiveRenderer();
  }
}

/** True for the two renderers that are the actual product. */
function isWorkerMode(mode: RenderMode): boolean {
  return mode === "worker" || mode === "worker-svg";
}

/**
 * The viewer.
 *
 * This component owns the wiring — the stream, the renderer's lifetime, and the
 * round trip from a gesture through the store and back to the chart — and none
 * of the markup. That split is deliberate: the renderer lifecycle is where the
 * dispose-and-blank-screen bug lived, so it stays in one place with its
 * reasoning attached, while everything presentational moved to components/.
 */
export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>({ state: "connecting" });
  const [mode, setMode] = useState<RenderMode>("worker");

  // The scripted handle below hands out closures. A caller that grabs
  // window.__telemetryBench before setMode has re-rendered would otherwise start a
  // run in the *previous* mode — measuring one renderer while believing it
  // measured another. Reading the mode from a ref at call time removes the
  // window in which that can happen.
  const modeRef = useRef<RenderMode>(mode);
  modeRef.current = mode;

  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [live, setLive] = useState({
    pointsHeld: 0,
    pointsRendered: 0,
    droppedBatches: 0,
    fps: 0,
    heapMB: null as number | null,
    bufferBytes: 0,
    perChannel: {} as Record<string, number>,
  });

  const chartEl = useRef<HTMLDivElement>(null);
  const renderer = useRef<ChartRenderer | null>(null);
  const run = useRef<BenchRun | null>(null);

  // Stream counters live in refs: at 20 batches/sec, routing them through state
  // would re-render far faster than anyone can read.
  const counters = useRef({ batches: 0, droppedBatches: 0, lastSequence: 0n });

  // Whether incoming batches reach a *baseline* renderer.
  //
  // Feeding a naive renderer continuously would degrade the page to
  // unusability within minutes, and would leave each run starting from whatever
  // mess the last one left. Mode C has no such problem, which is why the viewer
  // simply streams.
  const feeding = useRef(false);
  const [previewWhenIdle, setPreviewWhenIdle] = useState(false);

  /** The viewer's own connect/disconnect. Worker modes only. */
  const [connected, setConnected] = useState(true);

  const dispatch = useAppDispatch();
  const view = useAppSelector((s) => s.view);
  const renderWindow = selectRenderWindow(view);
  const isLive = view.window.kind === "live";

  const channelsState = useAppSelector((s) => s.channels);
  const allChannelIds = useMemo(() => channels.map((c) => c.id), [channels]);
  const visibleChannelIds = useMemo(
    () => selectVisibleChannelIds(channelsState, allChannelIds),
    [channelsState, allChannelIds],
  );

  const anomaliesState = useAppSelector((s) => s.anomalies);
  const anomalies = anomaliesState.items;
  const anomalyList = selectAnomaliesNewestFirst(anomaliesState);

  // Switching away from the tab must tear the stream down immediately.
  //
  // Waiting for the per-sample visibility check does not work: the sampler is a
  // main-thread setInterval, which browsers throttle to roughly once a minute in
  // a background tab and may freeze outright. A worker is throttled even less,
  // so the ring buffers would keep filling at the full 4,000 samples a second
  // while nobody is watching. Reacting to the event closes that window.
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" || !document.hidden,
  );

  useEffect(() => {
    const onVisibility = () => {
      const visible = !document.hidden;
      setPageVisible(visible);

      // A run that spans a tab switch has not measured a slow renderer, it has
      // measured a tab nobody was looking at.
      if (!visible && run.current?.status === "running") {
        run.current.invalidate("the tab was switched away during the run");
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Nothing streams unless something is consuming, and only while the tab is
  // actually on screen. For the viewer that means the connect toggle; for the
  // baselines, an explicit opt-in or a benchmark run.
  const wantsStream = isWorkerMode(mode) ? connected : previewWhenIdle;
  const active = (running || wantsStream) && pageVisible;

  // --- channel metadata ---------------------------------------------------
  // Cheap unary call, needed by every mode to lay out the chart.
  useEffect(() => {
    const abort = new AbortController();
    telemetryClient
      .listChannels({}, { signal: abort.signal })
      .then((res) => setChannels(res.channels))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setConnection({ state: "error", message: ConnectError.from(err).message });
      });
    return () => abort.abort();
  }, []);

  // --- main-thread stream (baselines only) --------------------------------
  //
  // A worker-backed renderer opens its own stream. If this one stayed open
  // alongside it, the main thread would still be deserialising twenty batches a
  // second, which is exactly the cost mode C exists to remove — and the
  // measurement would be worthless.
  useEffect(() => {
    if (isWorkerMode(mode)) return; // the renderer reports its own state

    if (!active) {
      setConnection({ state: "idle" });
      return;
    }

    const abort = new AbortController();

    void (async () => {
      try {
        const stream = telemetryClient.streamTelemetry({}, { signal: abort.signal });
        setConnection({ state: "streaming" });

        for await (const batch of stream) {
          const c = counters.current;
          c.droppedBatches += droppedSince(c.lastSequence, batch.sequence);
          c.lastSequence = batch.sequence;
          c.batches += 1;

          if (!feeding.current) continue;
          const r = renderer.current;
          if (!r || r.ownsDataSource) continue;

          // Renderers time their own work now, so there is no stopwatch here.
          r.push(batch);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setConnection({ state: "error", message: ConnectError.from(err).message });
      }
    })();

    return () => abort.abort();
  }, [mode, active]);

  /**
   * Attach the callbacks a renderer reports through.
   *
   * Done at construction rather than in a later effect because effects run in
   * declaration order: the one that calls `setActive` would otherwise fire
   * first, and the renderer's opening status would be reported to nobody.
   */
  const attach = useCallback(
    (r: ChartRenderer) => {
      r.onStatus(setConnection);
      r.onAnomalies((list) => dispatch(setAnomalies(list)));
      r.onGesture((g) => {
        const at = { nowMs: Date.now(), retentionMs: RETENTION_MS };
        dispatch(
          g.kind === "zoom"
            ? zoomBy({ ...at, factor: g.factor, anchorFraction: g.anchorFraction })
            : panBy({ ...at, fraction: g.fraction }),
        );
      });
    },
    [dispatch],
  );

  // --- renderer lifecycle -------------------------------------------------
  useEffect(() => {
    if (!chartEl.current || channels.length === 0) return;

    const r = makeRenderer(mode);
    r.init(chartEl.current, channels);
    attach(r);
    renderer.current = r;

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      renderer.current = null;
      r.dispose();
    };
  }, [mode, channels, attach]);

  // Renderers that own a stream start and stop with `active`. Declared after
  // the lifecycle effect above so a mode switch creates the renderer first and
  // then sets its state.
  useEffect(() => {
    renderer.current?.setActive(active);
  }, [active, mode, channels]);

  // Push the window down. The renderer reports what the user did; the store
  // decides what it means. That is what makes "zooming while live pauses" a
  // single reducer transition rather than two effects racing each other.
  useEffect(() => {
    renderer.current?.setWindow(renderWindow);
  }, [renderWindow, mode, channels]);

  // Anomalies make the same round trip as the window: the worker reports them,
  // the store owns them, and the renderer draws whatever the store holds. That
  // is what keeps the sidebar and the chart from ever disagreeing.
  useEffect(() => {
    renderer.current?.setAnomalies(anomalies);
  }, [anomalies, mode, channels]);

  useEffect(() => {
    renderer.current?.setVisibleChannels(visibleChannelIds);
  }, [visibleChannelIds, mode, channels]);

  // --- continuous frame rate ----------------------------------------------
  //
  // The status bar needs fps whether or not a benchmark is running, and this is
  // the only thing that measures it outside a run.
  const frames = useRef(new FrameMeter());
  useEffect(() => {
    const meter = frames.current;
    if (active) meter.start();
    else meter.stop();
    return () => meter.stop();
  }, [active]);

  // --- live readout -------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const r = renderer.current;
      setLive({
        pointsHeld: r?.pointsHeld() ?? 0,
        pointsRendered: r?.pointsRendered() ?? 0,
        droppedBatches: r?.streamStats?.().droppedBatches ?? counters.current.droppedBatches,
        fps: frames.current.fps(),
        heapMB: readHeap(),
        bufferBytes: (r as WorkerRenderer | null)?.bufferBytes ?? 0,
        perChannel: r?.heldPerChannel?.() ?? {},
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  /** Jump the view to an anomaly, padded so a 30ms spike lands in context. */
  const showAnomaly = useCallback(
    (a: Anomaly) => {
      const pad = Math.max((a.endMs - a.startMs) * 0.2, 200);
      dispatch(
        zoomTo({
          startMs: a.startMs - pad,
          endMs: a.endMs + pad,
          nowMs: Date.now(),
          retentionMs: RETENTION_MS,
        }),
      );
    },
    [dispatch],
  );

  // Preview follows the checkbox whenever a run is not driving it.
  useEffect(() => {
    if (!running) feeding.current = previewWhenIdle;
  }, [previewWhenIdle, running]);

  const stopBench = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.stop();
    feeding.current = previewWhenIdle;
    setSummary(summarize(r.result()));
    setRunning(false);
  }, [previewWhenIdle]);

  const startBench = useCallback(
    (durationMs: number) => {
      if (run.current) run.current.stop();

      // Restart the renderer so each run begins from an empty chart.
      if (chartEl.current && channels.length > 0) {
        renderer.current?.dispose();
        const fresh = makeRenderer(modeRef.current);
        fresh.init(chartEl.current, channels);
        attach(fresh);
        fresh.setVisibleChannels(visibleChannelIds);
        // Activated here rather than waiting for the effect below to fire on
        // the next render, so the stream is open before the first sample.
        fresh.setActive(true);
        renderer.current = fresh;
      }
      counters.current = { batches: 0, droppedBatches: 0, lastSequence: 0n };
      renderer.current?.takeRenderStats(); // discard anything accumulated while idle

      const bench = new BenchRun(
        modeRef.current,
        {
          pointsHeld: () => renderer.current?.pointsHeld() ?? 0,
          pointsRendered: () => renderer.current?.pointsRendered() ?? 0,
          // A worker-backed renderer counts its own batches, since they never
          // reach this thread.
          batches: () => renderer.current?.streamStats?.().batches ?? counters.current.batches,
          droppedBatches: () =>
            renderer.current?.streamStats?.().droppedBatches ??
            counters.current.droppedBatches,
          takePushStats: () =>
            renderer.current?.takeRenderStats() ?? { totalMs: 0, maxMs: 0 },
        },
        { ...defaultStopConfig, durationMs },
        (r) => {
          if (r.status !== "running") {
            feeding.current = previewWhenIdle;
            setSummary(summarize(r.result()));
            setRunning(false);
          }
        },
      );

      run.current = bench;
      setSummary(null);
      setRunning(true);
      feeding.current = true;
      bench.start();

      // start() refuses to run in a hidden tab; reflect that immediately.
      if (bench.status !== "running") {
        feeding.current = previewWhenIdle;
        setSummary(summarize(bench.result()));
        setRunning(false);
      }
    },
    [channels, previewWhenIdle, attach, visibleChannelIds],
  );

  // Expose the harness so results can be captured by script rather than
  // transcribed from the screen.
  useEffect(() => {
    const handle = {
      start: (durationMs = defaultStopConfig.durationMs) => startBench(durationMs),
      stop: stopBench,
      setMode: (m: RenderMode) => setMode(m),
      status: () => run.current?.status ?? "idle",
      result: (): RunResult | null => run.current?.result() ?? null,
      summary: () => (run.current ? summarize(run.current.result()) : null),
    };
    (window as unknown as { __telemetryBench: typeof handle }).__telemetryBench = handle;
  }, [startBench, stopBench]);

  // The current window, for scripted checks. Cheap, and the same affordance as
  // __telemetryBench: it beats inferring the view state from pixels.
  useEffect(() => {
    const spanMs =
      view.window.kind === "pinned"
        ? view.window.endMs - view.window.startMs
        : view.durationMs;
    (window as unknown as { __telemetryView: unknown }).__telemetryView = {
      ...view,
      spanMs,
      visibleChannelIds,
    };
  }, [view, visibleChannelIds]);

  const workerMode = isWorkerMode(mode);

  return (
    <Tooltip.Provider delayDuration={200}>
      <main className="app">
        <header className="app-header">
          <h1 className="app-title">Live telemetry viewer</h1>
          <span className="app-subtitle">
            4 channels @ 1 kHz · 10 minutes retained
            {connection.state === "error" && ` · ${connection.message ?? "error"}`}
          </span>

          {workerMode && (
            <button
              type="button"
              className="btn"
              style={{ marginLeft: "auto" }}
              data-variant={connected ? undefined : "primary"}
              onClick={() => setConnected((c) => !c)}
            >
              {connected ? "Disconnect" : "Connect"}
            </button>
          )}
        </header>

        <StatusBar
          connection={connection}
          pointsHeld={live.pointsHeld}
          pointsRendered={live.pointsRendered}
          fps={live.fps}
          droppedBatches={live.droppedBatches}
          heapMB={live.heapMB}
          bufferBytes={live.bufferBytes}
        />

        {/* Interaction is worker-mode only: the M2 baselines are frozen
            references whose numbers must stay comparable to NOTES.md. */}
        {workerMode && (
          <ViewControls
            isLive={isLive}
            durationMs={view.durationMs}
            onPause={() => dispatch(pause({ nowMs: Date.now() }))}
            onResume={() => dispatch(jumpToLive())}
            onWindowSize={(ms) => dispatch(setWindowSize(ms))}
          />
        )}

        <div className="chart-row">
          <div ref={chartEl} className="chart" />

          {workerMode && (
            <div className="side">
              <ChannelList
                channels={channels}
                visible={visibleChannelIds}
                heldPerChannel={live.perChannel}
                onToggle={(id) => dispatch(toggleChannel(id))}
              />
              <AnomalySidebar anomalies={anomalyList} onShow={showAnomaly} />
            </div>
          )}
        </div>

        <BenchPanel
          mode={mode}
          onModeChange={setMode}
          running={running}
          onRun={startBench}
          onStop={stopBench}
          onDownload={() => run.current && downloadReport(run.current.result())}
          hasResult={run.current !== null}
          summary={summary}
          previewWhenIdle={previewWhenIdle}
          onPreviewChange={setPreviewWhenIdle}
        />
      </main>
    </Tooltip.Provider>
  );
}

/** Non-standard and Chromium-only; the status bar shows a dash without it. */
function readHeap(): number | null {
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return typeof mem?.usedJSHeapSize === "number" ? mem.usedJSHeapSize / 1048576 : null;
}

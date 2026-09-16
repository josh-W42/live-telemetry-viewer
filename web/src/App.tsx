import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";

import { telemetryClient } from "./client";
import type { Channel } from "./gen/telemetry/v1/telemetry_pb";
import {
  BenchRun,
  defaultStopConfig,
  type RenderMode,
  type RunResult,
} from "./bench/metrics";
import { downloadReport, summarize, type Summary } from "./bench/report";
import { AppendRenderer } from "./render/append";
import { NaiveRenderer } from "./render/naive";
import type { ChartRenderer } from "./render/types";

type Connection = "connecting" | "streaming" | "error";

const modes: { id: RenderMode; label: string; blurb: string }[] = [
  { id: "naive", label: "A · naive setOption", blurb: "Whole dataset re-sent every batch" },
  { id: "append", label: "B · appendData", blurb: "Only new points, axis moved 1×/s" },
];

function makeRenderer(mode: RenderMode): ChartRenderer {
  return mode === "append" ? new AppendRenderer() : new NaiveRenderer();
}

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RenderMode>("naive");
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [live, setLive] = useState({ batches: 0, gaps: 0, pointsHeld: 0, fps: 0, heapMB: 0 });

  const chartEl = useRef<HTMLDivElement>(null);
  const renderer = useRef<ChartRenderer | null>(null);
  const run = useRef<BenchRun | null>(null);

  // Stream counters live in refs: at 20 batches/sec, routing them through state
  // would re-render far faster than anyone can read.
  const counters = useRef({ batches: 0, gaps: 0, lastSequence: 0n });
  const pushStats = useRef({ totalMs: 0, maxMs: 0 });

  // Whether incoming batches reach the renderer at all.
  //
  // Feeding a naive renderer continuously would degrade the page to
  // unusability within minutes even when nobody is benchmarking, and would
  // leave each run starting from whatever mess the last one left. Data flows
  // only during a run, or when preview is deliberately switched on.
  const feeding = useRef(false);
  const [preview, setPreview] = useState(false);

  // --- stream ------------------------------------------------------------
  useEffect(() => {
    const abort = new AbortController();

    telemetryClient
      .listChannels({}, { signal: abort.signal })
      .then((res) => setChannels(res.channels))
      .catch(() => {
        /* the stream below reports connection problems */
      });

    void (async () => {
      try {
        const stream = telemetryClient.streamTelemetry({}, { signal: abort.signal });
        setConnection("streaming");

        for await (const batch of stream) {
          const c = counters.current;
          if (c.lastSequence !== 0n && batch.sequence !== c.lastSequence + 1n) c.gaps += 1;
          c.lastSequence = batch.sequence;
          c.batches += 1;

          if (!feeding.current) continue;

          // A plain stopwatch around the renderer. This is the measurement that
          // matters most, and unlike fps it does not depend on the window being
          // in the foreground.
          const t0 = performance.now();
          renderer.current?.push(batch);
          const elapsed = performance.now() - t0;
          pushStats.current.totalMs += elapsed;
          pushStats.current.maxMs = Math.max(pushStats.current.maxMs, elapsed);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setConnection("error");
        setError(ConnectError.from(err).message);
      }
    })();

    return () => abort.abort();
  }, []);

  // --- renderer lifecycle -------------------------------------------------
  useEffect(() => {
    if (!chartEl.current || channels.length === 0) return;

    const r = makeRenderer(mode);
    r.init(chartEl.current, channels);
    renderer.current = r;

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      renderer.current = null;
      r.dispose();
    };
  }, [mode, channels]);

  // --- live readout -------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const latest = run.current?.samples.at(-1);
      setLive({
        batches: counters.current.batches,
        gaps: counters.current.gaps,
        pointsHeld: renderer.current?.pointsHeld() ?? 0,
        fps: Math.round(latest?.fps ?? 0),
        heapMB: Math.round(latest?.heapMB ?? 0),
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Preview follows the checkbox whenever a run is not driving it.
  useEffect(() => {
    if (!running) feeding.current = preview;
  }, [preview, running]);

  const stopBench = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.stop();
    feeding.current = preview;
    setSummary(summarize(r.result()));
    setRunning(false);
  }, [preview]);

  const startBench = useCallback(
    (durationMs: number) => {
      if (run.current) run.current.stop();

      // Restart the renderer so each run begins from an empty chart.
      if (chartEl.current && channels.length > 0) {
        renderer.current?.dispose();
        const fresh = makeRenderer(mode);
        fresh.init(chartEl.current, channels);
        renderer.current = fresh;
      }
      counters.current = { batches: 0, gaps: 0, lastSequence: 0n };
      pushStats.current = { totalMs: 0, maxMs: 0 };

      const bench = new BenchRun(
        mode,
        {
          pointsHeld: () => renderer.current?.pointsHeld() ?? 0,
          pointsRendered: () => renderer.current?.pointsRendered() ?? 0,
          batches: () => counters.current.batches,
          gaps: () => counters.current.gaps,
          takePushStats: () => {
            const out = { ...pushStats.current };
            pushStats.current = { totalMs: 0, maxMs: 0 };
            return out;
          },
        },
        { ...defaultStopConfig, durationMs },
        (r) => {
          if (r.status !== "running") {
            feeding.current = preview;
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
        feeding.current = preview;
        setSummary(summarize(bench.result()));
        setRunning(false);
      }
    },
    [mode, channels, preview],
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

  const busy = running;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>M2 naive chart</h1>
        <span style={styles.dim}>
          {connection === "streaming" ? "streaming" : connection}
          {connection === "error" && `: ${error}`}
        </span>
      </header>

      <section style={styles.controls}>
        <div style={styles.modes}>
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              disabled={busy}
              title={m.blurb}
              style={{ ...styles.modeBtn, ...(mode === m.id ? styles.modeBtnOn : {}) }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div style={styles.runBtns}>
          <button onClick={() => startBench(60_000)} disabled={busy} style={styles.btn}>
            Run 1 min
          </button>
          <button onClick={() => startBench(600_000)} disabled={busy} style={styles.btn}>
            Run 10 min
          </button>
          <button onClick={stopBench} disabled={!busy} style={styles.btn}>
            Stop
          </button>
          <button
            onClick={() => run.current && downloadReport(run.current.result())}
            disabled={!run.current}
            style={styles.btn}
          >
            Download JSON
          </button>
        </div>

        <label style={styles.dim}>
          <input
            type="checkbox"
            checked={preview}
            disabled={busy}
            onChange={(e) => setPreview(e.target.checked)}
          />{" "}
          live preview when idle
        </label>
      </section>

      <section style={styles.stats}>
        <Stat label="mode" value={mode} />
        <Stat label="fps" value={String(live.fps)} warn={running && live.fps > 0 && live.fps < 20} />
        <Stat label="heap MB" value={String(live.heapMB)} />
        <Stat label="points held" value={live.pointsHeld.toLocaleString()} />
        <Stat label="batches" value={live.batches.toLocaleString()} />
        <Stat label="gaps" value={String(live.gaps)} warn={live.gaps > 0} />
      </section>

      <div ref={chartEl} style={styles.chart} />

      {summary && (
        <section style={styles.summary}>
          <strong>
            {summary.mode} — {summary.status}
            {summary.reason ? `: ${summary.reason}` : ""}
          </strong>
          <pre style={styles.pre}>{JSON.stringify(summary, null, 2)}</pre>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: warn ? "#b45309" : "#111" }}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "1.25rem",
    lineHeight: 1.5,
  },
  header: { display: "flex", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" },
  h1: { fontSize: "1rem", margin: 0 },
  controls: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap",
    margin: "0.75rem 0",
    alignItems: "center",
  },
  modes: { display: "flex", gap: "0.25rem" },
  runBtns: { display: "flex", gap: "0.25rem" },
  modeBtn: {
    font: "inherit",
    fontSize: "0.75rem",
    padding: "0.3rem 0.6rem",
    border: "1px solid #ccc",
    background: "#fff",
    borderRadius: 4,
    cursor: "pointer",
  },
  modeBtnOn: { background: "#111", color: "#fff", borderColor: "#111" },
  btn: {
    font: "inherit",
    fontSize: "0.75rem",
    padding: "0.3rem 0.6rem",
    border: "1px solid #ccc",
    background: "#fff",
    borderRadius: 4,
    cursor: "pointer",
  },
  stats: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  stat: { border: "1px solid #e5e5e5", borderRadius: 6, padding: "0.35rem 0.6rem" },
  statLabel: { fontSize: "0.65rem", textTransform: "uppercase", color: "#666" },
  statValue: { fontSize: "1rem", fontVariantNumeric: "tabular-nums" },
  chart: { width: "100%", height: "26rem", border: "1px solid #e5e5e5", borderRadius: 6 },
  summary: { marginTop: "0.75rem", fontSize: "0.75rem" },
  pre: { background: "#fafafa", padding: "0.6rem", borderRadius: 6, overflowX: "auto" },
  dim: { color: "#666", fontSize: "0.8rem" },
};

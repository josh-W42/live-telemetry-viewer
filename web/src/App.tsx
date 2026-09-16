import { useEffect, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";

import { telemetryClient } from "./client";
import type { Channel } from "./gen/telemetry/v1/telemetry_pb";

type Connection = "connecting" | "streaming" | "error";

interface Stats {
  batches: number;
  samples: number;
  lastSequence: bigint;
  gaps: number;
  droppedBatches: number;
}

const zeroStats: Stats = {
  batches: 0,
  samples: 0,
  lastSequence: 0n,
  gaps: 0,
  droppedBatches: 0,
};

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats>(zeroStats);

  // Counters live in a ref and are flushed to state on an interval. Setting
  // state per batch would re-render 20x a second for numbers a human cannot
  // read that fast. M3 applies the same idea to the chart itself.
  const pending = useRef<Stats>({ ...zeroStats });

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
          const p = pending.current;

          // A gap means the server dropped batches for this client because it
          // could not keep up. That is the sequence field earning its place.
          if (p.lastSequence !== 0n && batch.sequence !== p.lastSequence + 1n) {
            p.gaps += 1;
            p.droppedBatches += Number(batch.sequence - p.lastSequence - 1n);
          }
          p.lastSequence = batch.sequence;
          p.batches += 1;
          for (const ch of batch.channels) {
            p.samples += ch.values.length;
          }

          // M1 logs rather than charts. M2 is where this data goes into
          // ECharts on the main thread and is meant to fall over.
          console.debug("batch", batch.sequence, {
            channels: batch.channels.map((c) => `${c.channelId}:${c.values.length}`),
          });
        }

        if (!abort.signal.aborted) {
          setConnection("error");
          setError("stream ended");
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setConnection("error");
        setError(ConnectError.from(err).message);
      }
    })();

    const flush = setInterval(() => setStats({ ...pending.current }), 250);

    return () => {
      abort.abort();
      clearInterval(flush);
    };
  }, []);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>M1 stream</h1>

      <section style={styles.grid}>
        <Stat label="connection" value={connection} />
        <Stat label="batches" value={stats.batches.toLocaleString()} />
        <Stat label="samples" value={stats.samples.toLocaleString()} />
        <Stat label="last sequence" value={stats.lastSequence.toString()} />
        <Stat label="gaps" value={stats.gaps.toLocaleString()} warn={stats.gaps > 0} />
        <Stat
          label="batches dropped"
          value={stats.droppedBatches.toLocaleString()}
          warn={stats.droppedBatches > 0}
        />
      </section>

      {connection === "error" && <p style={styles.error}>{error}</p>}

      <h2 style={styles.h2}>Channels</h2>
      {channels.length === 0 ? (
        <p style={styles.dim}>none yet</p>
      ) : (
        <ul style={styles.list}>
          {channels.map((c) => (
            <li key={c.id}>
              {c.name} <span style={styles.dim}>({c.unit})</span> @ {c.sampleRateHz} Hz
            </li>
          ))}
        </ul>
      )}

      <p style={styles.dim}>
        Batches are logged to the console at debug level. Gaps appear when the server drops
        batches for this client — background the tab or throttle the CPU in DevTools to see it.
      </p>
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
    padding: "2rem",
    lineHeight: 1.6,
    maxWidth: "48rem",
  },
  h1: { fontSize: "1.1rem", marginBottom: "1rem" },
  h2: { fontSize: "0.9rem", marginTop: "1.5rem", marginBottom: "0.25rem" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
    gap: "0.75rem",
  },
  stat: { border: "1px solid #e5e5e5", borderRadius: 6, padding: "0.5rem 0.75rem" },
  statLabel: { fontSize: "0.7rem", textTransform: "uppercase", color: "#666" },
  statValue: { fontSize: "1.1rem", fontVariantNumeric: "tabular-nums" },
  list: { margin: 0, paddingLeft: "1.2rem" },
  dim: { color: "#666", fontSize: "0.8rem" },
  error: { color: "#b91c1c" },
};

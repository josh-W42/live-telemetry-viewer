import { useEffect, useState } from "react";
import { ConnectError } from "@connectrpc/connect";

import { telemetryClient } from "./client";
import type { Channel } from "./gen/telemetry/v1/telemetry_pb";

type State =
  | { status: "loading" }
  | { status: "ok"; channels: Channel[] }
  | { status: "error"; code: string; message: string };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const abort = new AbortController();

    telemetryClient
      .listChannels({}, { signal: abort.signal })
      .then((res) => setState({ status: "ok", channels: res.channels }))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        const ce = ConnectError.from(err);
        setState({ status: "error", code: ConnectError.name, message: ce.message });
      });

    return () => abort.abort();
  }, []);

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: "2rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.1rem" }}>M0 scaffold</h1>

      {state.status === "loading" && <p>Calling ListChannels…</p>}

      {state.status === "ok" && (
        <ul>
          {state.channels.map((c) => (
            <li key={c.id}>
              {c.name} ({c.unit}) @ {c.sampleRateHz} Hz
            </li>
          ))}
        </ul>
      )}

      {state.status === "error" && (
        <>
          <p>
            <strong>{state.message}</strong>
          </p>
          <p style={{ opacity: 0.7 }}>
            In M0 this is the expected result. A structured Connect error that crossed the
            wire proves codegen, transport and CORS all work. M1 implements the method.
          </p>
        </>
      )}
    </main>
  );
}

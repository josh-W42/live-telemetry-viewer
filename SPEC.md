# Live Telemetry Viewer — Project Spec

A learning project that mirrors the core of a production telemetry platform: a Go service that streams high-frequency sensor data over gRPC/Connect, and a React + TypeScript app that plots it live with ECharts while staying smooth at millions of points.

## Goals

- Stream simulated rocket-engine test-stand telemetry (4 channels at 1,000 Hz each) from Go to the browser.
- Plot it live, with pause, zoom, and pan, and keep the UI responsive with 10+ minutes of retained data (~2.4M points total).
- Flag anomalies with simple threshold rules and show them on the chart.
- Learn the tradeoffs well enough to explain them in an interview.

## Non-goals (for now)

- Persistence or historical queries. That is Project 2 (Parquet + DataFusion/DuckDB).
- Auth, multi-user support, and deployment.
- Pixel-perfect design.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Go 1.22+ | Matches the production stack being mirrored |
| API | Protobuf + `connect-go` (connectrpc.com) | gRPC-compatible, and browsers can consume server streams without a proxy |
| Codegen | `buf` | Standard tooling for proto lint and generation |
| Frontend | Vite + React + TypeScript | Fast dev loop (Next.js isn't needed here) |
| Client RPC | `@connectrpc/connect` + `@connectrpc/connect-web` | Typed client generated from the same proto |
| Charts | Apache ECharts (canvas renderer) | On the stack being mirrored |
| UI state | Redux Toolkit | On the stack being mirrored; holds UI state only, never raw samples |
| UI primitives | Radix UI | On the stack being mirrored |
| Tests | Go `testing`, Vitest | |

## Repo layout

```
telemetry-viewer/
├── proto/telemetry/v1/telemetry.proto
├── buf.yaml / buf.gen.yaml
├── server/
│   ├── cmd/server/main.go
│   ├── internal/sim/        # engine test simulator
│   ├── internal/stream/     # Connect service implementation
│   └── gen/                 # generated Go code
└── web/
    ├── src/gen/             # generated TS code
    ├── src/worker/          # data worker: ring buffers, LTTB, rules
    ├── src/components/      # chart, controls, channel list
    ├── src/store/           # Redux slices (UI state only)
    └── src/lib/lttb.ts      # downsampling (written by hand, see below)
```

## API (proto)

```proto
syntax = "proto3";
package telemetry.v1;

service TelemetryService {
  rpc ListChannels(ListChannelsRequest) returns (ListChannelsResponse);
  rpc StreamTelemetry(StreamTelemetryRequest) returns (stream TelemetryBatch);
}

message Channel {
  string id = 1;          // "chamber_pressure"
  string name = 2;        // "Chamber Pressure"
  string unit = 3;        // "psi"
  double sample_rate_hz = 4;
}

message ListChannelsRequest {}
message ListChannelsResponse { repeated Channel channels = 1; }

message StreamTelemetryRequest {
  repeated string channel_ids = 1; // empty = all channels
}

// Samples are batched (~every 50ms) instead of sent one per message.
// Parallel arrays (packed repeated fields) keep the wire format compact.
message ChannelSamples {
  string channel_id = 1;
  repeated int64 timestamps_ns = 2;
  repeated double values = 3;
}

message TelemetryBatch {
  repeated ChannelSamples channels = 1;
  uint64 sequence = 2; // lets the client detect gaps
}
```

## Backend

### Simulator (`internal/sim`)

- Four channels: `chamber_pressure` (psi), `chamber_temp` (K), `vibration` (g), `fuel_flow` (kg/s).
- Models a looping test sequence: **idle → chill-down → ignition → steady-state → shutdown → idle**, each phase a few tens of seconds. Values follow realistic shapes, such as a pressure ramp at ignition, a plateau with noise, and a decay at shutdown.
- Adds Gaussian noise, plus a high-frequency sinusoid on `vibration`.
- Injects occasional anomalies (for example, a 30–100ms pressure spike during steady state) so the rules engine has something to catch.
- Uses a configurable seed so runs are reproducible.
- Generates samples using wall-clock time, with timestamps in nanoseconds.

### Stream service (`internal/stream`)

- Serves `ListChannels` and `StreamTelemetry` using `connect-go`.
- One simulator feeds a fan-out broadcaster, so multiple browser tabs see the same data.
- Each subscriber gets a buffered channel. If a slow client falls behind, drop its oldest batches and keep going; never block the simulator. The `sequence` field makes the drops visible.
- Flushes a batch every 50ms.
- CORS is configured for the Vite dev server (`connectrpc.com/cors`).
- Logs subscriber count and dropped-batch count.

### Server config (flags)

`--port` (default 8080), `--rate` (Hz per channel, default 1000), `--seed`, `--batch-interval` (default 50ms).

## Frontend

### Data flow (the important part)

```
Connect stream ──► Web Worker ──► (downsampled view) ──► main thread ──► ECharts
                     │
                     ├─ per-channel ring buffers (Float64Array)
                     ├─ LTTB downsampling per visible window
                     └─ anomaly rule evaluation
```

- **The stream is consumed inside a Web Worker**, not on the main thread. Raw samples never enter React state or Redux.
- **Ring buffers.** Each channel has a fixed-capacity buffer: 10 minutes × rate, stored as two `Float64Array`s (timestamps and values). Memory stays bounded no matter how long the app runs.
- **View requests.** The main thread sends `{ channelIds, startNs, endNs, widthPx }`. The worker slices the buffer by time using binary search, runs LTTB down to about `2 × widthPx` points, and posts the result back. Use transferable `ArrayBuffer`s to avoid copying.
- **Render loop.** In live mode, request a new view on `requestAnimationFrame`, throttled to about 30 fps, rather than on every incoming batch.

### UI

- A channel list with checkboxes to toggle channels.
- One chart panel with a shared time axis. Use either stacked grids or one grid with multiple y-axes, whichever reads better.
- Controls:
  - **Live / Paused** toggle. Pausing freezes the view while ingestion continues.
  - **Window size** selector: 5s / 30s / 2m / 10m.
  - **Zoom and pan** with the mouse wheel and drag (ECharts `dataZoom`). Zooming in while live automatically pauses.
  - **Jump to live** button.
- A status bar showing connection state, points held, points rendered, render fps, and dropped batches.
- Anomaly markers drawn as shaded regions (`markArea`), plus a sidebar list. Clicking an anomaly jumps the view to it.

### Anomaly rules

- Rule shape: `{ channelId, op: ">" | "<", threshold, minDurationMs }`
- Example: `chamber_pressure > 1100 for ≥ 20ms`
- Evaluated incrementally in the worker as samples arrive; each anomaly is emitted once with its start and end times.
- Rules are hardcoded at first. A small form for adding them is a stretch goal.

## Milestones

Build these in order. Each milestone should run end to end before moving on.

1. **M0: Scaffold.** Set up the repo, buf config, and codegen for Go and TS, plus a `Makefile` or `justfile` with `gen`, `server`, `web`, and `test` targets.
2. **M1: Stream to console.** Get the simulator and stream service working, and have the browser log batches.
3. **M2: Naive chart.** Push every sample straight into ECharts on the main thread. **Deliberately let it break**, then record at what point fps drops and memory climbs. Save those numbers.
4. **M3: Worker + ring buffers + LTTB.** Move to the architecture above, then measure again against the M2 numbers.
5. **M4: Interaction.** Add pause, window sizes, zoom and pan, and jump to live.
6. **M5: Anomaly rules** and markers.
7. **M6: Polish and write-up.** Add the status bar metrics and write a `NOTES.md` covering the design decisions and before/after performance numbers.

## Acceptance criteria

- 4 channels at 1,000 Hz stream continuously for 15+ minutes without the tab's memory growing unbounded.
- With a 10-minute window visible, the UI stays interactive (target ~30+ fps, no multi-second freezes).
- LTTB has unit tests covering: output length, preserved first and last points, a spike surviving downsampling, and empty or tiny inputs.
- The simulator has a test showing the same seed produces the same output.
- The broadcaster has a test showing a slow subscriber doesn't block others.
- `NOTES.md` includes the M2 vs. M3 measurements.

## Instructions for Claude Code

This is a **learning project for interview prep**, so optimize for my understanding, not just working code.

- Start each milestone in plan mode and propose the design before writing code. Call out any decision where there's a real tradeoff and let me choose.
- When introducing something I may not know (Connect streaming, transferables, `markArea`, packed repeated fields), explain it briefly in chat.
- **Do not implement `web/src/lib/lttb.ts`.** I'll write it myself. You may write its tests first and review my implementation afterward.
- Keep dependencies minimal, and ask before adding anything not listed in the stack table.
- Don't jump ahead of the current milestone.

## Interview talking points to be able to explain afterward

- Why batch samples instead of sending one message per sample, and how you picked the batch interval.
- Why raw data lives in a worker and not in React or Redux state.
- How LTTB works and why it beats naive "every Nth point" decimation (spikes survive).
- Ring buffer sizing and the memory math.
- Backpressure: what happens when a client is slow, and why you drop instead of block.
- Canvas vs. SVG vs. WebGL rendering, and when you'd switch to WebGL.
- What changes when Project 2 adds historical data: switching between live and stored sources, and query-side downsampling.

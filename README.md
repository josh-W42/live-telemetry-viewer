# Live Telemetry Viewer

[![CI](https://github.com/josh-W42/Live-Telemetry-Viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/josh-W42/Live-Telemetry-Viewer/actions/workflows/ci.yml)

A Go service that streams simulated rocket-engine test-stand telemetry over
Connect/gRPC, and a React + TypeScript app that plots it live while staying
smooth at millions of points.

See [SPEC.md](SPEC.md) for the full design and milestone plan, and
[NOTES.md](NOTES.md) for the design decisions and the performance measurements
behind them.

**All milestones complete (M0–M6).** Four channels at 1 kHz stream from Go into
a Web Worker, which holds ten minutes in fixed ring buffers, downsamples each
visible window with LTTB, and evaluates threshold rules on every sample. The
main thread only ever sees a few thousand already-reduced points.

Measured: 2,399,800 points held at 120 fps with zero long tasks, against a naive
main-thread chart that saturates at 85,600 points in 22 seconds.

## The app

Open <http://localhost:5173> and it streams.

- **Chart** — four channels on a shared time axis, two y-axes because psi/K and
  g/(kg·s⁻¹) differ by orders of magnitude. Scroll to zoom, drag to pan; zooming
  while live pins the window, which is the same state as paused.
- **Status bar** — connection, points held, points rendered, render fps,
  renders/s, dropped batches, heap. Each carries a tooltip explaining what it
  means. Watching *points held* climb to 2.4M while *points rendered* stays put
  is the whole architecture in two numbers; *renders/s* against *render fps*
  shows how much of the display's frame budget the chart never needs.
- **Channels** — checkboxes. Unticking one stops it being drawn but not being
  recorded, so its history and any anomaly found while it was hidden are there
  when you tick it back on.
- **Anomalies** — threshold rules evaluated in the worker on ingestion, so they
  see every sample rather than the 0.6% that survives downsampling. Detected
  excursions are shaded on the chart; clicking one jumps the view to it.
- **Benchmarks** — folded away at the bottom. The M2 baselines and the
  measurement harness that produced every number in `NOTES.md`.

**An idle or hidden page holds no subscription.** Disconnect, or switch tabs,
and the server's subscriber count returns to zero — a page that keeps a stream
open while discarding every batch costs the server 4,000 samples a second for
nothing.

## Layout

```
proto/telemetry/v1/   the API, and the single source of truth
server/               Go service
  internal/sim/       simulator: test sequence, noise, injected faults
  internal/stream/    Connect handlers and the fan-out broadcaster
  gen/                generated Go — committed, do not edit
web/                  Vite + React + TypeScript client
  src/worker/         ring buffers, LTTB view building, anomaly rules
  src/render/         the three ChartRenderer implementations
  src/components/     presentational UI
  src/store/          Redux slices — UI state only, never samples
  src/bench/          the measurement harness behind NOTES.md
  src/gen/            generated TypeScript — committed, do not edit
```

## Prerequisites

`go` (1.25+), `node` (22+), [`buf`](https://buf.build), and
[`just`](https://just.systems). The codegen plugins are pinned by `tool`
directives in `server/go.mod` and by `web/package-lock.json`, so there is
nothing else to install.

Alternatively, open the repo in the dev container (`.devcontainer/`) and get the
whole toolchain without touching your host.

## Usage

```
just            # list recipes
just install    # install web deps (reproducible, no package scripts)
just gen        # regenerate Go + TypeScript from proto/
just server     # Go API on :8080
just web        # Vite dev server on :5173
just test       # Go + web tests
just cover      # Go tests with a coverage total
just lint       # buf lint, go vet, tsc
just gen-check  # fail if committed codegen is stale
```

Run `just server` and `just web` in two shells, then open
<http://localhost:5173>.

## Notes on the setup

**Generated code is committed.** The repo builds on clone without `buf`
installed, and the generated API is browsable on GitHub. The cost is noisier
diffs when the proto changes.

**Codegen is pinned, not ambient.** `buf.gen.yaml` invokes the Go plugins
through `go tool`, so their versions come from `server/go.mod` rather than from
whatever happens to be on `PATH`. `just gen-check` fails if the committed
generated code has drifted from the protos.

**connect-es v2 uses one plugin.** Service codegen was folded into
`@bufbuild/protoc-gen-es`; there is no separate `protoc-gen-connect-es` in v2.

**Supply chain.** `just install` runs `npm ci --ignore-scripts`, which installs
exactly what the lockfile pins and does not execute package lifecycle hooks.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request.

- **`check` (ubuntu)** runs the same `just` recipes you run locally — install,
  lint, test, cover, gen-check — so CI and a developer machine cannot drift.
- **`windows` job** builds and generates on Windows. Codegen is the most
  platform-sensitive part of this repo: the TypeScript plugin is invoked through
  a shim that differs by platform, and line endings can make generated output
  drift. This job catches both.

`buf` and `just` are installed by pinned version (`just` against a recorded
SHA-256) rather than through third-party actions, so the CI toolchain is
auditable from the workflow file alone.

## Where things run

The day-to-day loop runs **on the host**: `just server`, `just web`, `just test` and the
rest use your locally installed Go, Node and buf. The dev container is a **parity check**,
not the working environment — use it to confirm something builds and generates identically
on Linux before pushing:

```
docker build -f .devcontainer/Dockerfile -t telemetry-dev .
docker run --rm -v "$PWD:/workspaces/telemetry" -v /workspaces/telemetry/web/node_modules \
  telemetry-dev bash -c "just install && just lint && just test && just gen-check"
```

The container only applies when the project is opened in it (VS Code Dev Containers or the
`devcontainer` CLI) or when invoked explicitly as above. Running `just` in a normal shell
never touches it.

The main supply-chain risk is covered on the host regardless: `just install` runs
`npm ci --ignore-scripts`, so package lifecycle hooks never execute. What the host does not
sandbox is `go build` and `go test`, which compile and run dependency code directly.

**Benchmarks are host-measured.** The M2 and M3 performance numbers must come from the same
environment to be comparable, so both are taken on the host with the server and Vite running
locally. Record the machine alongside the numbers in `NOTES.md`.

## Go toolchain note

`server/go.mod` requires Go 1.26+, because `connect-go` 1.21 does. If your local
Go is older, `GOTOOLCHAIN=auto` will download a newer one automatically — but
those downloaded toolchains omit some prebuilt tools, and `go test -cover` fails
with `no such tool "covdata"`. Install Go 1.26 or newer natively to avoid it.

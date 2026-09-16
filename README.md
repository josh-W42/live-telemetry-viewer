# Live Telemetry Viewer

[![CI](https://github.com/josh-W42/live-telemetry-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/josh-W42/live-telemetry-viewer/actions/workflows/ci.yml)

A Go service that streams simulated rocket-engine test-stand telemetry over
Connect/gRPC, and a React + TypeScript app that plots it live while staying
smooth at millions of points.

See [SPEC.md](SPEC.md) for the full design and milestone plan.

**Current milestone: M0 — scaffold and codegen.** The transport works end to
end; the RPCs themselves are stubs that return `Unimplemented`. M1 adds the
simulator and real streaming.

## Layout

```
proto/telemetry/v1/   the API, and the single source of truth
server/               Go service (Connect handlers, simulator)
  gen/                generated Go — committed, do not edit
web/                  Vite + React + TypeScript client
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

## Go toolchain note

`server/go.mod` requires Go 1.26+, because `connect-go` 1.21 does. If your local
Go is older, `GOTOOLCHAIN=auto` will download a newer one automatically — but
those downloaded toolchains omit some prebuilt tools, and `go test -cover` fails
with `no such tool "covdata"`. Install Go 1.26 or newer natively to avoid it.

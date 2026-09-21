# Deployment: single-origin container on Render

**Status:** designed, approved 2026-09-20. Implementation plan to follow.

## What this is for

A link on a CV or GitHub README that an interviewer clicks **cold and unannounced**, weeks
after it was last touched, and forms an impression of in about ten seconds.

That single fact settles most of the design. A cold visitor has no patience: a free tier
waking from sleep for 50 seconds reads as a broken site, not as a free tier. Budget agreed at
a few dollars a month for an always-on instance, which is the only thing that genuinely
solves it.

## Decisions

| Decision | Choice |
|---|---|
| Topology | **Single origin.** Go serves the built SPA and the API from one service. |
| Platform | **Render**, Docker runtime, always-on plan. |
| Packaging | Multi-stage Dockerfile, distroless runtime, assets embedded in the binary. |
| Config | Environment variables, with the existing flags as defaults. |
| Verification | Free tier first, to test streaming. Upgrade only once it is proven. |

### Why single origin rather than a static host plus an API

A CDN-instant frontend that then sits on "connecting" while the backend wakes feels *broken*;
one page that takes a moment and then works feels *slow*. Same wait, very different
impression, and the impression is the entire point here.

It also deletes CORS. Today the allowed origin is a deploy-time coupling in both directions:
the frontend needs the API's URL at build time, and the API needs the frontend's origin at
boot. On one origin the browser never preflights and neither coupling exists.

And there is a third reason that only turned up while checking Render's streaming behaviour:
the one concrete report of Render buffering streamed responses is about **static site
rewrites** — a static site rewriting to a backend, which is the shape a split deployment
takes there. Single origin does not use that path.

### What the platform check found

Three things, from Render's docs and community, all worth recording because they shaped this.

**Render's proxy talks HTTP/1.1 to the service, not HTTP/2.** Open feature request since
December 2023, no official response. Native gRPC over HTTP/2 does not work on an externally
reachable Render web service.

*This does not affect us.* `connect-web` speaks the Connect protocol, whose server-streaming
runs over HTTP/1.1 chunked transfer — the reason SPEC.md chose Connect over grpc-web was
precisely that browsers can consume server streams without a proxy. Only bidirectional
streaming requires HTTP/2, and this app has none. The `h2c` handler becomes harmless rather
than necessary, and should keep a comment saying so, or someone will later "fix" it.

**Hard 100-minute maximum request duration.** Render markets this for long-running LLM calls.
A telemetry stream will be cut at 100 minutes. Today that surfaces as a red `error`, which is
wrong: it is a normal, expected end of a long session. It needs handling — see below. It also
caps what one abandoned tab can cost in egress, which is convenient.

**Response buffering: probably fine, not proven.** Render actively markets SSE and LLM token
streaming on web services, and there is no documented buffering control. But absence of
evidence is not proof, and a buffering proxy would make this app useless — the chart would
advance in clumps rather than scroll. Hence verifying on the free tier before paying.

## Design

### 1. Go serves the SPA

`web/dist` is embedded in the binary. The mux routes the Connect service prefix to Connect and
everything else to a static handler, with unknown paths falling back to `index.html`.

`//go:embed` cannot reach outside its module, and `server/` is the module root while `web/`
is a sibling. So the Docker build copies `dist` into `server/internal/web/dist`, which is
gitignored. A placeholder `index.html` is committed there saying "run `just web` for the dev
server" — without it `go run ./cmd/server` will not compile locally, and with it, hitting the
Go server directly in development explains itself.

Vite emits hashed asset filenames, so assets get a long `Cache-Control` and `index.html` gets
none.

### 2. Compression

The bundle is 1.6 MB raw and 528 KB gzipped — a 3x difference on the first paint of a cold
click, which is the moment this whole deployment is optimised for. A small `compress/gzip`
middleware over text responses, using the standard library rather than a new dependency. Done
in the app rather than relying on the proxy, because proxy behaviour is exactly what could not
be confirmed above.

### 3. Configuration

Environment variables win over flag defaults, because that is what the platform supplies:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 8080 | Render injects this |
| `ALLOWED_ORIGIN` | `http://localhost:5173` | **Empty means skip CORS entirely** |
| `MAX_SUBSCRIBERS` | 25 | See below |

Empty-means-skip rather than empty-means-`*`: on a single origin the browser never preflights,
so the middleware is dead weight in production and a permissive wildcard would be a worse
default than none.

### 4. Health check

`GET /healthz` returning 200, for Render's health checks and zero-downtime deploys.

### 5. Subscriber cap

The endpoint is unauthenticated and streams about 68 KiB/s to anyone who asks — roughly 5.9 GB
per day per continuously connected viewer. The idle and hidden-tab teardown already limits
this a great deal, but nothing currently caps concurrency.

`Subscribe` becomes `(*Subscription, error)`, returning `ErrTooManySubscribers` past the limit;
the service maps it to `CodeResourceExhausted`. One door rather than adding a second method.
The client's connection state already carries a message, so it surfaces with no UI work.

### 6. The pump idles when nobody is listening

`pump.Run` currently generates 4,000 samples a second into the broadcaster forever, watched or
not. On an always-on instance that is a core doing nothing useful indefinitely.

It cannot simply skip, because `flush` publishes `Range(p.next, target)` — skipping without
advancing would make it generate the entire idle period in one batch on resumption. It must
**advance the cursor without generating**:

```go
if p.bus.SubscriberCount() == 0 {
    p.next = target
    return
}
```

Correct precisely because the simulator is pure: phase comes from the sample index, which comes
from the epoch, not from having run. The third time that purity has paid off.

### 7. Reconnect at the 100-minute cut

A stream ending after 100 minutes is expected, not a failure. The client should reconnect
automatically once, and show "reconnecting" rather than an error. If the reconnect fails, then
it is an error.

This also wants a deliberate ceiling of its own: an abandoned visible tab reconnecting forever
is the egress risk the cap is meant to bound. After a few consecutive reconnects with no
interaction, stop and show "paused — reconnect" with a button.

### 8. Frontend

`API_URL` defaults to `window.location.origin`, so `VITE_API_URL` stops being required at
build time and single-origin needs no configuration at all.

### 9. Dockerfile

Multi-stage:

1. `node:22-slim` — `npm ci --ignore-scripts`, `npm run build`. Slim rather than alpine
   deliberately: esbuild ships its platform binary as an optional dependency, and musl is an
   avoidable risk under `--ignore-scripts`.
2. `golang:1.27` — `go build` with `CGO_ENABLED=0`, assets copied in from stage 1.
3. `gcr.io/distroless/static-debian12:nonroot` — one static binary, no shell, non-root.

### 10. `render.yaml`

Committed as a Blueprint: Docker runtime, `healthCheckPath: /healthz`, `autoDeploy` on push to
`main`, env vars declared. Infrastructure in the repo rather than clicked into a dashboard.

### 11. Prerequisite: a git remote

Render deploys from GitHub and there is still no remote. Pushing to
`github.com/josh-W42/live-telemetry-viewer` is step zero — and it makes the CI workflow run for the first time
and fixes the README badge, which has been 404ing since M0.

## Verification, in order

1. **Local container.** `docker build`, run it, confirm the app is served and streams on one
   origin with no Vite and no CORS.
2. **Free tier deploy.** The question is only whether streaming survives the proxy. Watch the
   chart: buffering is unmissable at 20 batches a second — the trace advances in clumps
   instead of scrolling. Check `dropped batches` stays at zero.
3. **Only then upgrade** to the always-on plan.
4. **Cold click.** Leave it, come back, open the link on a phone on mobile data. That is the
   actual acceptance test for this whole exercise.
5. **Long session.** Leave a tab open past 100 minutes and confirm it reconnects rather than
   erroring.

If step 2 fails, the same image goes to Fly.io unchanged. Containerising is what makes that
fallback cheap, and it is the reason not to use a platform-specific buildpack.

## Out of scope

Auth, multi-region, a custom domain, autoscaling, and any persistence. Horizontal scaling in
particular is meaningless here: each instance runs its own simulator from its own epoch, so two
instances would show two different engine runs. One instance is correct, not a compromise.

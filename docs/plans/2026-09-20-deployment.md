# Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the viewer as one always-on container on Render, serving the SPA and the Connect API from a single origin, reachable from a cold link in seconds.

**Architecture:** A multi-stage Docker build compiles the web app, embeds it in a static Go binary, and runs it on distroless. Go serves both the API and the assets, so there is no CORS and no second deploy target. Config comes from environment variables with the existing flags as defaults.

**Tech Stack:** Go 1.26, Connect, `embed`; Vite/React; Docker multi-stage, distroless; Render Blueprint.

**Design doc:** `docs/plans/2026-09-20-deployment-design.md`

---

## Background the executor needs

**Commands.** `just test` (Go + web), `just lint`, `just gen-check`. A single Go test:
`cd server && go test ./internal/stream/ -run TestName -v`. A single web test:
`cd web && npx vitest run src/path.test.ts -t "name"`.

**Commit messages: no attribution trailers** (see `CLAUDE.md`).

**Two traps found while writing this plan:**

1. `.gitignore` contains a bare `dist/`, which matches *any* directory called `dist` at any
   depth. The embed directory is therefore named `assets/`, not `dist/`, so the committed
   placeholder is not silently ignored.
2. `server/go.mod` declares `go 1.26.0`. The Dockerfile must use a Go image at or above that.
   Do not assume 1.27 because the dev machine has it.

**Do not touch** `baseOption`, `naive.ts` or `append.ts`. Modes A and B are frozen references
for the numbers in `NOTES.md`.

---

### Task 1: Push to GitHub

Everything else depends on this: Render deploys from a repo, and there is no remote.

**Step 1: Create the remote and push**

```bash
gh repo create josh-W42/live-telemetry-viewer --public --source=. --remote=origin --push
```

**Step 2: Confirm CI runs**

Run: `gh run list --limit 3`
Expected: the `CI` workflow appears and passes on both the ubuntu and windows jobs. This is
its first ever run — if it fails, fix that before going further, because Render will build
from the same tree.

**Step 3: Check the README badge**

Open the repo page. The CI badge at the top of `README.md` should now render instead of 404ing.

No commit — this task only creates the remote.

---

### Task 2: Read configuration from the environment

Render injects `PORT`. Flags stay as the local-development interface; env wins when set.

**Files:**
- Create: `server/internal/config/config.go`
- Create: `server/internal/config/config_test.go`

**Step 1: Write the failing test**

```go
package config_test

import (
	"testing"

	"github.com/josh-W42/sift/server/internal/config"
)

func TestStringPrefersTheEnvironment(t *testing.T) {
	t.Setenv("PORT", "10000")
	// The platform supplies PORT and cannot be told to pass a flag, so the
	// environment has to win over the flag's default.
	if got := config.String("PORT", "8080"); got != "10000" {
		t.Errorf("got %q, want the environment's 10000", got)
	}
}

func TestStringFallsBackToTheDefault(t *testing.T) {
	t.Setenv("PORT", "")
	if got := config.String("PORT", "8080"); got != "8080" {
		t.Errorf("got %q, want the fallback 8080", got)
	}
}

// An empty variable means "unset", not "set to empty". A platform that exports
// every declared variable whether or not it has a value would otherwise wipe
// the defaults.
func TestStringTreatsBlankAsUnset(t *testing.T) {
	t.Setenv("ALLOWED_ORIGIN", "   ")
	if got := config.String("ALLOWED_ORIGIN", "fallback"); got != "fallback" {
		t.Errorf("got %q, want the fallback", got)
	}
}

func TestIntParsesAndFallsBack(t *testing.T) {
	t.Setenv("MAX_SUBSCRIBERS", "40")
	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 40 {
		t.Errorf("got %d, want 40", got)
	}

	t.Setenv("MAX_SUBSCRIBERS", "not a number")
	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 25 {
		t.Errorf("got %d; a malformed value should fall back rather than crash", got)
	}
}
```

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/config/ -v`
Expected: build failure, no such package.

**Step 3: Implement**

```go
// Package config reads deployment settings from the environment.
//
// Flags remain the interface for local development. The environment wins when
// set, because a platform injects PORT and has no way to pass a flag.
package config

import (
	"os"
	"strconv"
	"strings"
)

// String returns the environment value for key, or fallback when it is unset
// or blank. Blank counts as unset: a platform that exports every declared
// variable regardless of value would otherwise erase the defaults.
func String(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// Int is String for whole numbers. A malformed value falls back rather than
// failing the boot: a service that refuses to start over a typo in one
// non-critical setting is worse than one that logs and carries on.
func Int(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}

	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
```

**Step 4: Run and commit**

Run: `cd server && go test ./internal/config/ -v` — expect PASS.

```bash
git add server/internal/config
git commit -m "Read deployment settings from the environment, with flags as defaults"
```

---

### Task 3: Health endpoint, and stop the static handler shadowing the API

**Files:**
- Modify: `server/internal/stream/http.go`
- Modify: `server/internal/stream/http_test.go`

**Step 1: Write the failing test**

```go
func TestHealthzReportsOK(t *testing.T) {
	h := stream.NewHTTPHandler(newTestService(t), "", nil)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Errorf("got %d, want 200; Render gates deploys on this", rec.Code)
	}
}
```

Adjust `newTestService` to whatever the existing tests already use to build a `*Service`.

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run Healthz -v`
Expected: fails to compile (the third argument does not exist yet), then 404 once it does.

**Step 3: Implement**

Rewrite `NewHTTPHandler`:

```go
// NewHTTPHandler mounts the Connect service, a health check, and — in a
// deployed build — the web app, all on one origin.
//
// `static` may be nil, which is what the tests and a pure-API run use.
func NewHTTPHandler(svc *Service, allowedOrigin string, static http.Handler) http.Handler {
	mux := http.NewServeMux()

	// Taking the path from the generated handler rather than writing the
	// service name out: ServeMux matches longest prefix, so the catch-all
	// below cannot shadow it, and nothing has to be kept in step by hand.
	path, connectHandler := telemetryv1connect.NewTelemetryServiceHandler(svc)
	mux.Handle(path, connectHandler)

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	if static != nil {
		mux.Handle("/", static)
	}

	// h2c serves HTTP/2 over cleartext, for grpcurl and native gRPC clients
	// against a local server. It is not load-bearing in production: Render's
	// proxy speaks HTTP/1.1 to the service, and Connect's server-streaming
	// runs over HTTP/1.1 chunked transfer, which is why SPEC.md chose Connect
	// over grpc-web. Leave it; it costs nothing and helps locally.
	return h2c.NewHandler(withCORS(mux, allowedOrigin), &http2.Server{})
}
```

**Step 4: Fix the existing call sites**

`server/cmd/server/main.go` and any test calling `NewHTTPHandler` need a third argument.
Pass `nil` for now.

**Step 5: Run and commit**

Run: `cd server && go test ./internal/... -v 2>&1 | tail -20` — expect PASS.

```bash
git add server/internal/stream server/cmd
git commit -m "Add a health check and route the API by its generated path"
```

---

### Task 4: Skip CORS entirely when no origin is configured

**Files:**
- Modify: `server/internal/stream/http.go`
- Modify: `server/internal/stream/http_test.go`

**Step 1: Write the failing test**

```go
/*
On one origin the browser never sends a preflight, so the CORS middleware is
dead weight in production. Empty means no middleware rather than allowing "*",
because a permissive wildcard on an unauthenticated streaming endpoint is a
worse default than none at all.
*/
func TestNoCORSHeadersWhenNoOriginIsConfigured(t *testing.T) {
	h := stream.NewHTTPHandler(newTestService(t), "", nil)

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("allowed origin %q with CORS disabled", got)
	}
}
```

Keep the existing test that a configured origin *is* allowed — both behaviours matter.

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run CORS -v`

**Step 3: Implement**

```go
func withCORS(h http.Handler, origin string) http.Handler {
	// No origin configured means single-origin deployment: the browser never
	// preflights, so there is nothing for this to do.
	if origin == "" {
		return h
	}
	// ... existing cors.New(...) unchanged
}
```

**Step 4: Run and commit**

```bash
git add server/internal/stream
git commit -m "Skip CORS when no cross-origin client is configured"
```

---

### Task 5: Cap concurrent subscribers

An unauthenticated endpoint streaming ~68 KiB/s to anyone is ~5.9 GB per day per connected
viewer, and nothing currently limits concurrency.

**Files:**
- Modify: `server/internal/stream/broadcast.go`
- Modify: `server/internal/stream/service.go`
- Modify: `server/internal/stream/broadcast_test.go`

**Step 1: Write the failing test**

```go
func TestSubscribeRefusesPastTheCap(t *testing.T) {
	b := stream.NewBroadcasterWithLimit(stream.DefaultBufferDepth, 2)

	for i := range 2 {
		if _, err := b.Subscribe(nil); err != nil {
			t.Fatalf("subscriber %d refused: %v", i, err)
		}
	}

	if _, err := b.Subscribe(nil); !errors.Is(err, stream.ErrTooManySubscribers) {
		t.Errorf("got %v, want ErrTooManySubscribers", err)
	}
}

// A cap that never released would turn one burst of visitors into a permanent
// outage.
func TestClosingASubscriptionFreesItsSlot(t *testing.T) {
	b := stream.NewBroadcasterWithLimit(stream.DefaultBufferDepth, 1)

	first, err := b.Subscribe(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Subscribe(nil); err == nil {
		t.Fatal("second subscriber accepted past a cap of 1")
	}

	first.Close()

	if _, err := b.Subscribe(nil); err != nil {
		t.Errorf("slot not released after close: %v", err)
	}
}

func TestZeroLimitMeansUnlimited(t *testing.T) {
	b := stream.NewBroadcasterWithLimit(stream.DefaultBufferDepth, 0)
	for i := range 50 {
		if _, err := b.Subscribe(nil); err != nil {
			t.Fatalf("subscriber %d refused with no cap set: %v", i, err)
		}
	}
}
```

Use the existing `Close`/unsubscribe method name if it differs.

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run Subscribe -v`

**Step 3: Implement**

Add to `broadcast.go`:

```go
// ErrTooManySubscribers is returned when the broadcaster is at capacity.
var ErrTooManySubscribers = errors.New("too many subscribers")
```

Give `Broadcaster` a `maxSubs int` field, add
`NewBroadcasterWithLimit(depth, maxSubs int) *Broadcaster`, and have the existing
`NewBroadcaster` delegate with `maxSubs: 0`. Then change `Subscribe`:

```go
// Subscribe registers a new subscriber, or refuses when the broadcaster is
// full. A limit of zero means unlimited.
//
// The endpoint is unauthenticated and streams roughly 68 KiB/s per subscriber,
// so an uncapped deployment lets any visitor decide the egress bill.
func (b *Broadcaster) Subscribe(channelIDs []string) (*Subscription, error) {
	// ... build filter and sub as before, then:

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.maxSubs > 0 && len(b.subs) >= b.maxSubs {
		return nil, ErrTooManySubscribers
	}
	b.subs[sub] = struct{}{}
	return sub, nil
}
```

In `service.go`, at the `Subscribe` call in `StreamTelemetry`:

```go
	sub, err := s.bus.Subscribe(req.Msg.ChannelIds)
	if err != nil {
		return connect.NewError(connect.CodeResourceExhausted, err)
	}
```

Update every other caller the compiler points at.

**Step 4: Run and commit**

Run: `cd server && go test ./internal/... ` — expect PASS.

```bash
git add server/internal/stream
git commit -m "Cap concurrent subscribers on an unauthenticated streaming endpoint"
```

---

### Task 6: Idle the pump when nobody is listening

**Files:**
- Modify: `server/internal/stream/pump.go`
- Modify: `server/internal/stream/pump_test.go`

**Step 1: Write the failing test**

```go
func TestPumpPublishesNothingWithNoSubscribers(t *testing.T) {
	s := sim.New(sim.Config{Seed: 1, RateHz: 1000, EpochNs: 0})
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := stream.NewPump(s, bus, 50*time.Millisecond)

	p.Flush(int64(time.Second)) // one second of wall clock, nobody watching

	if got := bus.Published(); got != 0 {
		t.Errorf("published %d batches with no subscribers; an always-on instance "+
			"should not generate 4,000 samples a second for nobody", got)
	}
}

/*
The trap this test exists for.

flush publishes Range(next, target). Skipping while idle *without* advancing the
cursor would make the pump generate the entire idle period in one batch the
moment someone connected — an hour of samples at once after an hour of quiet.
Advancing without generating is correct only because the simulator is pure:
phase comes from the sample index, which comes from the epoch, not from having
run.
*/
func TestPumpResumesInStepAfterIdling(t *testing.T) {
	s := sim.New(sim.Config{Seed: 1, RateHz: 1000, EpochNs: 0})
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := stream.NewPump(s, bus, 50*time.Millisecond)

	p.Flush(int64(10 * time.Second)) // ten seconds idle

	sub, err := bus.Subscribe(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()

	p.Flush(int64(10*time.Second + 50*time.Millisecond))

	batch := <-sub.C()
	got := len(batch.Channels[0].Values)
	if got > 100 {
		t.Errorf("first batch after idling carried %d samples; expected ~50, so the "+
			"cursor did not advance while idle", got)
	}
}
```

`Flush` must be exported for this, and the broadcaster needs a `Published()` counter — add
one if `Dropped()`'s neighbour does not already exist. Use the existing channel accessor name
in place of `sub.C()`.

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run Pump -v`
Expected: the first test fails with a non-zero publish count.

**Step 3: Implement**

In `pump.go`, rename `flush` to `Flush`, update `Run`, and add the guard:

```go
func (p *Pump) Flush(nowNs int64) {
	target := p.sim.IndexAt(nowNs)
	if target <= p.next {
		return
	}

	// Nobody is listening. Advance the cursor so the sequence stays on the wall
	// clock, but do not generate: the work would be thrown away, and an
	// always-on instance should not burn a core producing telemetry for nobody.
	//
	// Advancing without generating is sound only because the simulator is pure.
	// Skipping without advancing would publish the whole idle period at once
	// when someone finally connected.
	if p.bus.SubscriberCount() == 0 {
		p.next = target
		return
	}

	samples := p.sim.Range(p.next, target)
	p.next = target
	p.bus.Publish(toProto(samples))
}
```

**Step 4: Run and commit**

```bash
git add server/internal/stream
git commit -m "Idle the pump when nobody is subscribed"
```

---

### Task 6b: Restart the sequence for a new visitor

Idling exposes a product problem. The 85-second loop is idle 10s, chill-down 15s, ignition 5s,
steady 45s, shutdown 10s — so **about 29% of cold visitors land in the 25 seconds of near-flat
lines**, and one arriving at the start of idle waits 25 seconds for anything to happen. For a
link whose job is an impression in ten seconds, that matters more than the wasted CPU.

When the pump is idle and a *new* visitor arrives, the sequence starts again from idle.

**Files:**
- Modify: `proto/telemetry/v1/telemetry.proto`
- Modify: `server/internal/stream/pump.go`, `pump_test.go`
- Modify: `server/internal/stream/service.go`, `service_test.go`
- Modify: `server/cmd/server/main.go`
- Modify: `web/src/worker/protocol.ts`, `telemetry.worker.ts`, `web/src/render/worker.ts`

**Step 1: Add the proto field**

In `message StreamTelemetryRequest`, after `channel_ids`:

```proto
  // True on a page's first connection, false when reconnecting after a tab
  // switch or a dropped stream.
  //
  // Tabbing away tears the stream down, so a returning viewer and a brand-new
  // visitor produce an identical 0-to-1 subscriber transition and the server
  // cannot tell them apart. The client is the only party that knows, so it
  // says. A fresh sequence starts only for a genuine new arrival.
  bool new_session = 2;
```

Run: `just gen`, then stage `proto server/gen web/src/gen`.

**Step 2: Write the failing pump tests**

```go
/*
Restarting is not just rewinding the index. sim.Range stamps every sample
EpochNs + index x period, so rewinding against the boot epoch would emit
timestamps from hours ago — and the client plots against Date.now(), so the
chart would draw nothing at all. The restart has to move the epoch.
*/
func TestRestartBeginsTheSequenceAgainFromNow(t *testing.T) {
	const hour = int64(time.Hour)

	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := stream.NewPump(sim.Config{Seed: 1, RateHz: 1000}, bus, 50*time.Millisecond)

	p.Flush(hour) // an hour of wall clock, nobody watching

	sub, err := bus.Subscribe(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()

	p.Restart()
	p.Flush(hour + int64(50*time.Millisecond))

	batch := <-sub.C()

	if first := batch.Channels[0].TimestampsNs[0]; first < hour {
		t.Errorf("first sample stamped %d, before the restart at %d; the epoch did not move",
			first, hour)
	}

	// Channel 0 is chamber_pressure. At this point on the wall clock the loop
	// is five seconds into ignition, where pressure is already in the hundreds.
	// Ambient means the sequence really did start over.
	if v := batch.Channels[0].Values[0]; v > 50 {
		t.Errorf("first sample after restart was %.1f psi, want ambient ~14.7", v)
	}
}

// Without a restart, a returning viewer picks up wherever the clock is. This is
// what stops a tab switch cycling the rig.
func TestResumingWithoutRestartStaysOnTheWallClock(t *testing.T) {
	const hour = int64(time.Hour)

	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := stream.NewPump(sim.Config{Seed: 1, RateHz: 1000}, bus, 50*time.Millisecond)

	p.Flush(hour)

	sub, err := bus.Subscribe(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()

	p.Flush(hour + int64(50*time.Millisecond))

	batch := <-sub.C()
	if v := batch.Channels[0].Values[0]; v < 50 {
		t.Errorf("resumed at %.1f psi, want the ignition ramp the wall clock is in", v)
	}
}
```

**Step 3: Run to confirm they fail**

Run: `cd server && go test ./internal/stream/ -run "Restart|Resuming" -v`

Expected: compile failure — `NewPump` does not take a `sim.Config`, and `Restart` does not
exist.

**Step 4: Implement in the pump**

`NewPump` now takes the config and builds its own simulator, because a restart means building
another one:

```go
type Pump struct {
	cfg      sim.Config
	sim      *sim.Simulator
	bus      *Broadcaster
	interval time.Duration

	next    int64
	restart atomic.Bool
}

// NewPump returns a Pump that flushes a batch every interval.
//
// It takes the simulator's config rather than a simulator, because restarting
// the sequence means building a new one with a later epoch.
func NewPump(cfg sim.Config, bus *Broadcaster, interval time.Duration) *Pump {
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	return &Pump{cfg: cfg, sim: sim.New(cfg), bus: bus, interval: interval}
}

// Restart asks for the test sequence to begin again at the next flush.
//
// Called when a new visitor arrives to an idle rig, so they watch the sequence
// from idle rather than landing at a random point in it.
func (p *Pump) Restart() { p.restart.Store(true) }
```

And in `Flush`, before anything else:

```go
func (p *Pump) Flush(nowNs int64) {
	if p.restart.Swap(false) {
		// A new value rather than mutating the old one, so nothing races with
		// the Service's own reference. Channels() is epoch-independent, so the
		// two agree on metadata regardless.
		p.sim = sim.New(sim.Config{Seed: p.cfg.Seed, RateHz: p.cfg.RateHz, EpochNs: nowNs})
		p.next = 0
	}

	target := p.sim.IndexAt(nowNs)
	// ... the rest as Task 6 left it
}
```

**Step 5: Update Task 6's tests**

They construct `NewPump(s, bus, ...)` with a simulator. Change them to pass
`sim.Config{Seed: 1, RateHz: 1000}`. Behaviour is unchanged.

**Step 6: Wire the service**

`stream.New` gains a callback:

```go
// New returns a Service. onNewSession is called when a new visitor connects to
// an idle server; nil disables the behaviour.
func New(s *sim.Simulator, bus *Broadcaster, onNewSession func()) *Service
```

In `StreamTelemetry`, before subscribing:

```go
	// Checked here rather than in the pump so that "a join mid-run is not a
	// restart" is true by construction. The check-then-subscribe race is real
	// and benign: two simultaneous cold arrivals both see zero, both ask, and
	// the pump restarts once.
	if req.Msg.NewSession && s.onNewSession != nil && s.bus.SubscriberCount() == 0 {
		s.onNewSession()
	}
```

**Step 7: Write the service test**

Against the existing service-test helpers, assert all three cases:

- a new visitor to an idle server calls `onNewSession` once
- a new visitor arriving while someone is already subscribed does **not**
- a reconnect (`new_session: false`) never does, whatever the count

**Step 8: Wire main**

```go
	pump := stream.NewPump(simCfg, bus, *batchInterval)
	svc := stream.New(simulator, bus, pump.Restart)
```

`simulator` stays for `ListChannels`; the pump owns its own. Both come from the same config,
so their channel metadata is identical.

**Step 9: The client says which it is**

`web/src/worker/protocol.ts` — add `newSession: boolean` to `StartRequest`.

`web/src/render/worker.ts` — a **module-scoped** flag, so it survives renderer instances
within one page load but resets on reload:

```ts
/**
 * Whether this page load has yet opened a stream.
 *
 * Module scope, not instance: a mode switch builds a new renderer, and that is
 * not a new visitor. Only a page load is.
 */
let firstConnectionOfThisPage = true;
```

In `setActive(true)`, send `newSession: firstConnectionOfThisPage`, then set it false.

`web/src/worker/telemetry.worker.ts` — pass it through:

```ts
const stream = client.streamTelemetry(
  { channelIds, newSession },
  { signal: controller.signal },
);
```

**Step 10: Verify by hand**

Run `just server` and `just web`.

1. Load the page. Expected: the sequence starts at idle — flat lines, then chill-down, then
   ignition about 25 seconds in.
2. Tab away for a minute, tab back. Expected: it resumes mid-sequence. **It must not restart
   at idle** — that is the whole point of the flag.
3. Reload the page. Expected: starts at idle again.
4. Open a second tab while the first is streaming. Expected: the second joins the run in
   progress, and the first does not jump back to idle.

**Step 11: Run everything and commit**

Run: `just test && just lint && just gen-check`

```bash
git add proto server web
git commit -m "Start a fresh test sequence for a new visitor, not for a returning one"
```

---

### Task 7: Serve the web app from the binary

**Files:**
- Create: `server/internal/web/web.go`
- Create: `server/internal/web/web_test.go`
- Create: `server/internal/web/assets/index.html` (dev placeholder)
- Modify: `.gitignore`

**Step 1: Add the placeholder and ignore rule**

`server/internal/web/assets/index.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Live Telemetry Viewer — development</title>
<p>
  This is the placeholder the Go binary embeds when the web app has not been built into it.
  For development run <code>just web</code> and open
  <a href="http://localhost:5173">localhost:5173</a>. The Docker build replaces this
  directory with the real bundle.
</p>
```

Append to `.gitignore`:

```gitignore
# The Docker build copies web/dist here to be embedded. Only the dev
# placeholder is tracked. Note this directory is NOT called `dist`, because the
# bare `dist/` rule above would match it at any depth and ignore the placeholder
# too.
server/internal/web/assets/*
!server/internal/web/assets/index.html
```

**Step 2: Write the failing test**

```go
package web_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/josh-W42/sift/server/internal/web"
)

func get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	web.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestServesTheIndex(t *testing.T) {
	rec := get(t, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<!doctype html>") {
		t.Errorf("body is not the index page: %q", rec.Body.String()[:80])
	}
}

/*
A single-page app owns its own routing, so a deep link the server has never
heard of must still return the page rather than a 404 — otherwise a refresh on
any client-side route breaks.
*/
func TestUnknownPathsFallBackToTheIndex(t *testing.T) {
	rec := get(t, "/some/client/route")
	if rec.Code != http.StatusOK {
		t.Errorf("got %d for a client-side route, want the index", rec.Code)
	}
}

// Hashed filenames make an asset immutable, so it can be cached hard. The index
// must not be, or a deploy would never reach anyone holding a cached copy.
func TestTheIndexIsNotCached(t *testing.T) {
	if cc := get(t, "/").Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Errorf("index Cache-Control is %q; a cached index pins users to an old deploy", cc)
	}
}
```

**Step 3: Run to confirm it fails**

Run: `cd server && go test ./internal/web/ -v`
Expected: build failure, no such package.

**Step 4: Implement**

```go
// Package web serves the built single-page app from inside the binary.
//
// Embedding rather than shipping a directory means the deployable is one file
// and the assets cannot drift from the server that serves them.
//
// The directory is `assets` and not `dist` on purpose: .gitignore has a bare
// `dist/` rule that matches at any depth, which would silently ignore the
// committed development placeholder.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed assets
var embedded embed.FS

// Handler serves the app, falling back to index.html for unknown paths.
func Handler() http.Handler {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		// Only reachable if the embed directive above is wrong, which is a
		// compile-time-shaped mistake rather than a runtime condition.
		panic(err)
	}

	files := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")

		if _, err := fs.Stat(sub, name); err != nil || name == "" {
			// Not a real file: hand back the page and let the client route.
			w.Header().Set("Cache-Control", "no-cache")
			r = r.Clone(r.Context())
			r.URL.Path = "/"
			files.ServeHTTP(w, r)
			return
		}

		// Vite fingerprints asset filenames, so their contents can never change
		// under a given name.
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
```

**Step 5: Run the tests**

Run: `cd server && go test ./internal/web/ -v` — expect PASS.

**Step 6: Wire it into main**

In `server/cmd/server/main.go`, replace the flag reads and handler construction:

```go
	port := flag.String("port", config.String("PORT", "8080"), "port to listen on")
	allowedOrigin := flag.String("allowed-origin",
		config.String("ALLOWED_ORIGIN", "http://localhost:5173"),
		"CORS origin for a cross-origin dev client; empty disables CORS")
	maxSubs := flag.Int("max-subscribers",
		config.Int("MAX_SUBSCRIBERS", 25),
		"concurrent stream limit; 0 for unlimited")
```

Use `stream.NewBroadcasterWithLimit(stream.DefaultBufferDepth, *maxSubs)` and
`stream.NewHTTPHandler(stream.New(simulator, bus), *allowedOrigin, web.Handler())`.

**Step 7: Verify by hand**

Run: `cd server && go run ./cmd/server`, then open <http://localhost:8080>.
Expected: the placeholder page, explaining how to run the dev server.

Run: `curl -s localhost:8080/healthz` — expect `ok`.

**Step 8: Commit**

```bash
git add server .gitignore
git commit -m "Serve the web app from the binary, on the same origin as the API"
```

---

### Task 8: Compress text responses

528 KB gzipped against 1.6 MB raw, on the first paint of a cold click. Done in the app rather
than trusting the proxy, since proxy behaviour is the one thing the platform check could not
confirm.

**Files:**
- Create: `server/internal/stream/gzip.go`
- Create: `server/internal/stream/gzip_test.go`
- Modify: `server/internal/stream/http.go`

**Step 1: Write the failing test**

```go
func TestCompressesWhenTheClientAccepts(t *testing.T) {
	h := stream.WithGzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(strings.Repeat("telemetry ", 500)))
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("response was not compressed")
	}
	if rec.Body.Len() >= 5000 {
		t.Errorf("compressed body is %d bytes, barely smaller than the 5000 raw", rec.Body.Len())
	}
}

func TestLeavesTheBodyAloneWhenTheClientDoesNotAccept(t *testing.T) {
	h := stream.WithGzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("plain"))
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Header().Get("Content-Encoding") != "" {
		t.Error("compressed a response for a client that did not ask")
	}
	if rec.Body.String() != "plain" {
		t.Errorf("body was altered: %q", rec.Body.String())
	}
}
```

**Step 2: Run to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run Compress -v`

**Step 3: Implement**

```go
package stream

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
)

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (w gzipWriter) Write(b []byte) (int, error) { return w.gz.Write(b) }

// Flush passes through to the underlying writer as well as the compressor.
// Without this a streaming handler's flush would stop at the gzip buffer and
// the client would see nothing until the buffer filled — the exact failure this
// whole deployment was checked for in a proxy.
func (w gzipWriter) Flush() {
	_ = w.gz.Flush()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// WithGzip compresses responses for clients that accept it.
//
// The bundle is 1.6MB raw and 528KB gzipped, which is the difference between a
// fast and a slow first impression on a cold link. Done here rather than left
// to the proxy, because the proxy's behaviour is not something this repo can
// pin down.
func WithGzip(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.ServeHTTP(w, r)
			return
		}

		gz := gzip.NewWriter(w)
		defer func() { _ = gz.Close() }()

		w.Header().Set("Content-Encoding", "gzip")
		// The body length changes, so any inherited value is now a lie.
		w.Header().Del("Content-Length")
		w.Header().Add("Vary", "Accept-Encoding")

		h.ServeHTTP(gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}

var _ io.Writer = gzipWriter{}
```

**Step 4: Apply it to the static handler only**

In `NewHTTPHandler`, wrap the static handler rather than the whole mux:

```go
	if static != nil {
		mux.Handle("/", WithGzip(static))
	}
```

Deliberately not the Connect handler: Connect negotiates its own compression per the protocol,
and wrapping it would compress an already-compressed stream and risk interfering with framing.

**Step 5: Run and commit**

Run: `cd server && go test ./internal/... ` — expect PASS.

```bash
git add server/internal/stream
git commit -m "Compress static responses in the app rather than trusting the proxy"
```

---

### Task 9: Default the client to its own origin

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/client.ts`

**Step 1: Change the default**

In both files, replace the `API_URL` default:

```ts
// Same origin by default: the Go binary serves this page and the API together,
// so there is nothing to configure and no CORS. VITE_API_URL remains an
// override for pointing a dev build at a remote server.
const API_URL =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined" ? "http://localhost:8080" : window.location.origin);
```

**Step 2: Check dev still works**

Run `just server` and `just web`, open <http://localhost:5173>.

Expected: **it breaks** — the page is served from :5173 and now calls :5173 for the API. Set
the dev override so this stays working. Create `web/.env.development`:

```
VITE_API_URL=http://localhost:8080
```

Confirm `.env` and `.env.local` are gitignored but `.env.development` is not — it must be
committed, since it is how the dev server finds the API.

**Step 3: Verify**

Reload <http://localhost:5173>. Expected: streaming, as before.

**Step 4: Commit**

```bash
git add web/src web/.env.development
git commit -m "Default the client to its own origin"
```

---

### Task 10: Reconnect when the platform cuts a long stream

Render enforces a 100-minute maximum request duration. A stream ending is expected, not a
failure, and today it shows a red error.

**Files:**
- Modify: `web/src/worker/telemetry.worker.ts`
- Modify: `web/src/render/types.ts`
- Modify: `web/src/components/StatusBar.tsx`

**Step 1: Handle a clean end of stream in the worker**

The `for await` loop ends without error when the server closes. Today that falls out of
`start()` silently. After the loop, when the run was not aborted, report it:

```go
    // The stream ended without an error. That is not a failure: the platform
    // caps a single request at 100 minutes, so a long session ends this way by
    // design. Say so, and let the main thread decide whether to reconnect.
```

```ts
    if (!controller.signal.aborted) {
      ctx.postMessage({ type: "ended" });
    }
```

Add `EndedMessage` to `protocol.ts` and the `WorkerMessage` union.

**Step 2: Reconnect once, then stop**

In `WorkerRenderer.onMessage`, on `ended`: report status `reconnecting` and call `start`
again, tracking consecutive attempts. After 3 consecutive reconnects with no successful
`ready` in between, report `idle` with a message like "session ended — press Connect".

The ceiling matters: an abandoned tab reconnecting forever is exactly the egress the
subscriber cap exists to bound.

Add `"reconnecting"` to `ConnectionState` in `render/types.ts`, and a colour for it in
`styles.css` (reuse the `connecting` amber).

**Step 3: Verify locally**

Restart `just server` while the page is streaming.

Expected: the indicator goes to `reconnecting`, then back to `streaming` once the server is
up — not to a red error.

**Step 4: Commit**

```bash
git add web/src
git commit -m "Treat a closed stream as an expected end of session, and reconnect once"
```

---

### Task 11: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Write `.dockerignore`**

```
.git
node_modules
web/node_modules
web/dist
server/server
server/server.exe
bench-results
docs
.devcontainer
```

**Step 2: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

# 1. Build the web app.
#
# slim rather than alpine deliberately: esbuild ships its platform binary as an
# optional dependency, and `npm ci --ignore-scripts` plus musl is an avoidable
# way to lose an afternoon.
FROM node:24-slim AS web
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

# 2. Build a static Go binary with the bundle embedded.
#
# The Go image must satisfy the `go` directive in server/go.mod (1.26.0).
FROM golang:1.26-bookworm AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /app/dist/ ./internal/web/assets/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/telemetry ./cmd/server

# 3. Run it. No shell, no package manager, non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/telemetry /telemetry
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/telemetry"]
```

**Step 3: Build and run it**

```bash
docker build -t telemetry .
```

```bash
docker run --rm -p 8080:8080 -e ALLOWED_ORIGIN= telemetry
```

**Step 4: Verify the container end to end**

Open <http://localhost:8080>. This is the real test of the whole design:

- the app loads — not the placeholder
- it streams, on one origin, with no Vite running
- the status bar shows points held climbing and dropped batches at zero
- `curl -s localhost:8080/healthz` returns `ok`
- `curl -sI localhost:8080/ | grep -i cache-control` shows `no-cache`
- `curl -sI -H 'Accept-Encoding: gzip' localhost:8080/ | grep -i content-encoding` shows `gzip`

**Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "Package the app and the API as one container"
```

---

### Task 12: Render Blueprint

**Files:**
- Create: `render.yaml`

**Step 1: Write it**

```yaml
# Render Blueprint. Kept in the repo so the deployment is reviewable and
# reproducible rather than clicked into a dashboard.
services:
  - type: web
    name: telemetry
    runtime: docker
    dockerfilePath: ./Dockerfile
    region: oregon
    plan: free # raise to starter once streaming is verified; see the design doc
    healthCheckPath: /healthz
    autoDeploy: true
    envVars:
      # Single origin: the browser never preflights, so CORS is switched off.
      - key: ALLOWED_ORIGIN
        value: ""
      - key: MAX_SUBSCRIBERS
        value: "25"
```

**Step 2: Commit and push**

```bash
git add render.yaml
git commit -m "Describe the Render service in the repo"
git push
```

---

### Task 13: Deploy free, verify streaming, then pay

The free tier is used here **only** to answer the question the platform check could not: does
Render's proxy buffer a streamed response? Cold starts are irrelevant to that.

**Step 1: Create the service**

In the Render dashboard, create a new Blueprint instance from the repo. Wait for the first
build — the Docker build takes a few minutes.

**Step 2: The decisive test**

Open the deployed URL. Wait past the cold start, then watch the chart for thirty seconds.

- **Not buffered:** the trace scrolls smoothly, the same as locally.
- **Buffered:** the trace advances in visible jumps, pausing then leaping. At 20 batches a
  second this is unmistakable.

Also check `dropped batches` stays at 0 and `renders/s` sits near 30.

**Step 3: If it is buffered — stop and switch**

Do not try to work around it. Deploy the same image to Fly.io:

```bash
fly launch --no-deploy --dockerfile Dockerfile
```

Set `min_machines_running = 1` in `fly.toml` and deploy. The container is unchanged; that
portability is why it exists.

**Step 4: If it is clean — upgrade**

Change `plan: free` to `plan: starter` in `render.yaml`, commit, push. Confirm the service no
longer sleeps.

**Step 5: The actual acceptance test**

Leave it for a few hours. Then open the link on a phone, on mobile data, as a stranger would.
It should be streaming within a few seconds of the page appearing.

**Step 6: Long-session check**

Leave a tab open for over 100 minutes. Confirm the indicator goes `reconnecting` and returns
to `streaming`, rather than showing an error.

---

### Task 14: Document it

**Files:**
- Modify: `README.md`
- Modify: `NOTES.md`

**Step 1: README**

Add the live link near the top, and a Deployment section covering: one container serving both
halves, why single origin (no CORS, and the page and stream wake together), `docker build` /
`docker run` for local use, and the environment variables with their defaults.

**Step 2: NOTES.md**

Add a short section recording what the platform check found, because it is a genuine interview
talking point:

- Render's proxy speaks HTTP/1.1 to the service, so native gRPC would not work there — and it
  does not matter, because Connect's server-streaming runs over HTTP/1.1 chunked transfer.
  The M0 choice of Connect over grpc-web paid off in a way nobody predicted at the time.
- The 100-minute request cap, and why a closed stream is now an expected state rather than an
  error.
- Whether the proxy buffered, with the answer found in Task 13.

**Step 3: Commit**

```bash
git add README.md NOTES.md
git commit -m "Document the deployment and what the platform check found"
git push
```

---

## Done when

- The link loads and streams within a few seconds, from a cold click, on a phone.
- `just test`, `just lint` and `just gen-check` are clean, and CI is green on `main`.
- The container runs locally with no Vite and no CORS.
- A stream cut at 100 minutes reconnects instead of erroring.
- `README.md` carries the live link and the CI badge resolves.

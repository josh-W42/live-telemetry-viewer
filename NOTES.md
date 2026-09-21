# Design and performance notes

Why this is built the way it is, and the measurements that justify it. The design
decisions come first; the M2-vs-M3 numbers they rest on start at [Method](#method).

Everything below that is a number was measured on one machine with one harness. Where a
claim is reasoned rather than measured, it says so.

## Design decisions

Organised around the questions in SPEC.md's "interview talking points", because those are
the decisions that actually shaped the thing.

### Why batch samples instead of one message per sample

Four channels at 1 kHz is 4,000 samples a second. Sent individually that is 1,000 Connect
messages a second, each carrying its own envelope, field tags, channel id and sequence
number, all to deliver 16 bytes of payload.

Encoding synthetic batches with the generated schema puts numbers on it:

| Batch interval | Samples/channel | Bytes/message | Bytes/sample | Messages/s | Wire rate |
|---|---|---|---|---|---|
| 1 ms | 1 | 149 | 37.3 | 1,000 | 145.5 KiB/s |
| 10 ms | 10 | 765 | 19.1 | 100 | 74.7 KiB/s |
| **50 ms** | **50** | **3,493** | **17.5** | **20** | **68.2 KiB/s** |
| 200 ms | 200 | 13,693 | 17.1 | 5 | 66.9 KiB/s |
| 1,000 ms | 1,000 | 68,097 | 17.0 | 1 | 66.5 KiB/s |

**Framing more than doubles the per-sample cost at one message per sample** — 37.3 bytes to
carry a 16-byte sample — and it is the message *count* that costs more than the bytes: 1,000
deserialisations a second on the receiving side, each waking the event loop.

**The returns stop almost immediately.** Going from 50 ms to a full second saves 2.5% of
bandwidth and adds up to a second of latency. 50 ms is past the knee: it amortises the
framing to within 3% of its floor while staying well under the eye's tolerance for a live
chart. The renderer requests a view about 30 times a second, so a batch is on screen within a
frame or two of arriving.

The per-sample floor of 17 bytes is set by the payload: an 8-byte double plus a
nanosecond timestamp, which is around 1.7 × 10¹⁸ and so takes 9 bytes as a varint. That is
also why the proto uses **packed parallel arrays** (`repeated int64 timestamps_ns` and
`repeated double values`) rather than a repeated submessage per sample — a submessage would
add a tag and a length prefix to every single reading.

Delta-encoding the timestamps would collapse them to one byte each, since they are a
constant 1 ms apart, and would take the wire rate to roughly half. It was not done: at
68 KiB/s the wire is not the bottleneck, and it would put a decoding step in front of the
one part of the pipeline that has to stay simple.

### Why raw data lives in a worker, not React or Redux state

Two separate reasons, and the second is the one that actually kills you.

**Memory representation.** Mode A held samples as `[timestampMs, value]` arrays and needed
**211 MB for 85,600 points** — about 2.5 KB per point, because every point is a JS array
object with its own header and two boxed numbers. The worker's ring buffers hold **2.4M
points in 36.6 MB** of packed `Float64Array`: 28× the data in a sixth of the space. Redux
would not change that representation, but it would forbid the one that fixes it, because a
store's contents have to be plain serialisable values, not views onto a shared buffer.

**Immutability is the wrong tool here.** Redux updates by producing a new value. At 20
batches a second that is 20 new arrays a second, each a copy of everything that came before,
plus a selector run and a React render per update — which is mode A's quadratic
re-serialisation with extra steps. Redux Toolkit's Immer would be doing structural sharing
over a million-element array twenty times a second.

So the split is: **the worker owns the samples, the store owns the questions**. The store
holds a view window, a set of hidden channel ids, and a short list of anomalies — a few
hundred bytes. Every slice carries a test asserting that no sample arrays ever appear in it,
so the boundary cannot erode quietly.

The third reason only became visible later: because ingestion is off the main thread, the
rules engine sees every sample even while the main thread is busy, the view is paused, or the
window is showing a ten-minute span in which a 30 ms spike is less than one drawn pixel.

### How LTTB works, and why it beats every-Nth

Largest-Triangle-Three-Buckets divides the series into roughly equal buckets and keeps one
point from each. The choice is what makes it work: for each bucket it picks the point forming
the **largest-area triangle** with the previously kept point and the average of the next
bucket. Area is a proxy for visual significance, so a point that departs from the local trend
wins over one sitting on it.

Every-Nth decimation picks by position, which means it picks by luck. `lttb.test.ts` makes
the contrast concrete: a 10,000-point series with a single spike at index 5,013, reduced to
200 points. LTTB keeps the spike exactly; naive decimation at the same budget steps straight
over it, and the test asserts both halves so the claim cannot rot.

That matters beyond aesthetics. An anomaly is precisely the narrow feature decimation drops,
and an anomaly you cannot see is indistinguishable from a broken detector. (The rules do not
depend on this — they run on ingestion — but the chart has to corroborate what the sidebar
claims, or nobody believes either.)

What LTTB is not: it is not a filter and it does not smooth. Every point it returns is a real
sample at a real timestamp. It also is not free of trade-offs — it can move a spike's
*apparent* width, since the samples either side of it are gone.

### Ring buffer sizing, and the memory math

Ten minutes of retention at 1 kHz is 600,000 samples per channel. Each sample is a timestamp
and a value, stored in two separate `Float64Array`s:

```
600,000 samples × 8 bytes × 2 arrays × 4 channels = 38,400,000 bytes = 36.6 MiB
```

Measured at 36.6 MiB, allocated once at startup and never grown. That is the whole point:
memory is decided before the first sample arrives, so the app's footprint is the same after
ten hours as after ten seconds. The 10-minute acceptance run bears it out — points held
plateaued at **2,399,800 against a theoretical 2,400,000** and stopped.

Two details that are not obvious:

**Timestamps are stored as nanosecond offsets from a base, not as absolute epoch
nanoseconds.** An absolute nanosecond timestamp is about 1.7 × 10¹⁸, well past
`Number.MAX_SAFE_INTEGER` (9.0 × 10¹⁵), so putting one in a `Float64Array` quantises it to
roughly 256 ns — at 1 kHz you would still be able to order samples, but the values would be
wrong. Offsets from a base fixed at startup stay small enough to be exact.

**Why not `Int32Array` for timestamps and `Float32Array` for values?** It would halve the
memory. A 32-bit float carries about seven significant digits, which is fine for a vibration
reading and marginal for a 3,200 K chamber temperature. The memory was not the constraint, so
the precision was kept.

### Backpressure: why the server drops instead of blocking

One simulator feeds a fan-out broadcaster; each subscriber gets a buffered channel eight
batches deep, which is 400 ms at a 50 ms interval. Publishing **never blocks**: if a
subscriber's buffer is full, the broadcaster discards that subscriber's *oldest* queued batch
and enqueues the new one.

The alternative — blocking until the slow subscriber catches up — makes one slow client the
rate limiter for the simulator and therefore for every other client. A background tab on a
throttled timer would stall the whole test stand. There is a test asserting exactly this: a
subscriber that never reads does not stop the others.

Three consequences worth stating:

**Oldest, not newest.** For live telemetry the recent data is the valuable data. A client
that falls behind should skip forward rather than work through a backlog it will never catch
up on.

**The sequence number is assigned at publish, not at send**, so a dropped batch leaves a
permanent hole in the numbering and the client can see exactly how much it lost. Losing data
silently would be far worse than losing it.

**The client counts batches, not stalls.** This was wrong until M6: the counter incremented
once per discontinuity, so a subscriber that lost four hundred batches in one stall was
reported identically to one that lost a single batch. `droppedSince` now returns
`next - last - 1`, with tests for the first batch, for a restarted stream that renumbers
backwards, and for sequence values past `Number.MAX_SAFE_INTEGER`.

### Canvas vs SVG vs WebGL

Canvas ships. SVG is measurable on the same harness — `worker-svg` in the benchmarks panel is
mode C with ECharts' SVG backend and nothing else changed — so the comparison is a
measurement rather than an argument.

**Measured: SVG costs about 15% more per render, with a 32% worse worst case and a lower fps
floor** — see [SVG vs canvas](#svg-vs-canvas). Still far closer than expected, and the
expectation being wrong is instructive.

The structural difference: canvas draws a polyline into a bitmap and the browser keeps
nothing per point. SVG creates retained DOM — a `<path>` whose `d` attribute holds every
vertex — which the browser must parse, keep in the layout tree, and re-serialise on every
update. The reason that costs so much less than it sounds is that ECharts emits **one path
per series, not one element per point**: 15,000 points become four elements. The retained-DOM
penalty everyone quotes is a penalty on element count, and a downsampled polyline does not
have one. SVG's advantages — crisp at any zoom, hit-testable, inspectable — are real, and
mostly irrelevant to a line replaced thirty times a second.

**WebGL is not warranted here, and it is worth being clear why.** The instinct is that
millions of points implies GPU. But LTTB already bounds points *rendered* at roughly two per
pixel — around 15,000 across four channels — regardless of how many are held. A GPU would
accelerate work that has already been eliminated.

The SVG measurement sharpens this rather than softening it. If the backend conventionally
considered unsuitable for large datasets still finishes ten minutes at 120 fps with no long
tasks, 15% behind canvas, then the rendering backend is a second-order effect at this
workload — and a GPU would be competing for a margin only somewhat larger than the one canvas
already holds over SVG.

WebGL starts to win when that bound stops holding:

- **Many series at once.** Forty channels rather than four is 150,000 points a frame, and the
  per-point cost begins to matter however it is rasterised.
- **Rendering where every point must be drawn**, such as a scatter plot or a density map
  where overplotting *is* the signal and downsampling would destroy it.
- **Per-point styling** — colour or size varying by value — which defeats the single-polyline
  fast path.

The route would be `echarts-gl`, which is not in the stack table and was not added, because
adding a dependency to solve a problem the architecture already solved is how projects get
heavy.

### What changes when Project 2 adds historical data

The seam is already in the right place. The main thread does not read samples; it asks for
`{ startNs, endNs, maxPoints, channelIds }` and receives an already-reduced series. It does
not know or care that a ring buffer answered.

**Routing.** The ring buffer covers the last ten minutes. Anything older is a query against
stored Parquet, and a window that straddles the boundary needs both, stitched. That
boundary is where the interesting bugs would live: duplicate samples at the seam, and the
fact that stored data is immutable while the live tail is still being written.

**Downsampling moves to the query side, and changes shape.** Reducing in the browser works
because the data is already there. You cannot ship ten hours of raw samples across the
network to downsample them at the far end — the reduction has to happen where the data is,
which means the storage engine.

That is not simply LTTB relocated. LTTB is **sequential**: each bucket's choice depends on
the point chosen for the previous one, so it does not decompose cleanly across partitions or
push down into a query engine. The usual answer is min/max-per-time-bucket, which is a plain
aggregation, parallelises trivially, and preserves spikes by construction — at the cost of a
line that looks slightly more jagged than LTTB's. Precomputed downsampled tiers (raw, 10 ms,
1 s, 1 min) are the other half of it: pick the tier whose resolution already matches the
requested window and the query stops scanning raw data at all.

**What stays.** Ring buffers, LTTB, the worker boundary and the rules engine are all
live-path concerns and are unaffected. The view request grows a source discriminator and
the worker grows a code path that awaits a network call instead of slicing an array.

## What M6 changed, and one thing it did not

Measured on the finished build: see [The M6 acceptance run](#the-m6-acceptance-run).

**The status bar exists** because the two numbers that carry the whole argument — points held
and points rendered — were previously visible only in a benchmark report. Watching held climb
past two million while rendered sits at 5,456 is the design explaining itself.

**Channel visibility is applied in the view request**, not the subscription. Re-subscribing
with a narrower channel list would restart the stream and discard the ring buffers, so
unticking a channel would destroy its history. Filtering where the data is means the worker
skips the slice and the downsample for a hidden channel — points rendered falls by a quarter
per channel, measured — while ingestion and rule evaluation carry on untouched. Tick a
channel back on and its full ten minutes is there, including any anomaly found while it was
hidden. There is a test for that combination.

**Mode C's connection indicator was fabricated.** It reported `streaming` whenever the
renderer was active, without asking whether the worker had connected, so a stopped server
still showed a healthy dot. The worker already posted `ready` and `error`; the renderer was
discarding both. It now forwards them, and stopping the server turns the indicator red with
the transport's own message.

### Per-channel axes, and what they cost

Unticking fuel flow changed the numbers on vibration's axis and tripled its apparent height,
because both sat on one `scale: true` axis that ECharts fits to whatever data is on it.
Visibility was an input to another channel's scale — a trace changing amplitude without its
data changing, which in a telemetry viewer is a correctness problem rather than a cosmetic
one. The same root cause produced the `g / kg·s⁻¹` label, where a tick reading 12 meant 12 of
something unstated.

Each channel now has its own axis at a fixed range the **server** declares, derived in `sim`
from the phase table and the fault amplitudes. Hardcoding four ranges in the client would
have been a fourth copy of simulator knowledge, after the thresholds in `rules.ts` and
`faults_test.go`, and the only one with nothing to fail when it drifted. A hidden channel's
axis is dimmed rather than removed, because an axis that collapsed would let the others slide
over, narrow the insets and change every trace's apparent width — horizontal instability in
place of vertical.

**Points rendered fell from 12,888 to roughly 11,100, for two reasons, and only one of them
is the axes.**

Four axes take about 224px of a ~1,600px chart. But the budget was also being computed from
the *element* width rather than the plot width, so it had always been asking for slightly
more points than the plot could show — about 2.5 per pixel instead of 2. With four axes that
would have become 3 per pixel, which is what made it visible. Both are now fixed: the budget
is `2 × plotWidth × visible channels`.

Neither is a regression. The first is the display getting narrower and the metric tracking
it, which is the property the figure exists to demonstrate. The second was drawing points
nobody could see.

**The trade the fixed axes make, stated plainly.** A fixed axis cannot zoom in on a small
excursion. Chamber temperature spans 0–4,000 K, so the thermocouple dropout — a fall to about
41 K — is a movement of 1% of the axis height. You can see *when* it happened and the sidebar
gives its depth to a decimal place, but clicking through to it shows a flat line near the
bottom rather than the shape of the dip. The old auto-scaling axis would have shown that
shape, at the cost of the instability above.

That is the deliberate trade and not a defect, but it is the thing to fix next if this were
going further: an opt-in "fit to window" toggle would restore per-channel autoscaling as
something the user asks for, rather than something that happens to them when they untick an
unrelated channel.

### A change that was reverted

While checking teardown, the server appeared to hold subscribers after pages went away, and
a plausible cause suggested itself: `Worker.terminate()` is not obliged to cancel a streaming
fetch the worker has in flight, so the server could go on counting a subscriber with nowhere
to deliver. A handshake was written — the worker acknowledges the abort, the main thread
terminates on the acknowledgement with a timeout as backstop.

Then it was tested against the counterfactual: the old teardown restored, three renderer
swaps, watching the server log. Every swap produced a clean disconnect and reconnect and the
count never exceeded one. `terminate()` does cancel the fetch. The extra subscribers were a
second browser tab and streams stranded by navigating a page away, which no React cleanup
path can reach in any case.

The handshake was reverted. It is recorded here because the sequence is the point: the
hypothesis was reasonable, the code worked, and it was still wrong to keep, because nothing
demonstrated the problem it solved.

### Not covered by tests

The extracted components in `web/src/components/` have no unit tests.
`@testing-library/react` is not in the stack table, and adding a dependency to assert that a
checkbox renders is a poor trade for what it would catch. They are covered by TypeScript and
by the manual walkthrough in the README. Everything with logic in it — the rule evaluator,
the ring buffer, LTTB, the view builder, the slices, the sequence counter, the benchmark
harness — is tested, which is where the bugs have actually been.

## Measurements

Measurements for the M2 vs M3 comparison. M2 renders naively on the main thread; M3
replaces it with a worker, ring buffers and LTTB. The value of these numbers depends
entirely on both milestones being measured the same way, so the method is recorded here
alongside the results.

## Method

- **Machine:** Windows 11, 16 logical cores, 32 GB RAM. Chromium 152, JS heap limit 4192 MB.
- **Environment:** host, not the dev container (see README). Server and Vite both local.
- **Server:** defaults — 4 channels at 1000 Hz, 50 ms batches, seed 1. 200 samples per
  batch, 20 batches per second, 4000 samples per second.
- **Harness:** `web/src/bench/`. Samples once a second: fps from `requestAnimationFrame`
  intervals, heap from `performance.memory`, freezes from a `longtask` PerformanceObserver,
  main-thread time spent inside `renderer.push`, and how many renders that time was spread
  across.
- **Stop conditions:** 10 minutes, or fps below 10 for three consecutive samples, or a
  single long task over 2000 ms.
- **Retention:** unbounded in both M2 modes. Growing memory is the phenomenon under test.

### Caveats worth stating up front

- `performance.memory` is non-standard, Chromium-only, and a coarse estimate. GC timing
  makes the series non-monotonic; the peak is more meaningful than any single reading.
  `performance.measureUserAgentSpecificMemory()` would be better but needs
  `crossOriginIsolated`, which this dev setup does not have.
- **ECharts' built-in `sampling: 'lttb'` is deliberately not enabled** in any mode. Letting
  the library downsample would hide the cost M3 exists to remove. It is also not a
  substitute: built-in sampling still requires every point to be in main-thread memory,
  whereas the M3 design bounds memory with ring buffers.
- **fps requires a visible window.** A hidden or backgrounded tab schedules no animation
  frames, so fps reads 0 regardless of how healthy the renderer is. The harness records
  visibility per sample and marks such a run `invalid` rather than `failed` — an early
  version of this reported a spurious failure from a hidden tab, which is exactly the kind
  of fabricated number that would not survive scrutiny.
- **Do not poll the page during a run.** Reading results mid-run executes on the same main
  thread being measured and puts artificial zeroes in the fps series. Runs below were
  started, left alone, and read only after finishing.

## Mode A — naive `setOption`

Every sample is kept in a plain JS array, and every batch hands ECharts the entire dataset
again. Quadratic over a run: batch *n* re-serialises everything the previous *n-1* batches
already sent.

**Result: failed after 22.0 s, holding 85,600 points.** That is roughly 21 seconds of data,
about 3.5% of the spec's 2.4M-point target.

| Time | Points held | Main thread busy | fps | Heap MB | Long tasks (max ms) |
|---|---|---|---|---|---|
| 1 s | 4,000 | 15% | 60 | 26 | 0 |
| 5 s | 20,000 | 28% | 60 | 40 | 0 |
| 9 s | 36,000 | 47% | 60 | 38 | 0 |
| 13 s | 52,000 | 71% | 60 | 90 | 0 |
| 15 s | 60,000 | 77% | 60 | 58 | 0 |
| 16 s | 64,200 | 96% | 0 | 115 | 2 (57) |
| 18 s | 70,600 | >100% | 2 | 183 | 15 (215) |
| 22 s | 85,600 | >100% | 1 | 211 | 27 (552) |

Summary: p50 fps 59.9, min 0. Heap 26 → 211 MB. 27 long tasks, longest 552 ms. Peak single
`push` 69.7 ms. Time to first bad sample: 16.1 s.

### What the numbers say

**The failure has a knee, not a slope.** fps sat at a solid 60 until 15 s and then fell off
a cliff within one second. Watching fps alone, the chart looks perfectly healthy right up
to the moment it is unusable — which is why fps is a poor early-warning signal.

**Main-thread busy time is the honest leading indicator.** It rose linearly and predictably
— 15% → 28% → 47% → 71% → 77% — crossing 100% at exactly the point fps collapsed. It was
telling us the answer ten seconds before fps did.

**Past saturation, busy time exceeds 100%.** Once the thread cannot keep up, the harness's
own 1-second `setInterval` stops firing on time, so a "one second" sample covers more than
a second of wall clock. The 407% reading at 22 s means roughly 4 seconds of `push` work
landed in one nominal sample. `peakBusyPercent` is clamped to 100 in the summary; the raw
series is not.

**Individual pushes never got catastrophically slow** — the worst was 69.7 ms. The problem
is not one slow call, it is 20 of them per second. Long tasks tell the same story from the
other side: 27 of them, up to 552 ms.

## Mode B — ECharts `appendData`

Only the new points are handed to the chart each batch, so none of mode A's quadratic
re-serialisation happens. The axis is advanced separately, throttled to once a second,
because `appendData` cannot move it (see the design note below).

**Result: it bought essentially nothing.** Main-thread cost tracked mode A almost exactly
at every point count.

| Points held | Mode A busy | Mode B busy |
|---|---|---|
| 4,000 | 15% | 17% |
| 20,000 | 28% | 32% |
| 36,000 | 47% | 52% |
| 52,000 | 71% | 72% |
| 60,000 | 77% | 73% |
| 72,600 | ~164% | 109% |
| **85,600** | **407%** | **354%** |

Mode B ran on to 818,000 points before its stop rule tripped, ending on a **single long
task of 41.3 seconds**. Heap peaked at 438 MB. But it was already past saturation at the
same place mode A was: at 85,600 points it was at 354% busy and 1 fps.

### Why the streaming API did not help

This was the surprise, and it is the most useful thing M2 produced.

If data *ingestion* were the bottleneck, mode B's cost would be roughly flat — it hands over
200 new points per batch regardless of how many came before. Instead its cost grew linearly
with total points, just like mode A. And the once-a-second axis update cannot explain it
either: that is 1 call in 20, so if it were the only expensive operation, mode B would have
cost about a twentieth of mode A.

**The bottleneck is drawing, not ingesting.** Rendering a polyline of 85,600 points means
traversing 85,600 points, every frame, whatever API delivered them. `appendData` optimises
the half of the problem that was not the problem.

That is the argument for M3 in one sentence: the fix is not a faster way to push points into
the chart, it is **not drawing most of them**. LTTB attacks *points rendered*; ring buffers
attack *points held*. A faster ingestion path attacks neither.

### Design note

`appendData` runs a restricted update cycle in which only data may be modified; coordinate
systems and axes are rebuilt only on a full update. So `appendData` alone **cannot advance a
scrolling time axis** — it feeds points in while the axis stays put. `AppendRenderer` pairs
it with a `setOption` carrying only `xAxis.min/max`, throttled to once a second. Series data
is deliberately excluded from that option, since including it would reset what `appendData`
accumulated.

### Open question

These runs do not separate `appendData`'s own cost from the axis update's. Isolating it —
a fixed axis and no `setOption` at all, which is not a usable live chart but is a clean
measurement — would confirm the drawing-cost explanation directly. The linear growth in
mode B is already strong evidence, since a per-batch-only cost could not produce it.

## Mode C — worker, ring buffers and LTTB

The stream, the retained samples and the downsampling all live in a worker. The main thread
receives only an already-reduced view, roughly twice the chart's pixel width per channel.

**Result: it does not degrade.** A 60-second run completed cleanly with the main thread
essentially idle.

| Points held | Mode A busy | Mode B busy | Mode C busy |
|---|---|---|---|
| 4,000 | 15% | 17% | 1.4% |
| 20,000 | 28% | 32% | ~1% |
| 36,000 | 47% | 52% | ~1% |
| 52,000 | 71% | 72% | ~1% |
| **85,600** | **407%** | **354%** | **~2%** |
| 238,200 | — (dead at 85,600) | — (dead at 85,600) | **1%** |

At the matched point count where both naive modes were saturated, mode C sat at about 2% of
the main thread and a full 60 fps — on the order of **200x less main-thread work for the same
data**.

Run summary: completed, 60.0 s, 238,200 points held, **7,744 rendered**, fps p50 59.7,
heap 25.1 → 45.5 MB peak, **zero long tasks**, peak 2.8% busy, longest single render 13.4 ms,
`visibilityLost: false`.

### The one number that matters

**Points rendered was 7,744 and stayed there** — flat from second 11 to second 60 while points
held grew sixty-fold.

That figure is 4 channels x 1,936, and 1,936 is twice the chart's width in pixels. Points
rendered is now a function of the display, not of the dataset. Everything else follows from
that: with the drawing cost pinned, holding more data costs only memory, and the ring buffer
bounds that too.

Memory tells the same story from the other side. M2 needed 211 MB to hold 85,600 points,
because each point was a two-element JS array with its own object header. The ring buffers
hold 2.4M points in **36.6 MB of packed Float64Array**, measured directly — roughly 28x the
data in a sixth of the space.

### The 10-minute acceptance run

Run by Josh in an ordinary browser window, since the automation pane could not stay visible
long enough. Status **completed** — the full 600 s, never stopped early.

| | Result | Acceptance criterion |
|---|---|---|
| Duration | 600.0 s, `completed` | — |
| fps | **p50 120, min 116.9** | 30+ |
| Long tasks | **0** | no multi-second freezes |
| Points held | **2,399,800** | ~2.4M (10 min at 1 kHz x 4) |
| Points rendered | 15,016 | — |
| Heap | 43.8 start, **93.5 peak**, 61.6 end | bounded |
| Peak main thread | 24.7% | — |
| Longest single render | 12.3 ms | — |
| `visibilityLost` | false | — |

**The ring buffer plateaued exactly at capacity.** 2,399,800 held against a theoretical
2,400,000 — the buffers filled and stopped. That is the bounded-memory claim demonstrated
rather than argued: the app can now run indefinitely without memory growing.

**Heap plateaued and then fell.** It peaked at 93.5 MB and *ended at 61.6 MB*, lower than its
peak, as GC reclaimed transient allocations. Mode A needed 211 MB to hold 85,600 points; mode
B reached 438 MB. Mode C holds **28x mode A's data in under half its memory**.

**0.63% of the data is drawn.** 15,016 rendered from 2,399,800 held. Note that 15,016 is 4 x
3,754, and 3,754 is twice the chart width in pixels on that machine — a wider window than the
60-second run above, which produced 7,744 on a narrower one. The relationship holds at both
widths, which is the point: **the figure tracks the display, not the dataset**.

**One honest wrinkle.** Peak main-thread cost was 24.7%, well above the 2.8% peak of the
shorter run. The per-render cost is essentially identical between them (12.3 ms vs 13.4 ms),
so the difference is how *often* a view is applied, not what one costs — that machine's 120 Hz
display drives the frame loop twice as fast, and it renders about twice as many points per
view. Neither figure is alarming at a 12 ms render, and fps never dropped below 116.9, but
the cost is not perfectly flat and should not be described as such. Worth confirming directly
rather than inferring, by logging applied-views-per-second.

The same run repeated on the finished build — with M5's rules and M6's status bar in place —
is [below](#the-m6-acceptance-run). Every acceptance figure matches; the main-thread cost
moved again, in a way this missing metric would have explained one way or the other.

## The M6 acceptance run

Ten minutes, mode C, on the finished build. Run in an ordinary foreground browser window,
`visibilityLost: false`, not polled while running, **completed** — never stopped early. Same
machine profile as the M3 acceptance run (120 Hz display), which is what makes the two
directly comparable where the A/B runs are not.

| | M3 (2026-09-16) | M6 (2026-09-16) | |
|---|---|---|---|
| Status | completed, 600.0 s | completed, 600.0 s | — |
| fps p50 / p95 / min | 120 / 120 / **116.9** | 120 / 120 / **116.9** | identical |
| Long tasks | **0** | **0** | identical |
| Points held | **2,399,800** | **2,399,800** | identical |
| Points rendered | 15,016 | 12,888 | narrower chart |
| Peak main thread | 24.7% | **27.3%** | **up** |
| Peak ms/s | 246.6 | **273.1** | **up** |
| Longest single render | 12.3 ms | **15.5 ms** | **up** |
| Heap start / peak / end | 43.8 / 93.5 / 61.6 | 132.8 / 155.9 / 51.3 | **up** |

Raw summaries: [`bench-results/m3-worker-10min.json`](bench-results/m3-worker-10min.json)
and [`bench-results/m6-worker-10min.json`](bench-results/m6-worker-10min.json).

### Every acceptance criterion is met, identically

fps p50, p95 and min match to the decimal. Zero long tasks. Points held plateaued at exactly
the same 2,399,800 against a 2,400,000 capacity. The run completed. Nothing the spec asks
for regressed, and the anomaly rules from M5 and the status bar from M6 are both in the
measured build.

**Points rendered fell because the chart is narrower, not because anything broke.**
12,888 is 4 × 2 × 1,611, so the plot was 1,611 px wide; M3's 15,016 is 4 × 2 × 1,877. The
266 px went to the side column — channel list and anomaly sidebar — which did not exist when
the M3 run was taken. The figure is still exactly twice the pixel width per channel, now
confirmed at a third chart width. That is the claim holding, not slipping.

### Main-thread render cost went up, and it is worth saying why that is interesting

Peak went from 24.7% to 27.3% of the main thread, and the longest single render from 12.3 ms
to 15.5 ms.

The interesting part is the direction. This run drew **14% fewer points** and cost **11%
more**. Normalised, that is a **29% increase in peak main-thread milliseconds per point
rendered** (0.0164 → 0.0212 ms/s per point) and a 47% increase in the longest single render
per point. Two figures derived independently, pointing the same way.

**M5's rule evaluation is not the cause, and this run settles that.** `RenderTimer` wraps
`chart.setOption` and nothing else, so it cannot see worker-side work at all. Rules run in
the worker, on ingestion; they add nothing to the main thread by construction, and the
measurement is consistent with that. That was M5's outstanding regression check, and it
passes.

But M5 did not only add rule evaluation. It added **drawing** — and two specific things
entered the timed path between the M3 run and this one:

1. **`setAnomalies` triggered a full `setOption` at 2 Hz whether or not anything changed.**
   The worker resends the whole anomaly list on every stats message, the store replaced it
   wholesale, and a fresh array identity propagated through the selector into the effect that
   redraws the bands. Twice a second, a complete `setOption` to redraw bands that were
   already correct.
2. **`markArea` data now rides along on every frame's `setOption`**, and `markAreas()` was
   being called *inside* the per-channel map — so each frame rebuilt all four channels' band
   sets four times over, refiltering the anomaly list sixteen times instead of four.

Both are now fixed: the reducer keeps the existing array when the content is unchanged (with
tests asserting array identity is preserved, and asserting it is *not* preserved while an
open anomaly's end and peak are still moving), and the band set is built once per frame.

**Neither fix is measured here.** They land after the run above. A later run on the fixed
build settled it: at identical points rendered, peak cost fell 9.0% and the longest render
18.7%, back to within 0.7% of M3 — [see below](#what-the-counted-runs-settled). The
hypothesis is recorded in the order it happened, because a fix presented as a result hides
whether anyone checked.

There is also a cheaper explanation available that nothing in the run above rules out: **more
renders per second**. `peakMsPerSec` is a peak, not a mean, and at the time the harness did
not record how often a view was applied — so a run that simply landed more renders in its
busiest second would show exactly this shape.

**The harness now records it.** See [Attributing render cost](#attributing-render-cost).

**None of this is alarming at the scale involved.** 27.3% peak means the thread was idle
roughly three quarters of its busiest second, fps never fell below 116.9, and there were no
long tasks. It is recorded because "the cost is flat" would be a stronger claim than the data
supports, and the honest version — bounded, small, and up slightly for identifiable reasons —
is the one that survives being asked about.

### Heap is higher, and still bounded

155.9 MB peak against 93.5, starting from 132.8 rather than 43.8. The bounded-memory claim is
untouched: it plateaued, and it **ended at 51.3 MB, below where it started**, as GC reclaimed
transients.

The likely cause of the higher starting point is a change in how the page behaves rather than
in what it retains. The viewer now streams on load, so by the time the run began there was
already a worker with full ring buffers; starting a run disposes the renderer and builds a
fresh one, and the old allocation had not yet been collected. In the M3 run the page held no
subscription at all until the run started, so it began from a genuinely cold heap.

That is a hypothesis about a `performance.memory` reading, which is a coarse Chromium-only
estimate to begin with. The figure that carries the claim is points held, and it plateaued
exactly where it was designed to.

## Attributing render cost

Having the same question left open twice — M3's "one honest wrinkle" and M6's cost increase —
was enough. `RenderTimer` now counts renders as well as timing them, so every run reports:

| Figure | Meaning |
|---|---|
| `push.rendersAtPeak` | Renders in the busiest second |
| `push.meanMsAtPeak` | Mean milliseconds per render **in that same second** |
| `push.peakRendersPerSec` | The most renders any second carried |

All read off one sample rather than three independent maxima, or they would describe three
unrelated moments and could not be divided into each other. There is a test asserting exactly
that, and one feeding two runs with identical `pushMsTotal` but different render counts to
confirm the summary tells them apart.

`Sample.renders` carries the per-second figure, so the full series shows how the rate moved
across a run rather than only at its peak.

### Two counters, deliberately

`takeRenderStats()` resets what it returns, which is right for a once-a-second sampler and
wrong for anything else. The status bar also wants a render rate, and if the two shared that
accumulator, whichever polled first would silently consume the other's data — the harness
would report a fraction of the work actually done, with nothing to indicate it.

So `RenderTimer` keeps a second, cumulative count that `take()` never touches, exposed as
`renderCount()`. The status bar differences it; the harness keeps the resetting one. A test
asserts that taking the stats leaves the lifetime count alone, and that it never decreases,
so a rate differenced from it cannot come out negative when a renderer is swapped.

### What the counted runs settled

Three 10-minute canvas runs, the last two on the current build:

| Run | Points rendered | Peak ms/s | **Mean ms/render** | Longest render |
|---|---|---|---|---|
| M3 | 15,016 | 246.6 | 8.22 *(inferred)* | 12.3 ms |
| M6, before the fixes | 12,888 | 273.1 | 9.10 *(inferred)* | 15.5 ms |
| **M6, after the fixes** | **12,888** | **248.4** | **8.28 (measured)** | **12.6 ms** |

The prediction written here before that last run was: *below 9.10 ms means the two post-run
fixes account for the increase; 9.10 ms means they do not.*

**Measured: 8.28 ms.** The fixes account for it. At **identical** points rendered — 12,888 in
both — peak main-thread time fell 9.0% and the longest single render fell 18.7%, putting the
build back within 0.7% of M3's cost while carrying M5's rules, M5's anomaly bands and M6's
status bar on top.

So the M6 increase was neither slower rendering inherent to the new features nor more renders
landing in the busiest second. It was two avoidable pieces of main-thread work: a 2 Hz store
churn that redrew unchanged anomaly bands, and a band set rebuilt once per channel instead of
once per frame. Both were identified by reading the numbers, and confirmed by a run designed
to falsify the explanation.

### The metric behaved, and made the diagnosis possible

`30 renders × 8.28 ms = 248.4 ms/s` exactly, as `30 × 9.54 = 286.2` did for SVG. Every run
now reconciles.

**The frame loop reaches its ceiling.** `FRAME_INTERVAL_MS` is 33, so the loop asks for a view
at most about 30 times a second, and 30 is what all three runs got. The round trip is not the
limit on this hardware — the throttle is. (An embedded automation pane gave 4 renders a
second, which is a property of that pane. The loop holds only one view request open at a time,
deliberately, so a worker that has not answered is never queued more work; when the worker is
slow, this number says so.)

**`peakRendersPerSec` is 32 while `rendersAtPeak` is 30** in both counted runs, so the busiest
second was never the second with the most renders. That is exactly the distinction the metric
exists to draw, and why the three peak figures are read off one sample rather than three
maxima.

### An observation the counter surfaced: cost per render is nearly flat

M3 rendered 15,016 points at an inferred 8.22 ms per render. The post-fix run rendered 12,888
— 17% fewer — at a measured 8.28 ms. Those are within 0.7% of each other.

If that holds, **per-render cost at these counts is dominated by fixed `setOption` overhead**,
not by the number of points in the series: option merging, coordinate-system rebuild and
series diffing, all of which happen whether the line has 3,000 vertices or 3,800. It would
also mean the "per point rendered" normalisation used elsewhere in this document is the wrong
lens below some threshold, and that the honest comparison between two runs is mean ms per
render.

Stated as an observation, not a finding: one side of it is inferred, and two points do not
establish a curve. The test is cheap and obvious — vary the window width, which varies
`maxPoints` directly, and watch whether `meanMsAtPeak` moves with it. That is the next thing
worth measuring, and it would say where the fixed-cost floor gives way to per-point cost.

## SVG vs canvas

`worker-svg` is mode C with `echarts.init(..., { renderer: "svg" })` and no other change —
same worker, same ring buffers, same LTTB, same point budget. One variable moves.

Both runs are ten minutes on the same build and the same machine, foreground window,
`visibilityLost: false`, **completed**, and both record renders, so they can be compared per
render rather than per second.

| | Canvas | SVG | |
|---|---|---|---|
| Points rendered | 12,888 | 12,728 | matched to 1.2% |
| Renders at peak | 30 | 30 | identical |
| **Mean ms per render** | **8.28** | **9.54** | **+15.2%** |
| Peak ms/s | 248.4 | 286.2 | +15.2% |
| Longest single render | 12.6 ms | **16.6 ms** | **+31.7%** |
| fps p50 / p95 | 120 / 120 | 120 / 120 | identical |
| fps **min** | 117.9 | **93.3** | **−21%** |
| Long tasks | 0 | 0 | identical |
| Points held | 2,399,800 | 2,399,800 | identical |

Raw: [`m6-worker-canvas-10min-postfix.json`](bench-results/m6-worker-canvas-10min-postfix.json)
and [`m6-worker-svg-10min.json`](bench-results/m6-worker-svg-10min.json).

Both runs sat at 30 renders in their busiest second, so **mean milliseconds per render is a
like-for-like comparison** and the 1.2% difference in points rendered does not need
normalising away. This is the cleanest comparison in this document: one variable, matched
workload, matched render counts, same machine, same day.

> **Correction.** An earlier version of this section reported SVG as costing about 6% more,
> comparing it against the canvas run taken *before* the two markArea fixes. The SVG run was
> taken after them, so that comparison understated canvas by exactly the amount the fixes had
> recovered. Against the right baseline the gap is 15.2%, and the worst case 31.7% rather
> than 7.1%. The conclusions below survive the correction; the numbers did not, and the
> mistake was comparing two runs that differed in two things while describing it as one.

### SVG costs about 15% more, which is still less than expected

The prediction in this document, written before the run, was that SVG would be *dramatically*
worse — because it "creates retained DOM the browser must parse, keep in the layout tree, and
re-serialise on every update." The reasoning was sound and the magnitude was wrong, because it
assumed **DOM per point**.

ECharts does not do that for a line series. Fifteen thousand points become four `<path>`
elements with long `d` attributes, not fifteen thousand elements. The per-point work is
string building rather than node creation, and string building is not an order of magnitude
dearer than writing coordinates into a canvas path. The retained-DOM cost that makes SVG
famously unsuitable for large datasets is a cost of **element count**, and LTTB plus a
polyline representation keeps element count at four.

**SVG loses hardest on the tail.** A 31.7% worse worst case against a 15.2% worse average,
and an fps floor of 93.3 against 117.9. Its typical frame is somewhat dearer; its occasional
frame is much dearer, presumably where the browser reflows or re-parses rather than simply
repainting. 93.3 fps is still three times the acceptance target with zero long tasks, so this
is a tail worth naming rather than a failure.

**Canvas ships**, on a 15% average margin, a 32% worst-case margin, and a better floor. But
the more useful conclusion is about scale: **at this workload the backend is a second-order
effect.** Bounding points rendered by the display did so much of the work that the backend
conventionally considered unsuitable still finishes ten minutes at 120 fps with no long
tasks. That is a stronger argument for the architecture than a lopsided result would have
been — and it sharpens the WebGL discussion, since a GPU would be competing for a margin only
somewhat larger than the one canvas already holds over SVG.

**On heap:** SVG peaked at 108.5 MB and canvas at 116.7, from starts of 47.4 and 76.0. That
is not a memory comparison worth making — `performance.memory` is a coarse Chromium-only
estimate, and the two runs did not begin from comparable states. The figure carrying the
memory claim is points held, and both plateaued at 2,399,800.

## Two measurement flaws this work exposed

**A watchdog cannot stop a frozen main thread — and I initially claimed it could.**

Mode B was given a 60-second limit and ran about 18 minutes: once the thread saturates, the
harness's one-second `setInterval` is starved and the stop conditions never evaluate. The
first write-up called this a fixable flaw and proposed moving the watchdog into the worker.
That was wrong. A worker can *detect* a frozen main thread but cannot *act* on it, because
acting means running code on the thread that is frozen. The harness already stopped at its
first opportunity; there was no earlier opportunity to take. The honest statement is that
wall-clock duration cannot be bounded when the page freezes, and the long-task series is what
quantifies the freeze afterwards.

**A visible page is not necessarily a rendering page.**

A 10-minute mode C run reported "fps below 10 for 3 consecutive samples" while the main thread
was 98% idle — 1.8% peak busy, zero long tasks, 8.1 ms max render. No renderer that idle can
miss a frame budget, so the reading was an artifact.

`document.hidden` stays `false` when a desktop application hides a pane behind another, but
the compositor stops scheduling animation frames. fps therefore reads 0 while the visibility
guard sees a perfectly healthy page. Samples now record the **frame count**, and zero frames
across consecutive samples *with an idle main thread* marks the run `invalid`. A genuinely
frozen renderer also paints nothing, but it is never idle while doing so — that is what
distinguishes the two, and there is a test for each case.

## Measurement conditions, stated honestly

- Both runs were visible throughout (`visibilityLost: false`) and neither was polled while
  running.
- Each run had one other idle tab open on the same origin, which Chrome may place in the
  same renderer process. Both runs were affected similarly, and the effect cannot account
  for a difference of the size being claimed — but the runs are not pristine.
- Mode A's failure is a clean measurement. Mode B's *later* samples are distorted by the
  starvation described above; its readings up to 85,600 points are sound, and that is the
  range the comparison above uses.
- Mode C's 60-second run is clean: `completed`, visible throughout, frames scheduled
  throughout, not polled while running.
- The M6 canvas and SVG runs are both clean and `completed`, `visibilityLost: false`, on the
  same machine as each other and as the M3 acceptance run. The canvas/SVG comparison is the
  only one here where two runs were taken specifically to be compared, with one variable
  changed between them; it is also the only pair that landed on matched points rendered
  without needing normalising.
- **The M3 and pre-fix M6 runs did not record renders per second** — the counter post-dates
  both — so their per-render costs are inferred at an assumed 30 renders/s, and are marked
  that way wherever they appear. The two later runs measure it, and both came in at 30, which
  is what makes the assumption a reasonable one rather than a convenient one.
- **The SVG and post-fix canvas runs are the only pair here that differ in exactly one thing.**
  An earlier version of this document compared SVG against the *pre-fix* canvas run, which
  differed in two, and understated canvas by the size of the fixes. That comparison is
  corrected in the SVG section, with the error left on the record.
- Mode C's 10-minute acceptance run is clean and `completed`, with `visibilityLost: false`.
  It was run on a **different machine profile** from modes A and B — a 120 Hz display and a
  wider window. That does not affect the headline conclusions, which rest on points held,
  points rendered and long tasks, but the fps and busy-percent figures are not directly
  comparable to the A/B runs and are not used that way above. The matched-point comparison
  between all three modes comes from the 60-second run on the original machine.
- **Long runs could not be completed under automation.** The browser pane used to drive these
  measurements is occluded whenever the desktop window's focus moves, which stops frame
  scheduling and invalidates the run — correctly, but it means long runs need an ordinary
  browser window left in the foreground rather than the automation pane.

### Raw results

All four 10-minute runs are committed:
[`m3-worker-10min.json`](bench-results/m3-worker-10min.json),
[`m6-worker-10min.json`](bench-results/m6-worker-10min.json) (canvas, before the fixes),
[`m6-worker-svg-10min.json`](bench-results/m6-worker-svg-10min.json) and
[`m6-worker-canvas-10min-postfix.json`](bench-results/m6-worker-canvas-10min-postfix.json).

### Reproducing these numbers

```
just server        # terminal 1
just web           # terminal 2
```

Open <http://localhost:5173> in a normal browser window — not an embedded pane, which gets
occluded and invalidates runs. Expand **Benchmarks** at the foot of the page, pick a mode,
press **Run 10 min**, and leave the window in front and untouched. Press **Download JSON**
for the full sample series. Do not interact with the page while a run is in progress: doing
so executes on the very thread being measured.

**An idle page holds no subscription.** The viewer streams on load in mode C and stops the
moment you press **Disconnect** or switch tabs — the server's subscriber count returns to
zero, which the server log shows directly. The two naive baselines do not stream unless a run
is driving them or **feed this baseline when idle** is ticked, because feeding a naive
renderer continuously degrades the page to unusability within minutes and would leave each run
starting from whatever the last one left behind.

**The status bar reads live during a run**, and its frame meter keeps running while one is in
progress rather than deferring to the run's own figure — the status bar ships with the app,
so measuring the app without it would measure something nobody runs. The cost is one
timestamp push per frame.

## What this says about the architecture

Four renderers, one harness, one machine:

- **A and B differ by almost nothing.** Swapping the ingestion API for the library's
  purpose-built streaming path moved the curve by a few percent. The bottleneck was never
  ingestion.
- **C differs by two orders of magnitude.** Not because it pushes points faster, but because
  it stops pushing most of them at all.
- **C on canvas and C on SVG differ by 15%.** Once points rendered is bounded by the display,
  even the rendering backend — the thing the question "canvas or SVG?" assumes is decisive —
  is a second-order effect.

The lesson generalises past this project: when a naive implementation is slow, the instinct is
to look for a faster API doing the same work. Mode B is what that instinct produces, and it
bought nothing measurable. What worked was changing *what work exists* — bound the points
drawn by the display rather than the dataset, bound the points held by a fixed allocation, and
move both off the thread that has to stay responsive.

The end state, in one line: **mode A died after 22 seconds holding 85,600 points in 211 MB.
Mode C ran 10 minutes holding 2,399,800 points in 93.5 MB at 120 fps with zero long tasks** —
28x the data, under half the memory, and it stopped growing because it was designed to.

## Original M3 target

M3 must beat both modes on the same harness, and the bar is low: both saturated the main
thread at about 85,600 points, roughly 21 seconds of data. The real target is the spec's
acceptance criterion — 4 channels at 1 kHz for 15+ minutes, a 10-minute window visible,
30+ fps, no multi-second freezes. That is roughly 2.4M points, about 28x what either naive
renderer managed.

The two numbers to watch:

- **Points rendered** — LTTB should hold this near `2 × widthPx`, a few thousand, no matter
  how many points are held. Mode B proved this is the one that matters.
- **Main-thread busy time** — should stay flat as points held grows, instead of climbing
  linearly. In both M2 modes this crossed 100% at about 85,600 points.

Both M2 modes remain available behind the render-mode toggle, so the comparison can be
re-run on the same machine at any time rather than trusted from this document.

# Performance notes

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
  and main-thread time spent inside `renderer.push`.
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

### Still outstanding

The **10-minute acceptance run has not been completed**. See the measurement note below: the
automation browser pane keeps being occluded, and a run that cannot schedule animation frames
measures nothing. The 60-second run is valid and is what the figures above come from.

What the long run would add: confirmation that points held plateaus at the ring buffer
capacity (2.4M) rather than growing, that heap plateaus with it, and that 30+ fps holds with a
full 10-minute window on screen.

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
- **Long runs could not be completed under automation.** The browser pane used to drive these
  measurements is occluded whenever the desktop window's focus moves, which stops frame
  scheduling and invalidates the run — correctly, but it means the 10-minute acceptance run
  needs an ordinary browser window left in the foreground rather than the automation pane.

### Reproducing these numbers

```
just server        # terminal 1
just web           # terminal 2
```

Open <http://localhost:5173> in a normal browser window, pick a mode, press **Run 10 min**, and
leave the window in front and untouched. Press **Download JSON** for the full sample series.
Do not interact with the page while a run is in progress: doing so executes on the very thread
being measured.

## What this says about the architecture

Three renderers, one harness, one machine:

- **A and B differ by almost nothing.** Swapping the ingestion API for the library's
  purpose-built streaming path moved the curve by a few percent. The bottleneck was never
  ingestion.
- **C differs by two orders of magnitude.** Not because it pushes points faster, but because
  it stops pushing most of them at all.

The lesson generalises past this project: when a naive implementation is slow, the instinct is
to look for a faster API doing the same work. Mode B is what that instinct produces, and it
bought nothing measurable. What worked was changing *what work exists* — bound the points
drawn by the display rather than the dataset, bound the points held by a fixed allocation, and
move both off the thread that has to stay responsive.

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

# Per-channel y-axes

**Status:** designed, approved 2026-09-20. Implementation plan to follow.

## The problem

Unticking fuel flow changes the numbers on vibration's axis, and vibration's trace visibly
triples in height — without a single vibration sample changing.

`axisIndexFor()` in `web/src/render/types.ts` puts two channels on each y-axis:

| Axis | Channels | Nominal range |
|---|---|---|
| 0 (left, `psi / K`) | `chamber_pressure`, `chamber_temp` | ~0–1,000 psi and ~95–3,200 K |
| 1 (right, `g / kg·s⁻¹`) | `vibration`, `fuel_flow` | ~0–6 g and ~0–18 kg/s |

Both are `scale: true`, so ECharts fits each axis to whatever data is currently on it. Hide
fuel flow and axis 1 refits to vibration alone. **Visibility is an input to another channel's
scale**, which for a telemetry viewer is a correctness problem, not a cosmetic one: a trace
that changes apparent amplitude when its data did not is misread.

A second flaw is already present before anything is toggled. The axis is labelled
`g / kg·s⁻¹` — two units on one axis — so a tick reading "12" is ambiguous. Both flaws have
the same root cause: **unlike channels sharing an auto-scaled axis.**

## The requirement

> A trace must never change apparent amplitude unless its own data changed.

Chosen over the alternative reading ("hiding a channel should give the rest more room"). It
is the stricter requirement and it rules out anything that redistributes space, since a
taller row enlarges a trace just as surely as a rescaled axis does.

## Approach

One y-axis per channel, with a range the server declares. Considered and rejected:

- **Keep two axes, make their range ignore visibility.** Smallest possible change and it does
  fix the reported bug, but leaves the ambiguous unit label, and hiding fuel flow would then
  gain nothing beyond removing one line.
- **Stacked rows, one grid per channel.** Better architecture and the only option that
  survives forty channels; `SPEC.md` explicitly permits it. Deferred as disproportionate at
  four channels — it makes `markArea`, the gesture maths and axis-pointer linking all
  per-grid, and that gesture code is where the zoom-out bug lived.

### 1. Two option builders

`baseOption` stays exactly as it is and continues to serve `naive.ts` and `append.ts`. A new
`viewerOption(channels)` serves `WorkerRenderer`.

Not an edit to the shared builder: modes A and B are frozen references whose numbers are
quoted throughout `NOTES.md`, and changing what they draw would make those numbers
unreproducible.

### 2. The range comes from the server

`Channel` gains two fields:

```proto
double display_min = 5;
double display_max = 6;
```

`sim` derives them from its own phase table, the fault amplitudes in `faults.go`, and a sigma
allowance, rounded outward to tidy numbers. Expected: pressure 0–1,250 psi, temperature
0–4,000 K, vibration 0–15 g, fuel flow 0–20 kg/s.

Deriving them server-side rather than hardcoding them in the client is the point. Thresholds
are already duplicated between `web/src/worker/rules.ts` and `server/internal/sim/faults_test.go`,
and that duplication is flagged as a hazard in both files. A third copy — axis ranges encoding
what the simulator can produce — would be worse, because nothing would fail when it drifted.
Derived in `sim`, a new fault widens its own axis automatically.

### 3. Four axes, one per channel

Pressure and temperature on the left, vibration and fuel flow on the right, the second on each
side offset outward. `yAxisIndex: i` by position, replacing `axisIndexFor`. Explicit
`min`/`max` from the channel metadata; no `scale: true`.

Each axis carries **its own unit**, which resolves the `g / kg·s⁻¹` ambiguity, and is **tinted
with its channel's colour** from the existing `colorFor`. The tinting is what makes four axes
readable rather than cluttered — it is the standard telemetry idiom and it removes any need to
trace a line back to a legend.

### 4. A hidden channel's axis is dimmed, never removed

This is the part that delivers the requirement, and the easy thing to get wrong.

Collapsing a hidden channel's axis would let the remaining axes slide over, shrinking the grid
insets and widening the plot — so **every** trace would change apparent width and position.
That trades vertical instability for horizontal. The axis therefore keeps its slot and is
greyed out.

Plot geometry is then constant regardless of what is ticked, which also means the gesture
maths cannot be perturbed by toggling a channel.

### 5. Grid insets derived in one place

`viewerOption` computes its insets from the axis count and exports them. `WorkerRenderer` uses
those for `plotFraction` and panning instead of the module-level `GRID_LEFT`/`GRID_RIGHT`.

Today `grid: { left: 64, right: 64 }` and `export const GRID_LEFT = 64` are two independent
literals that happen to agree. They feed the pixel-to-time mapping for zoom and pan — the code
the zoom-out bug lived in — so they should not be able to disagree.

### 6. The ECharts legend goes, in the viewer only

It is a second visibility control: clicking it hides a series without the store knowing,
leaving the chart and the channel list disagreeing. The checkboxes are the one authority.
`baseOption` keeps its legend, since modes A and B have no channel list.

## Files

| File | Change |
|---|---|
| `proto/telemetry/v1/telemetry.proto` | `display_min`, `display_max` on `Channel` |
| `server/internal/sim/range.go` | New. Derive each channel's display range |
| `server/internal/sim/sim.go` | `Channel` carries the range |
| `server/internal/stream/service.go` | Map the two new fields |
| `web/src/render/types.ts` | `viewerOption`, derived insets; `baseOption` untouched |
| `web/src/render/worker.ts` | Use `viewerOption` and its insets; dim hidden axes |

Regenerate with `just gen`; `just gen-check` must stay clean.

## Tests

**Go (`range_test.go`)**
- Every channel's declared range contains every value the simulator emits across several
  loops, faults included. This is the property that matters: an axis that clips a fault would
  hide the thing the viewer exists to show.
- The range is not more than about 2x the observed extreme, so the axis is not mostly empty.
- A channel with no fault still gets headroom above its noise.

**TypeScript (`types.test.ts`)**
- Each channel gets its own axis index, in declaration order.
- **The axis configuration is identical regardless of which channels are visible.** The
  requirement, written as an assertion.
- **Grid insets are identical regardless of which channels are visible.**
- Axis ranges come from the channel metadata, not from the data.

## Consequences

**Points rendered will fall.** Four axes cost roughly 110px of ~1,600px plot width, and points
rendered is `2 x widthPx` per visible channel, so expect about 12,000 in place of 12,888. That
is the display getting narrower, not a regression. It needs a line in `NOTES.md` or it will be
misread as one later — and it is a neat demonstration of the claim that the figure tracks the
display rather than the dataset.

**The benchmark comparison stays valid** because modes A and B are untouched, and mode C's
change is to chart configuration rather than to ingestion, retention or downsampling.

## Out of scope

Stacked rows. Per-channel manual scale overrides. Any change to ingestion, ring buffers, LTTB,
the rules engine, or what modes A and B measure.

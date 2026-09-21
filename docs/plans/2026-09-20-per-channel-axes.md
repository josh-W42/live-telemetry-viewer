# Per-Channel Y-Axes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every channel its own y-axis with a server-declared fixed range, so hiding one channel can never change another channel's scale, apparent amplitude, or axis numbers.

**Architecture:** The simulator derives each channel's display range from its own phase table and fault amplitudes and ships it in the `Channel` proto message. The viewer draws one axis per channel, tinted with that channel's colour, at a fixed range. Hiding a channel dims its axis but never removes it, so plot geometry is constant. Modes A and B keep the old two-axis chart untouched, because their numbers are quoted throughout `NOTES.md`.

**Tech Stack:** Go 1.27, Connect/protobuf, buf; Vite + React + TypeScript, ECharts 6, Vitest.

**Design doc:** `docs/plans/2026-09-20-per-channel-axes-design.md`

---

## Background the executor needs

**`just` runs everything.** `just test` (Go + web), `just lint` (buf lint, go vet, tsc), `just gen` (regenerate from proto), `just gen-check` (fails if committed codegen is stale). Generated code is committed — always run `just gen` after a proto change and commit the result.

**A single Go test:** `cd server && go test ./internal/sim/ -run TestName -v`
**A single web test:** `cd web && npx vitest run src/render/types.test.ts -t "partial name"`

**Do not touch** `baseOption`, `naive.ts` or `append.ts` beyond what Task 9 specifies. Those two renderers are frozen references for the M2/M3 comparison in `NOTES.md`.

**Commit messages:** no `Co-Authored-By` or other attribution trailers (see `CLAUDE.md`).

---

### Task 1: Add the display range to the proto

**Files:**
- Modify: `proto/telemetry/v1/telemetry.proto`
- Regenerate: `server/gen/`, `web/src/gen/`

**Step 1: Add the fields**

In `message Channel`, after `sample_rate_hz`:

```proto
  // Suggested y-axis span for a viewer, wide enough to contain every value this
  // channel can produce including injected faults. Sent by the server so the
  // client never has to encode what the simulator can do: a new fault widens
  // its own axis without anything else being edited.
  double display_min = 5;
  double display_max = 6;
```

**Step 2: Regenerate and verify**

Run: `just gen && just gen-check`
Expected: both succeed, `git status` shows modified files under `server/gen/` and `web/src/gen/`.

**Step 3: Commit**

```bash
git add proto server/gen web/src/gen
git commit -m "Add a display range to the Channel message"
```

---

### Task 2: Extract the nominal-value lookup in sim

Pure refactor with no behaviour change, so the existing simulator tests are the safety net. It exists because Task 3 needs to call the per-channel base/sigma functions by channel ordinal, and that switch currently only exists inline in `value()`.

**Files:**
- Modify: `server/internal/sim/sim.go`

**Step 1: Add the helper**

Above `value()`:

```go
// nominal returns a channel's base value and noise sigma before faults, the
// vibration carrier, or clamping. Split out of value() so the display-range
// derivation can walk the same functions the generator uses, rather than
// restating their ranges somewhere that could drift.
func nominal(channel uint64, phaseName string, p float64) (base, sigma float64) {
	switch channel {
	case chPressure:
		return pressure(phaseName, p)
	case chTemp:
		return temperature(phaseName, p)
	case chVibration:
		return vibration(phaseName, p)
	case chFuelFlow:
		return fuelFlow(phaseName, p)
	}
	return 0, 0
}
```

**Step 2: Use it in `value()`**

Replace the opening switch of `value()`:

```go
func (s *Simulator) value(channel uint64, phaseName string, p float64, loop, index int64, elapsed float64) float64 {
	base, sigma := nominal(channel, phaseName, p)
```

(Delete the `var base, sigma float64` declaration and the four-case switch it fed.)

**Step 3: Verify nothing moved**

Run: `cd server && go test ./internal/sim/ -v`
Expected: PASS, including the determinism test — a refactor that changed a value would fail it.

**Step 4: Commit**

```bash
git add server/internal/sim/sim.go
git commit -m "Extract the nominal-value lookup so the range derivation can reuse it"
```

---

### Task 3: Derive each channel's display range

**Files:**
- Create: `server/internal/sim/range.go`
- Create: `server/internal/sim/range_test.go`

**Step 1: Write the failing test**

`server/internal/sim/range_test.go`:

```go
package sim_test

import (
	"math"
	"testing"

	"github.com/josh-W42/sift/server/internal/sim"
)

func observedExtremes(t *testing.T, s *sim.Simulator, loops int64) map[string][2]float64 {
	t.Helper()

	out := map[string][2]float64{}
	for _, ch := range s.Range(0, loopSamples()*loops) {
		lo, hi := math.Inf(1), math.Inf(-1)
		for _, v := range ch.Values {
			lo = math.Min(lo, v)
			hi = math.Max(hi, v)
		}
		out[ch.ChannelID] = [2]float64{lo, hi}
	}
	return out
}

/*
The property the whole change rests on.

The axis range is fixed, so anything outside it is invisible. An axis that
clipped a fault would hide precisely the thing the viewer exists to show — and
it would do so silently, since a clipped trace still looks like a trace.
*/
func TestDisplayRangeContainsEveryValueTheSimulatorProduces(t *testing.T) {
	s := newSim(31)
	extremes := observedExtremes(t, s, 8)

	for _, c := range s.Channels() {
		lo, hi := extremes[c.ID][0], extremes[c.ID][1]

		if lo < c.DisplayMin || hi > c.DisplayMax {
			t.Errorf("%s: data spans [%.2f, %.2f] but the axis declares [%.2f, %.2f]; "+
				"a fixed axis that excludes real data hides it silently",
				c.ID, lo, hi, c.DisplayMin, c.DisplayMax)
		}
		t.Logf("%-18s data [%8.2f, %8.2f]  axis [%8.2f, %8.2f]",
			c.ID, lo, hi, c.DisplayMin, c.DisplayMax)
	}
}

// The opposite failure: an axis so generous the trace is a flat line along the
// bottom. Headroom for an unlucky seed is fine; an order of magnitude is not.
func TestDisplayRangeIsNotMostlyEmpty(t *testing.T) {
	const maxSlack = 2.0

	s := newSim(31)
	extremes := observedExtremes(t, s, 8)

	for _, c := range s.Channels() {
		hi := extremes[c.ID][1]
		if hi <= 0 {
			continue
		}
		if c.DisplayMax > hi*maxSlack {
			t.Errorf("%s: axis max %.2f is more than %gx the observed peak %.2f; "+
				"the trace would sit squashed against the bottom",
				c.ID, c.DisplayMax, maxSlack, hi)
		}
	}
}

// Faults are seeded, so a different seed produces different peaks. The axis
// must not move with them, or the scale would depend on which run you are
// watching — the same instability this change removes, one level up.
func TestDisplayRangeDoesNotDependOnSeed(t *testing.T) {
	a, b := newSim(1).Channels(), newSim(99).Channels()

	for i := range a {
		if a[i].DisplayMin != b[i].DisplayMin || a[i].DisplayMax != b[i].DisplayMax {
			t.Errorf("%s: seed 1 gives [%v, %v], seed 99 gives [%v, %v]",
				a[i].ID, a[i].DisplayMin, a[i].DisplayMax, b[i].DisplayMin, b[i].DisplayMax)
		}
	}
}

func TestDisplayRangeIsOrdered(t *testing.T) {
	for _, c := range newSim(31).Channels() {
		if c.DisplayMax <= c.DisplayMin {
			t.Errorf("%s: empty or inverted axis range [%v, %v]", c.ID, c.DisplayMin, c.DisplayMax)
		}
	}
}
```

**Step 2: Run it to confirm it fails**

Run: `cd server && go test ./internal/sim/ -run TestDisplayRange -v`
Expected: compile failure — `c.DisplayMin undefined`. That is the correct first failure.

**Step 3: Write `range.go`**

```go
package sim

import "math"

// Display ranges.
//
// The viewer draws each channel on its own y-axis at a fixed range, so that
// hiding one channel cannot rescale another. Those ranges are derived here
// rather than written into the client, because the client would then be
// encoding what this package can produce — a fourth copy of simulator
// knowledge, and the only one with nothing to fail when it drifts.
//
// The derivation walks the same phase functions the generator walks, so a new
// phase or a new fault widens the axis on its own.

// How many standard deviations of noise to allow beyond the base value. The
// generator draws Gaussian noise, which is unbounded, so this is a practical
// bound rather than a guarantee: at 4 sigma roughly 1 sample in 16,000 falls
// outside, and at 4,000 samples a second that is often enough to matter if the
// axis had no rounding on top. niceCeil below supplies that margin.
const sigmaHeadroom = 4

// How finely to walk each phase. The ramps are smooth, so this is plenty.
const rangeProbes = 256

type displayRange struct{ min, max float64 }

func displayRangeFor(channel uint64) displayRange {
	lo, hi := math.Inf(1), math.Inf(-1)

	for _, ph := range phases {
		// A fault either fires for a whole loop or not at all, so the widest
		// this channel can reach in this phase is its nominal extreme plus the
		// most extreme amplitude available here.
		var faultLo, faultHi float64
		for i := range faults {
			f := &faults[i]
			if f.channel != channel || f.phase != ph.name {
				continue
			}
			faultHi = math.Max(faultHi, f.amplitude)
			faultLo = math.Min(faultLo, f.amplitude)
		}

		for i := 0; i <= rangeProbes; i++ {
			p := float64(i) / rangeProbes
			base, sigma := nominal(channel, ph.name, p)

			baseLo, baseHi := base+faultLo, base+faultHi
			if channel == chVibration {
				// The 120Hz carrier scales with the level, so it widens both
				// ends rather than shifting them.
				baseLo -= 0.35 * math.Abs(baseLo)
				baseHi += 0.35 * math.Abs(baseHi)
			}

			lo = math.Min(lo, baseLo-sigmaHeadroom*sigma)
			hi = math.Max(hi, baseHi+sigmaHeadroom*sigma)
		}
	}

	// value() clamps negatives away, so an axis reaching below zero would be
	// claiming territory no sample can occupy.
	if lo < 0 {
		lo = 0
	}
	return displayRange{min: niceFloor(lo), max: niceCeil(hi)}
}

// Steps a person would pick for an axis bound.
var niceSteps = []float64{1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10}

// niceCeil rounds up to the next nice step, which both tidies the tick labels
// and supplies the margin the 4-sigma bound does not.
func niceCeil(v float64) float64 {
	if v <= 0 {
		return 0
	}
	mag := math.Pow(10, math.Floor(math.Log10(v)))
	for _, step := range niceSteps {
		if v <= step*mag {
			return step * mag
		}
	}
	return 10 * mag
}

func niceFloor(v float64) float64 {
	if v <= 0 {
		return 0
	}
	mag := math.Pow(10, math.Floor(math.Log10(v)))
	for i := len(niceSteps) - 1; i >= 0; i-- {
		if v >= niceSteps[i]*mag {
			return niceSteps[i] * mag
		}
	}
	return 0
}
```

**Step 4: Carry the range on `Channel`**

In `server/internal/sim/sim.go`, add to the `Channel` struct:

```go
	// DisplayMin and DisplayMax are the suggested fixed y-axis span. See range.go.
	DisplayMin   float64
	DisplayMax   float64
```

and fill them in `New()`, in the loop that already sets `SampleRateHz`:

```go
	for i := range chans {
		chans[i].SampleRateHz = cfg.RateHz
		r := displayRangeFor(uint64(i))
		chans[i].DisplayMin = r.min
		chans[i].DisplayMax = r.max
	}
```

**Step 5: Run the tests**

Run: `cd server && go test ./internal/sim/ -run TestDisplayRange -v`
Expected: PASS. The logged table should look roughly like pressure `[0, 1250]`, temperature `[0, 4000]`, vibration `[0, 15]`, fuel flow `[0, 20]`.

If `TestDisplayRangeIsNotMostlyEmpty` fails, the derivation is too conservative — check whether the vibration carrier is being applied to a channel that has none.

**Step 6: Full suite and commit**

Run: `just test && just lint`

```bash
git add server/internal/sim/
git commit -m "Derive each channel's display range from the phase table and fault library"
```

---

### Task 4: Send the range over the wire

**Files:**
- Modify: `server/internal/stream/service.go`
- Modify: `server/internal/stream/service_test.go`

**Step 1: Write the failing assertion**

In `service_test.go`, inside the existing `ListChannels` test loop that already checks `ch.Id`, `ch.Name`, `ch.Unit` and `ch.SampleRateHz`, add:

```go
		// The viewer draws a fixed axis from these, so an unset range would
		// collapse the chart to a line at zero rather than fail loudly.
		if ch.DisplayMax <= ch.DisplayMin {
			t.Errorf("%s: display range [%v, %v] is empty or inverted",
				ch.Id, ch.DisplayMin, ch.DisplayMax)
		}
```

**Step 2: Run it to confirm it fails**

Run: `cd server && go test ./internal/stream/ -run ListChannels -v`
Expected: FAIL — both values are zero, because the mapping does not copy them.

**Step 3: Map the fields**

In `ListChannels`:

```go
		out[i] = &telemetryv1.Channel{
			Id:           c.ID,
			Name:         c.Name,
			Unit:         c.Unit,
			SampleRateHz: c.SampleRateHz,
			DisplayMin:   c.DisplayMin,
			DisplayMax:   c.DisplayMax,
		}
```

**Step 4: Run it again**

Run: `cd server && go test ./internal/stream/ -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/internal/stream/
git commit -m "Send each channel's display range to the client"
```

---

### Task 5: Axis construction, and the invariance it must have

This is the heart of the change. `yAxes` takes the visible set only to decide *colour*; everything that affects geometry is computed without it, and a test states that.

**Files:**
- Modify: `web/src/render/types.ts`
- Modify: `web/src/render/types.test.ts`

**Step 1: Write the failing tests**

Append to `web/src/render/types.test.ts`:

```ts
import { viewerGridInsets, yAxes, AXIS_WIDTH } from "./types";
import type { Channel } from "../gen/telemetry/v1/telemetry_pb";

function channel(id: string, unit: string, min: number, max: number): Channel {
  return { id, name: id, unit, sampleRateHz: 1000, displayMin: min, displayMax: max } as Channel;
}

const CHANNELS = [
  channel("chamber_pressure", "psi", 0, 1250),
  channel("chamber_temp", "K", 0, 4000),
  channel("vibration", "g", 0, 15),
  channel("fuel_flow", "kg/s", 0, 20),
];

describe("yAxes", () => {
  it("gives every channel its own axis, in declaration order", () => {
    const axes = yAxes(CHANNELS, null);
    expect(axes).toHaveLength(CHANNELS.length);
    expect(axes.map((a) => a.name)).toEqual(["psi", "K", "g", "kg/s"]);
  });

  it("takes each range from the channel metadata, never from the data", () => {
    const axes = yAxes(CHANNELS, null);
    expect(axes.map((a) => [a.min, a.max])).toEqual([
      [0, 1250],
      [0, 4000],
      [0, 15],
      [0, 20],
    ]);
  });

  it("splits the axes between the two sides and offsets each one outward", () => {
    const axes = yAxes(CHANNELS, null);
    expect(axes.map((a) => a.position)).toEqual(["left", "left", "right", "right"]);
    expect(axes.map((a) => a.offset)).toEqual([0, AXIS_WIDTH, 0, AXIS_WIDTH]);
  });

  /*
  The requirement, stated as an assertion.

  Unticking fuel flow used to change the numbers on vibration's axis, because
  both shared one auto-scaled axis. Nothing about an axis may depend on what is
  visible except its colour: not its range, not its position, not its offset,
  and above all not whether it exists — an axis that vanished would let the
  others slide over and change every trace's apparent width instead.
  */
  it("produces geometrically identical axes whatever is visible", () => {
    const ids = CHANNELS.map((c) => c.id);
    const subsets: (string[] | null)[] = [
      null,
      ids,
      [],
      ["vibration"],
      ["chamber_pressure", "fuel_flow"],
      ids.filter((id) => id !== "fuel_flow"),
    ];

    const geometryOf = (visible: string[] | null) =>
      yAxes(CHANNELS, visible).map(({ type, position, offset, min, max, name }) => ({
        type,
        position,
        offset,
        min,
        max,
        name,
      }));

    const reference = geometryOf(null);
    for (const subset of subsets) {
      expect(geometryOf(subset)).toEqual(reference);
    }
  });

  it("dims a hidden channel's axis and leaves a visible one at full colour", () => {
    const [pressure, , vibration] = yAxes(CHANNELS, ["chamber_pressure"]);
    expect(pressure!.axisLabel.color).toBe(colorFor("chamber_pressure"));
    expect(vibration!.axisLabel.color).not.toBe(colorFor("vibration"));
  });

  it("draws gridlines for one axis only", () => {
    const shown = yAxes(CHANNELS, null).filter((a) => a.splitLine.show);
    expect(shown).toHaveLength(1);
  });
});

describe("viewerGridInsets", () => {
  it("reserves a slot for every axis on each side", () => {
    expect(viewerGridInsets(4)).toEqual({ left: 2 * AXIS_WIDTH, right: 2 * AXIS_WIDTH });
  });

  // It takes a count, not a visible set, which is what makes the plot geometry
  // impossible to perturb by toggling a channel. The signature is the proof;
  // this pins it so a later change cannot quietly add the parameter.
  it("depends only on how many channels exist", () => {
    expect(viewerGridInsets.length).toBe(1);
  });
});
```

Add `colorFor` to the existing import from `./types`.

**Step 2: Run to confirm failure**

Run: `cd web && npx vitest run src/render/types.test.ts`
Expected: FAIL — `yAxes is not a function`.

**Step 3: Implement**

In `web/src/render/types.ts`, below `colorFor`:

```ts
/** Horizontal room one y-axis needs for its line, ticks and labels. */
export const AXIS_WIDTH = 56;

/** Colour of an axis whose channel is currently hidden. */
const AXIS_DIMMED = "#c8c8c8";

/**
 * Grid insets for the viewer, sized to fit one axis per channel.
 *
 * Takes a count rather than a visible set, deliberately. Plot geometry must not
 * depend on what is on screen: if hiding a channel narrowed the insets, the
 * plot would widen and every remaining trace would change apparent width and
 * position — horizontal instability in place of the vertical kind this change
 * removes.
 */
export function viewerGridInsets(channelCount: number): { left: number; right: number } {
  const leftCount = Math.ceil(channelCount / 2);
  return {
    left: Math.max(AXIS_WIDTH, leftCount * AXIS_WIDTH),
    right: Math.max(AXIS_WIDTH, (channelCount - leftCount) * AXIS_WIDTH),
  };
}

/**
 * One y-axis per channel, at a fixed range the server declared.
 *
 * `visible` affects colour and nothing else. Every channel keeps its axis
 * whether or not it is drawn, because an axis that disappeared would let the
 * others slide over — and each range comes from the channel metadata rather
 * than from the data, so it cannot move when a neighbour is hidden. That pair
 * of properties is what the old shared `scale: true` axes lacked.
 */
export function yAxes(channels: Channel[], visible: string[] | null) {
  const shown = visible === null ? null : new Set(visible);
  const leftCount = Math.ceil(channels.length / 2);

  return channels.map((c, index) => {
    const onLeft = index < leftCount;
    const slot = onLeft ? index : index - leftCount;
    const lit = shown === null || shown.has(c.id);
    const color = lit ? colorFor(c.id) : AXIS_DIMMED;

    return {
      type: "value" as const,
      position: (onLeft ? "left" : "right") as "left" | "right",
      offset: slot * AXIS_WIDTH,
      name: c.unit,
      min: c.displayMin,
      max: c.displayMax,
      nameTextStyle: { color },
      axisLine: { show: true, lineStyle: { color } },
      axisLabel: { color },
      // Four sets of gridlines would be a moiré pattern, so only the first
      // axis draws them.
      splitLine: { show: index === 0 },
    };
  });
}
```

**Step 4: Run the tests**

Run: `cd web && npx vitest run src/render/types.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/render/types.ts web/src/render/types.test.ts
git commit -m "Build one fixed y-axis per channel, with geometry independent of visibility"
```

---

### Task 6: The viewer chart option

**Files:**
- Modify: `web/src/render/types.ts`
- Modify: `web/src/render/types.test.ts`

**Step 1: Write the failing test**

```ts
describe("viewerOption", () => {
  it("points each series at its own axis", () => {
    const option = viewerOption(CHANNELS);
    expect(option.series.map((s) => s.yAxisIndex)).toEqual([0, 1, 2, 3]);
  });

  it("sizes the grid to fit the axes", () => {
    const option = viewerOption(CHANNELS);
    const insets = viewerGridInsets(CHANNELS.length);
    expect(option.grid.left).toBe(insets.left);
    expect(option.grid.right).toBe(insets.right);
  });

  /*
  The channel checkboxes are the one authority on visibility. An ECharts legend
  is a second one: clicking it hides a series without the store knowing, and the
  chart and the channel list then disagree about what is on screen.
  */
  it("has no legend", () => {
    expect(viewerOption(CHANNELS)).not.toHaveProperty("legend");
  });
});
```

**Step 2: Run to confirm failure**

Run: `cd web && npx vitest run src/render/types.test.ts -t viewerOption`
Expected: FAIL — `viewerOption is not a function`.

**Step 3: Implement, below `baseOption`**

```ts
/**
 * Chart options for the viewer.
 *
 * Separate from `baseOption` rather than an edit to it: modes A and B are
 * frozen references whose numbers are quoted throughout NOTES.md, and changing
 * what they draw would make those numbers unreproducible.
 */
export function viewerOption(channels: Channel[]) {
  const insets = viewerGridInsets(channels.length);

  return {
    animation: false,
    grid: { left: insets.left, right: insets.right, top: 28, bottom: 28 },
    xAxis: { type: "time" as const, axisLabel: { hideOverlap: true } },
    yAxis: yAxes(channels, null),
    series: channels.map((c, index) => ({
      name: c.name,
      type: "line" as const,
      showSymbol: false,
      lineStyle: { width: 1 },
      itemStyle: { color: colorFor(c.id) },
      yAxisIndex: index,
      data: [] as number[][],
    })),
  };
}
```

**Step 4: Run and commit**

Run: `cd web && npx vitest run src/render/types.test.ts`

```bash
git add web/src/render/types.ts web/src/render/types.test.ts
git commit -m "Add the viewer chart option, leaving the frozen baselines alone"
```

---

### Task 7: Make `plotFraction` take its insets

`plotFraction` currently reads the module constants, which describe `baseOption`'s grid, not the viewer's. Left alone it would map pixels to times using the wrong inset and skew every zoom anchor.

**Files:**
- Modify: `web/src/render/types.ts`
- Modify: `web/src/render/types.test.ts`

**Step 1: Write the failing test**

```ts
describe("plotFraction", () => {
  const rect = { left: 0, width: 1000 } as DOMRect;

  it("maps the plot's left and right edges to 0 and 1", () => {
    expect(plotFraction(100, rect, { left: 100, right: 100 })).toBeCloseTo(0);
    expect(plotFraction(900, rect, { left: 100, right: 100 })).toBeCloseTo(1);
  });

  it("clamps outside the plot area, so dragging off the chart cannot overshoot", () => {
    expect(plotFraction(0, rect, { left: 100, right: 100 })).toBe(0);
    expect(plotFraction(2000, rect, { left: 100, right: 100 })).toBe(1);
  });

  // The wider insets the per-channel axes need would otherwise be mapped with
  // baseOption's narrower ones, putting every zoom anchor slightly off.
  it("uses the insets it is given, not a module constant", () => {
    expect(plotFraction(500, rect, { left: 100, right: 100 })).toBeCloseTo(0.5);
    expect(plotFraction(500, rect, { left: 0, right: 0 })).toBeCloseTo(0.5);
    expect(plotFraction(300, rect, { left: 100, right: 100 })).toBeCloseTo(0.25);
    expect(plotFraction(300, rect, { left: 200, right: 0 })).toBeCloseTo(0.125);
  });

  it("does not divide by zero when the plot has no width", () => {
    expect(plotFraction(50, rect, { left: 600, right: 600 })).toBe(0.5);
  });
});
```

**Step 2: Run to confirm failure**

Run: `cd web && npx vitest run src/render/types.test.ts -t plotFraction`
Expected: FAIL — the third argument is ignored, so the inset-sensitivity cases fail.

**Step 3: Change the signature**

```ts
/** Where `clientX` falls across the plot area, 0 (left edge) to 1 (right). */
export function plotFraction(
  clientX: number,
  rect: DOMRect,
  insets: { left: number; right: number },
): number {
  const plotWidth = rect.width - insets.left - insets.right;
  if (plotWidth <= 0) return 0.5;

  const f = (clientX - rect.left - insets.left) / plotWidth;
  return Math.min(Math.max(f, 0), 1);
}
```

**Step 4: Run and commit**

Run: `cd web && npx vitest run src/render/types.test.ts`

```bash
git add web/src/render/types.ts web/src/render/types.test.ts
git commit -m "Pass grid insets to plotFraction rather than reading a constant"
```

---

### Task 8: Wire the renderer up

**Files:**
- Modify: `web/src/render/worker.ts`

**Step 1: Use the viewer option and remember its insets**

Change the import from `./types` to bring in `viewerOption`, `viewerGridInsets` and `yAxes`, and drop `baseOption`, `GRID_LEFT` and `GRID_RIGHT`.

Add a field beside the other private state:

```ts
  /** Grid insets this chart was built with; the gesture maths needs them. */
  private insets = { left: 64, right: 64 };
```

In `init()`, replace `this.chart.setOption(baseOption(channels))` with:

```ts
    this.insets = viewerGridInsets(channels.length);
    this.chart.setOption(viewerOption(channels));
```

Keep `this.channels = channels` as a new field too — `setVisibleChannels` needs the metadata to rebuild the axes. Add `private channels: Channel[] = [];` and set it in `init` beside `channelIds`.

**Step 2: Use the insets in the two gesture sites**

In `onWheel`:

```ts
      anchorFraction: plotFraction(e.clientX, this.container.getBoundingClientRect(), this.insets),
```

In `onPointerMove`:

```ts
    const plotWidth = rect.width - this.insets.left - this.insets.right;
```

**Step 3: Dim the hidden channels' axes**

In `setVisibleChannels`, after `this.visible = channelIds;` and the `if (!this.chart) return;` guard:

```ts
    // Colour only — the axes keep their ranges, their positions and their
    // slots, so nothing on the chart moves or rescales.
    this.timer.measure(() =>
      this.chart!.setOption({ yAxis: yAxes(this.channels, this.visible) }),
    );
```

**Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean. If `GRID_LEFT` is still referenced anywhere, remove that usage.

**Step 5: Full suite**

Run: `just test && just lint`
Expected: all pass.

**Step 6: Commit**

```bash
git add web/src/render/worker.ts
git commit -m "Draw the viewer with per-channel axes and dim the hidden ones"
```

---

### Task 9: Stop the grid insets being two literals

`baseOption` writes `grid: { left: 64, right: 64 }` while `GRID_LEFT`/`GRID_RIGHT` separately declare 64. They have to agree, nothing makes them, and they feed the pixel-to-time mapping that the zoom-out bug lived in.

**Files:**
- Modify: `web/src/render/types.ts`

**Step 1: Use the constants**

```ts
/** Grid insets for the two frozen baseline renderers. */
export const GRID_LEFT = 64;
export const GRID_RIGHT = 64;
```

Move that declaration above `baseOption`, and in `baseOption`:

```ts
    grid: { left: GRID_LEFT, right: GRID_RIGHT, top: 28, bottom: 28 },
```

The value is unchanged, so modes A and B draw exactly what they drew.

**Step 2: Verify and commit**

Run: `just test && just lint`

```bash
git add web/src/render/types.ts
git commit -m "Derive the baseline grid insets from their constants"
```

---

### Task 10: Verify against a running app

**Step 1: Start both servers**

```bash
just server
```

```bash
just web
```

**Step 2: Check the reported bug is gone**

Open <http://localhost:5173>. Wait for the steady-state phase so every trace has real amplitude. Note vibration's axis numbers and the height of its trace, then untick **fuel flow**.

Expected: the fuel flow trace disappears; its axis greys out but stays where it is; **vibration's axis numbers and trace height do not change at all**. Repeat with chamber temperature against chamber pressure.

**Step 3: Check the axes read correctly**

Each axis should carry one unit (`psi`, `K`, `g`, `kg/s`), be tinted with its channel's colour, and show a fixed range that does not move as the test sequence cycles through ignition and shutdown.

**Step 4: Check nothing regressed**

Scroll to zoom in and out, drag to pan, press Pause and Jump to live, and click a sidebar anomaly. Zoom-out and dispose are the two that have broken before, and Task 7 changed the maths zoom depends on.

**Step 5: Check the anomaly bands still land**

Wait for an anomaly and confirm its shaded band sits over the right part of the trace, then untick that channel and confirm the band goes with it.

**Step 6: Note the expected drop in points rendered**

The status bar's *points rendered* should read roughly 12,000 rather than 12,888, because the four axes cost about 110px of plot width and the figure is `2 x widthPx` per visible channel. Confirm it is in that region and not, say, halved.

Add to `NOTES.md`, in the section on points rendered:

```markdown
**Points rendered fell when the per-channel axes landed**, from 12,888 to about 12,000. Four
axes take roughly 110px of a 1,600px plot, and points rendered is twice the plot width per
visible channel — so the figure moved because the display got narrower, which is the claim it
is there to demonstrate. It is not a regression, and unticking a channel now drops it by a
quarter with no other number changing.
```

**Step 7: Commit**

```bash
git add NOTES.md
git commit -m "Note why points rendered fell with the per-channel axes"
```

---

## Done when

- Unticking any channel leaves every other channel's axis numbers and trace height untouched.
- Each axis carries one unit and one channel's colour.
- `just test`, `just lint` and `just gen-check` are clean; Go coverage has not fallen.
- Modes A and B draw exactly what they drew, and their `NOTES.md` numbers stand.

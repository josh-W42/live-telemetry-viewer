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

Each channel is drawn on its own axis at a fixed range, so that hiding one
channel cannot rescale another. Fixed means anything outside it is invisible: an
axis that clipped a fault would hide precisely the thing the viewer exists to
show, and would do it silently, because a clipped trace still looks like a
trace.
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

/*
Faults are seeded, so a different seed fires a different combination of them and
reaches different peaks. The axis must not move with that, or the scale would
depend on which run you happened to be watching — the same instability this
change removes, one level up.
*/
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

// No sensor here reads negative and value() clamps at zero, so an axis starting
// below zero would reserve space nothing can occupy.
func TestDisplayRangeDoesNotGoNegative(t *testing.T) {
	for _, c := range newSim(31).Channels() {
		if c.DisplayMin < 0 {
			t.Errorf("%s: axis starts at %v, below the clamp the generator applies", c.ID, c.DisplayMin)
		}
	}
}

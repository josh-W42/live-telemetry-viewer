package sim

import "math"

// Display ranges.
//
// The viewer draws each channel on its own y-axis at a fixed range, so that
// hiding one channel cannot rescale another. Those ranges are derived here
// rather than written into the client, because the client would then be
// encoding what this package can produce — a fourth copy of simulator
// knowledge, alongside the thresholds in rules.ts and faults_test.go, and the
// only one with nothing to fail when it drifts.
//
// The derivation walks the same phase functions the generator walks and reads
// the same fault library, so a new phase or a new fault widens the axis on its
// own.

// How many standard deviations of noise to allow beyond the base value.
//
// The generator draws Gaussian noise, which is unbounded, so this is a
// practical bound rather than a guarantee: at 4 sigma roughly 1 sample in
// 16,000 falls outside, and at 4,000 samples a second that would happen often
// enough to matter if it were the only margin. niceCeil supplies the rest.
const sigmaHeadroom = 4

// How finely to walk each phase. The ramps are smooth, so this is plenty.
const rangeProbes = 256

type displayRange struct{ min, max float64 }

// displayRangeFor returns the fixed y-axis span for one channel.
//
// Only the upper bound is derived. Every axis starts at zero, for three
// reasons: each of these channels is a non-negative physical quantity that
// rests at or near zero while the engine is off; value() clamps negatives away,
// so zero is attainable for all of them, which is what caught an earlier
// version of this starting vibration's axis at 0.01 while the data reached
// 0.00; and a baseline that is not zero exaggerates how much a trace appears to
// vary, the same class of misleading scale this whole change exists to remove.
//
// A channel that genuinely never approaches zero — an absolute pressure reading
// that idles at 900, say — would waste most of its axis and should revisit this.
func displayRangeFor(channel uint64) displayRange {
	hi := math.Inf(-1)

	for _, ph := range phases {
		// A fault either fires for a whole loop or not at all, so the highest
		// this channel can reach in this phase is its nominal peak plus the
		// largest amplitude available here. Negative amplitudes — the
		// thermocouple dropout — only pull downward, so they cannot raise it.
		var faultHi float64
		for i := range faults {
			f := &faults[i]
			if f.channel == channel && f.phase == ph.name {
				faultHi = math.Max(faultHi, f.amplitude)
			}
		}

		for i := 0; i <= rangeProbes; i++ {
			p := float64(i) / rangeProbes
			base, sigma := nominal(channel, ph.name, p)

			peak := base + faultHi
			if channel == chVibration {
				// The 120Hz carrier scales with the level, so it lifts the peak
				// rather than shifting the whole signal.
				peak += 0.35 * math.Abs(peak)
			}

			hi = math.Max(hi, peak+sigmaHeadroom*sigma)
		}
	}

	return displayRange{min: 0, max: niceCeil(hi)}
}

// Steps a person would pick for an axis bound.
var niceSteps = []float64{1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10}

// niceCeil rounds up to the next nice step, which both tidies the tick labels
// and supplies the margin the finite sigma bound above does not.
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

package sim

// Fault injection.
//
// A test stand that only ever fails one way is a poor thing to build a rules
// engine against, and it pushes you toward rules that are technically
// exercised but operationally meaningless. Each channel therefore gets a fault
// mode of its own, and the thresholds in the client's rule set are chosen to
// sit above what nominal operation can reach.
//
// Every fault is a pure function of (seed, loop), so a given seed always
// produces the same sequence of failures. They are occasional rather than
// guaranteed: a rig that fails four different ways every eighty-five seconds
// reads as broken, not instrumented.

type fault struct {
	name    string
	channel uint64
	phase   string

	/** Added to the nominal signal. Negative for a dropout. */
	amplitude float64

	minMs, maxMs float64

	// Where within the phase the fault may begin, as a fraction. Kept clear of
	// the edges so a fault never straddles a phase change, where the nominal
	// signal is moving anyway.
	startMin, startMax float64

	// Chance of occurring in any given loop.
	probability float64

	// Separates this fault's random stream from every other's, so adding a
	// fault does not shift where the existing ones land.
	salt uint64
}

var faults = []fault{
	{
		// The original, and the one the spec names. Steady chamber pressure is
		// 1000 psi with sigma 9, so +180 is unmistakable.
		name: "chamber overpressure", channel: chPressure, phase: PhaseSteady,
		amplitude: 180, minMs: 30, maxMs: 100,
		startMin: 0.10, startMax: 0.80, probability: 0.85, salt: 0xA1,
	},
	{
		// Combustion instability showing up as a heat spike. Steady is 3200K
		// with sigma 25.
		name: "chamber overtemperature", channel: chTemp, phase: PhaseSteady,
		amplitude: 450, minMs: 80, maxMs: 250,
		startMin: 0.15, startMax: 0.75, probability: 0.5, salt: 0xB2,
	},
	{
		// A resonance excursion. The amplitude has to clear the 120Hz carrier's
		// troughs, not just its peaks: vibration's oscillation scales with the
		// level, so a burst that only beat the nominal *peak* would dip back
		// under the threshold every 8ms and never sustain long enough to count.
		name: "excessive vibration", channel: chVibration, phase: PhaseSteady,
		amplitude: 6.0, minMs: 150, maxMs: 500,
		startMin: 0.15, startMax: 0.75, probability: 0.55, salt: 0xC3,
	},
	{
		// A surge rather than a dropout, deliberately. Flow is zero whenever the
		// engine is off, so a low-flow rule would fire through every idle and
		// shutdown - detecting the test sequence rather than a fault. An
		// overshoot is only ever abnormal.
		name: "fuel flow surge", channel: chFuelFlow, phase: PhaseSteady,
		amplitude: 6.0, minMs: 60, maxMs: 180,
		startMin: 0.15, startMax: 0.75, probability: 0.5, salt: 0xD4,
	},
	{
		// Thermocouple dropout during chill-down, late enough that the nominal
		// value has reached the cryogenic floor of 95K. This is the one fault
		// worth catching on the low side: nothing in normal operation takes
		// chamber temperature below that floor, so a `<` rule against it fires
		// only on a genuine sensor or overshoot fault.
		name: "thermocouple dropout", channel: chTemp, phase: PhaseChillDown,
		amplitude: -70, minMs: 100, maxMs: 300,
		startMin: 0.75, startMax: 0.92, probability: 0.4, salt: 0xE5,
	},
}

// faultOffset returns everything the injected faults add to one channel at this
// point in the sequence.
func (s *Simulator) faultOffset(channel uint64, phaseName string, p float64, loop int64) float64 {
	var total float64
	for i := range faults {
		f := &faults[i]
		if f.channel != channel || f.phase != phaseName {
			continue
		}
		total += s.contribution(f, p, loop)
	}
	return total
}

func (s *Simulator) contribution(f *fault, p float64, loop int64) float64 {
	// Three independent draws off one hash chain: whether this loop carries the
	// fault at all, where it starts, and how long it lasts.
	h := hash(s.cfg.Seed, loop, f.salt)
	if uniform(h) >= f.probability {
		return 0
	}

	h = splitmix64(h)
	startFrac := f.startMin + (f.startMax-f.startMin)*uniform(h)

	h = splitmix64(h)
	durMs := f.minMs + (f.maxMs-f.minMs)*uniform(h)

	phaseSec := phaseDuration(f.phase).Seconds()
	startSec := startFrac * phaseSec
	nowSec := p * phaseSec

	if nowSec < startSec || nowSec >= startSec+durMs/1000 {
		return 0
	}
	return f.amplitude
}

// FaultNames lists the injectable fault modes, for documentation and tests.
func FaultNames() []string {
	out := make([]string, len(faults))
	for i, f := range faults {
		out[i] = f.name
	}
	return out
}

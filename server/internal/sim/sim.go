// Package sim generates simulated rocket-engine test-stand telemetry.
//
// The generator is pure: every value is a function of (seed, sample index)
// alone, and timestamps are derived from a caller-supplied epoch. Nothing here
// reads the clock, which is what makes a run reproducible from its seed and
// lets the caller regenerate any window at any time.
package sim

import (
	"math"
	"time"
)

// Channel describes one sensor on the test stand.
type Channel struct {
	ID           string
	Name         string
	Unit         string
	SampleRateHz float64

	// DisplayMin and DisplayMax are the suggested fixed y-axis span for this
	// channel. See range.go.
	DisplayMin float64
	DisplayMax float64
}

// Samples holds one channel's output over a range of sample indices.
type Samples struct {
	ChannelID    string
	TimestampsNs []int64
	Values       []float64
}

// Config parameterizes a Simulator.
type Config struct {
	// Seed makes a run reproducible.
	Seed int64
	// RateHz is samples per second per channel.
	RateHz float64
	// EpochNs is the wall-clock time of sample index 0. Passing it in rather
	// than calling time.Now() here is what keeps the generator pure.
	EpochNs int64
}

// Phase names. Exported through PhaseAt.
const (
	PhaseIdle      = "idle"
	PhaseChillDown = "chill_down"
	PhaseIgnition  = "ignition"
	PhaseSteady    = "steady"
	PhaseShutdown  = "shutdown"
)

type phase struct {
	name string
	dur  time.Duration
}

// The test sequence loops forever. Durations are a few tens of seconds each so
// a viewer sees a full cycle without waiting long.
var phases = []phase{
	{PhaseIdle, 10 * time.Second},
	{PhaseChillDown, 15 * time.Second},
	{PhaseIgnition, 5 * time.Second},
	{PhaseSteady, 45 * time.Second},
	{PhaseShutdown, 10 * time.Second},
}

var loopDur = func() time.Duration {
	var total time.Duration
	for _, p := range phases {
		total += p.dur
	}
	return total
}()

// LoopDuration is the length of one full test sequence.
func LoopDuration() time.Duration { return loopDur }

// Channel ordinals, used both to index channelDefs and to separate each
// channel's noise stream.
const (
	chPressure uint64 = iota
	chTemp
	chVibration
	chFuelFlow
)

var channelDefs = []Channel{
	{ID: "chamber_pressure", Name: "Chamber Pressure", Unit: "psi"},
	{ID: "chamber_temp", Name: "Chamber Temperature", Unit: "K"},
	{ID: "vibration", Name: "Vibration", Unit: "g"},
	{ID: "fuel_flow", Name: "Fuel Flow", Unit: "kg/s"},
}

// Simulator produces telemetry for a fixed set of channels.
type Simulator struct {
	cfg      Config
	periodNs int64
	channels []Channel
}

// New returns a Simulator. RateHz defaults to 1000 if unset.
func New(cfg Config) *Simulator {
	if cfg.RateHz <= 0 {
		cfg.RateHz = 1000
	}

	chans := make([]Channel, len(channelDefs))
	copy(chans, channelDefs)
	for i := range chans {
		chans[i].SampleRateHz = cfg.RateHz
		r := displayRangeFor(uint64(i))
		chans[i].DisplayMin = r.min
		chans[i].DisplayMax = r.max
	}

	return &Simulator{
		cfg:      cfg,
		periodNs: int64(float64(time.Second) / cfg.RateHz),
		channels: chans,
	}
}

// Channels returns the channel metadata.
func (s *Simulator) Channels() []Channel {
	out := make([]Channel, len(s.channels))
	copy(out, s.channels)
	return out
}

// PeriodNs is the nanosecond interval between consecutive samples.
func (s *Simulator) PeriodNs() int64 { return s.periodNs }

// IndexAt returns the sample index whose timestamp is at or before tNs.
func (s *Simulator) IndexAt(tNs int64) int64 {
	if tNs <= s.cfg.EpochNs {
		return 0
	}
	return (tNs - s.cfg.EpochNs) / s.periodNs
}

// phaseAt resolves a sample index to its phase, the progress through that
// phase in [0,1), and which loop iteration it belongs to.
func (s *Simulator) phaseAt(index int64) (name string, progress float64, loop int64) {
	elapsed := float64(index) / s.cfg.RateHz
	loopSec := loopDur.Seconds()

	loop = int64(elapsed / loopSec)
	within := math.Mod(elapsed, loopSec)

	for _, p := range phases {
		d := p.dur.Seconds()
		if within < d {
			return p.name, within / d, loop
		}
		within -= d
	}

	// Floating point can land a hair past the final boundary.
	last := phases[len(phases)-1]
	return last.name, 1, loop
}

// PhaseAt returns the name of the test-sequence phase at a sample index.
func (s *Simulator) PhaseAt(index int64) string {
	name, _, _ := s.phaseAt(index)
	return name
}

// Range returns samples for indices [from, to). An empty or inverted range
// yields one entry per channel with no samples, never nil, so callers can
// iterate without a special case.
func (s *Simulator) Range(from, to int64) []Samples {
	n := to - from
	if n < 0 {
		n = 0
	}

	out := make([]Samples, len(s.channels))
	for c := range s.channels {
		out[c] = Samples{
			ChannelID:    s.channels[c].ID,
			TimestampsNs: make([]int64, n),
			Values:       make([]float64, n),
		}
	}

	for i := int64(0); i < n; i++ {
		index := from + i
		ts := s.cfg.EpochNs + index*s.periodNs
		name, p, loop := s.phaseAt(index)
		elapsed := float64(index) / s.cfg.RateHz

		for c := range out {
			out[c].TimestampsNs[i] = ts
			out[c].Values[i] = s.value(uint64(c), name, p, loop, index, elapsed)
		}
	}

	return out
}

// nominal returns a channel's base value and noise sigma before faults, the
// vibration carrier, or clamping. Split out of value() so the display-range
// derivation can walk the same functions the generator uses, rather than
// restating their ranges somewhere that could drift out of step.
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

// value computes one channel's reading at a sample index.
func (s *Simulator) value(channel uint64, phaseName string, p float64, loop, index int64, elapsed float64) float64 {
	base, sigma := nominal(channel, phaseName, p)

	// Injected faults ride on the nominal signal. See faults.go.
	base += s.faultOffset(channel, phaseName, p, loop)

	if channel == chVibration {
		// High-frequency content scales with the level, so a burst shakes
		// harder as well as higher. This is what M3's downsampling has to
		// survive without turning the trace into mush.
		base += 0.35 * base * math.Sin(2*math.Pi*120*elapsed)
	}

	v := base + sigma*gaussian(s.cfg.Seed, index, channel)
	if v < 0 {
		// No sensor here reads negative; clamp rather than emit unphysical data.
		v = 0
	}
	return v
}

// smoothstep eases from 0 to 1 over p in [0,1], giving ramps a physical shape
// rather than a straight line.
func smoothstep(p float64) float64 {
	if p <= 0 {
		return 0
	}
	if p >= 1 {
		return 1
	}
	return p * p * (3 - 2*p)
}

// lerp interpolates a to b with an eased curve.
func lerp(a, b, p float64) float64 {
	return a + (b-a)*smoothstep(p)
}

// decay falls from a toward b exponentially across p in [0,1].
func decay(a, b, p float64) float64 {
	return b + (a-b)*math.Exp(-4*p)
}

const (
	ambientPSI  = 14.7
	chamberPSI  = 1000.0
	ambientK    = 290.0
	cryoK       = 95.0
	combustionK = 3200.0
	steadyFlow  = 12.0
)

func pressure(phaseName string, p float64) (base, sigma float64) {
	switch phaseName {
	case PhaseIdle, PhaseChillDown:
		return ambientPSI, 0.4
	case PhaseIgnition:
		return lerp(ambientPSI, chamberPSI, p), lerp(0.4, 12, p)
	case PhaseSteady:
		// Slow drift so the plateau is not perfectly flat.
		return chamberPSI + 8*math.Sin(2*math.Pi*p*3), 9
	case PhaseShutdown:
		return decay(chamberPSI, ambientPSI, p), decay(6, 0.4, p)
	}
	return ambientPSI, 0.4
}

func temperature(phaseName string, p float64) (base, sigma float64) {
	switch phaseName {
	case PhaseIdle:
		return ambientK, 0.8
	case PhaseChillDown:
		// Cryogenic propellant cools the chamber well below ambient.
		return lerp(ambientK, cryoK, p), 2
	case PhaseIgnition:
		return lerp(cryoK, combustionK, p), lerp(2, 40, p)
	case PhaseSteady:
		return combustionK, 25
	case PhaseShutdown:
		return decay(combustionK, ambientK, p), decay(30, 0.8, p)
	}
	return ambientK, 0.8
}

func vibration(phaseName string, p float64) (base, sigma float64) {
	switch phaseName {
	case PhaseIdle:
		return 0.02, 0.002
	case PhaseChillDown:
		return 0.08, 0.008
	case PhaseIgnition:
		return lerp(0.08, 2.6, p), lerp(0.008, 0.35, p)
	case PhaseSteady:
		return 2.6, 0.3
	case PhaseShutdown:
		return decay(2.6, 0.02, p), decay(0.2, 0.005, p)
	}
	return 0.02, 0.005
}

func fuelFlow(phaseName string, p float64) (base, sigma float64) {
	switch phaseName {
	case PhaseIdle:
		return 0, 0.002
	case PhaseChillDown:
		// Bleed flow while the lines chill.
		return 0.4, 0.05
	case PhaseIgnition:
		return lerp(0.4, steadyFlow, p), lerp(0.05, 0.4, p)
	case PhaseSteady:
		return steadyFlow, 0.25
	case PhaseShutdown:
		return decay(steadyFlow, 0, p), decay(0.2, 0.002, p)
	}
	return 0, 0.002
}

func phaseDuration(name string) time.Duration {
	for _, p := range phases {
		if p.name == name {
			return p.dur
		}
	}
	return 0
}

package sim_test

import (
	"math"
	"testing"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
)

const (
	testRate  = 1000.0
	testEpoch = int64(1_700_000_000_000_000_000)
)

func newSim(seed int64) *sim.Simulator {
	return sim.New(sim.Config{Seed: seed, RateHz: testRate, EpochNs: testEpoch})
}

func loopSamples() int64 {
	return int64(sim.LoopDuration().Seconds() * testRate)
}

// findIndexInPhase returns a sample index in the middle of the named phase of
// the first loop.
func findIndexInPhase(t *testing.T, s *sim.Simulator, name string) int64 {
	t.Helper()
	start, end := int64(-1), int64(-1)
	for i := int64(0); i < loopSamples(); i++ {
		if s.PhaseAt(i) == name {
			if start < 0 {
				start = i
			}
			end = i
		}
	}
	if start < 0 {
		t.Fatalf("phase %q never occurs in one loop", name)
	}
	return (start + end) / 2
}

// meanOf returns the mean value of one channel over a window centered on index.
func meanOf(t *testing.T, s *sim.Simulator, channelID string, center, width int64) float64 {
	t.Helper()
	for _, ch := range s.Range(center-width/2, center+width/2) {
		if ch.ChannelID != channelID {
			continue
		}
		sum := 0.0
		for _, v := range ch.Values {
			sum += v
		}
		return sum / float64(len(ch.Values))
	}
	t.Fatalf("channel %q not found", channelID)
	return 0
}

// --- Acceptance criterion: reproducibility -------------------------------

func TestSameSeedProducesIdenticalOutput(t *testing.T) {
	a := newSim(42).Range(0, 5000)
	b := newSim(42).Range(0, 5000)

	if len(a) != len(b) {
		t.Fatalf("channel count differs: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].ChannelID != b[i].ChannelID {
			t.Fatalf("channel %d id differs: %q vs %q", i, a[i].ChannelID, b[i].ChannelID)
		}
		if len(a[i].Values) != len(b[i].Values) {
			t.Fatalf("%s: length differs: %d vs %d", a[i].ChannelID, len(a[i].Values), len(b[i].Values))
		}
		for j := range a[i].Values {
			if a[i].Values[j] != b[i].Values[j] {
				t.Fatalf("%s: value %d differs: %v vs %v", a[i].ChannelID, j, a[i].Values[j], b[i].Values[j])
			}
			if a[i].TimestampsNs[j] != b[i].TimestampsNs[j] {
				t.Fatalf("%s: timestamp %d differs", a[i].ChannelID, j)
			}
		}
	}
}

func TestDifferentSeedsProduceDifferentOutput(t *testing.T) {
	a := newSim(42).Range(0, 2000)
	b := newSim(43).Range(0, 2000)

	for i := range a {
		for j := range a[i].Values {
			if a[i].Values[j] != b[i].Values[j] {
				return // found a difference, as expected
			}
		}
	}
	t.Fatal("different seeds produced identical values; noise is not seed-dependent")
}

// --- Statelessness -------------------------------------------------------

// The generator must depend only on (seed, index), never on call history. With
// a running PRNG, splitting a range would change the output.
func TestRangeIsContiguousAcrossCalls(t *testing.T) {
	s := newSim(7)

	whole := s.Range(0, 200)
	first := s.Range(0, 100)
	second := s.Range(100, 200)

	for i := range whole {
		joined := append(append([]float64{}, first[i].Values...), second[i].Values...)
		if len(joined) != len(whole[i].Values) {
			t.Fatalf("%s: split length %d != whole length %d", whole[i].ChannelID, len(joined), len(whole[i].Values))
		}
		for j := range joined {
			if joined[j] != whole[i].Values[j] {
				t.Fatalf("%s: split output diverges at %d (%v vs %v) - generator is stateful",
					whole[i].ChannelID, j, joined[j], whole[i].Values[j])
			}
		}
	}
}

func TestRangeOutOfOrderOrEmptyReturnsNoSamples(t *testing.T) {
	s := newSim(1)
	for _, tc := range []struct{ from, to int64 }{{0, 0}, {100, 100}, {200, 100}} {
		out := s.Range(tc.from, tc.to)
		if len(out) != len(s.Channels()) {
			t.Fatalf("Range(%d,%d): expected one entry per channel, got %d", tc.from, tc.to, len(out))
		}
		for _, ch := range out {
			if len(ch.Values) != 0 || len(ch.TimestampsNs) != 0 {
				t.Fatalf("Range(%d,%d): %s returned %d samples, want 0", tc.from, tc.to, ch.ChannelID, len(ch.Values))
			}
		}
	}
}

// --- Timestamps ----------------------------------------------------------

func TestTimestampsAreMonotonicAndEvenlySpaced(t *testing.T) {
	s := newSim(3)
	wantPeriod := int64(float64(1e9) / testRate)

	for _, ch := range s.Range(1000, 1100) {
		if len(ch.TimestampsNs) != 100 {
			t.Fatalf("%s: got %d timestamps, want 100", ch.ChannelID, len(ch.TimestampsNs))
		}
		if got, want := ch.TimestampsNs[0], testEpoch+1000*wantPeriod; got != want {
			t.Fatalf("%s: first timestamp %d, want %d", ch.ChannelID, got, want)
		}
		for i := 1; i < len(ch.TimestampsNs); i++ {
			if d := ch.TimestampsNs[i] - ch.TimestampsNs[i-1]; d != wantPeriod {
				t.Fatalf("%s: spacing at %d is %d ns, want %d", ch.ChannelID, i, d, wantPeriod)
			}
		}
	}
}

// --- Metadata ------------------------------------------------------------

func TestChannelsMatchTheSpec(t *testing.T) {
	want := map[string]string{
		"chamber_pressure": "psi",
		"chamber_temp":     "K",
		"vibration":        "g",
		"fuel_flow":        "kg/s",
	}

	got := newSim(1).Channels()
	if len(got) != len(want) {
		t.Fatalf("got %d channels, want %d", len(got), len(want))
	}
	for _, ch := range got {
		unit, ok := want[ch.ID]
		if !ok {
			t.Fatalf("unexpected channel %q", ch.ID)
		}
		if ch.Unit != unit {
			t.Errorf("%s: unit %q, want %q", ch.ID, ch.Unit, unit)
		}
		if ch.SampleRateHz != testRate {
			t.Errorf("%s: rate %v, want %v", ch.ID, ch.SampleRateHz, testRate)
		}
		if ch.Name == "" {
			t.Errorf("%s: empty display name", ch.ID)
		}
	}
}

// --- Physical shape ------------------------------------------------------

func TestSteadyStateIsHotterAndHigherPressureThanIdle(t *testing.T) {
	s := newSim(11)
	idle := findIndexInPhase(t, s, "idle")
	steady := findIndexInPhase(t, s, "steady")

	const window = 500

	idleP := meanOf(t, s, "chamber_pressure", idle, window)
	steadyP := meanOf(t, s, "chamber_pressure", steady, window)
	if steadyP <= idleP*10 {
		t.Errorf("steady pressure %.1f should greatly exceed idle %.1f", steadyP, idleP)
	}

	idleT := meanOf(t, s, "chamber_temp", idle, window)
	steadyT := meanOf(t, s, "chamber_temp", steady, window)
	if steadyT <= idleT {
		t.Errorf("steady temp %.1f should exceed idle %.1f", steadyT, idleT)
	}

	idleF := meanOf(t, s, "fuel_flow", idle, window)
	steadyF := meanOf(t, s, "fuel_flow", steady, window)
	if idleF > 0.5 {
		t.Errorf("idle fuel flow %.3f should be near zero", idleF)
	}
	if steadyF <= 1 {
		t.Errorf("steady fuel flow %.3f should be well above zero", steadyF)
	}
}

func TestChillDownCoolsBelowAmbient(t *testing.T) {
	s := newSim(11)
	idle := findIndexInPhase(t, s, "idle")
	chill := findIndexInPhase(t, s, "chill_down")

	idleT := meanOf(t, s, "chamber_temp", idle, 500)
	chillT := meanOf(t, s, "chamber_temp", chill, 500)
	if chillT >= idleT {
		t.Errorf("chill-down temp %.1f should be below idle %.1f", chillT, idleT)
	}
}

func TestValuesAreFiniteAndNonNegative(t *testing.T) {
	s := newSim(5)

	for _, ch := range s.Range(0, loopSamples()) {
		for i, v := range ch.Values {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("%s: non-finite value %v at index %d", ch.ChannelID, v, i)
			}
			if v < 0 {
				t.Fatalf("%s: negative value %v at index %d", ch.ChannelID, v, i)
			}
		}
	}
}

func TestVibrationCarriesHighFrequencyContent(t *testing.T) {
	s := newSim(9)
	steady := findIndexInPhase(t, s, "steady")

	// A high-frequency sinusoid makes consecutive samples differ far more than
	// a smooth signal would, so compare the mean absolute sample-to-sample
	// delta against the channel mean.
	var vib float64
	for _, ch := range s.Range(steady, steady+1000) {
		if ch.ChannelID != "vibration" {
			continue
		}
		sum := 0.0
		for i := 1; i < len(ch.Values); i++ {
			sum += math.Abs(ch.Values[i] - ch.Values[i-1])
		}
		vib = sum / float64(len(ch.Values)-1)
	}

	mean := meanOf(t, s, "vibration", steady, 1000)
	if vib < mean*0.05 {
		t.Errorf("vibration sample-to-sample delta %.4f too small relative to mean %.4f; "+
			"high-frequency content missing", vib, mean)
	}
}

// --- Anomalies -----------------------------------------------------------

// spikeIndices returns indices where pressure exceeds the steady-state mean by
// a wide margin, i.e. the injected anomaly.
func spikeIndices(t *testing.T, s *sim.Simulator, from, to int64) []int64 {
	t.Helper()
	steady := findIndexInPhase(t, s, "steady")
	threshold := meanOf(t, s, "chamber_pressure", steady, 2000) + 100

	var out []int64
	for _, ch := range s.Range(from, to) {
		if ch.ChannelID != "chamber_pressure" {
			continue
		}
		for i, v := range ch.Values {
			if v > threshold {
				out = append(out, from+int64(i))
			}
		}
	}
	return out
}

func TestAnomalyIsInjectedDuringSteadyState(t *testing.T) {
	s := newSim(17)

	spikes := spikeIndices(t, s, 0, loopSamples())
	if len(spikes) == 0 {
		t.Fatal("no pressure spike in a full loop; the rules engine would have nothing to catch")
	}

	// 30-100ms at 1kHz is 30-100 samples.
	if len(spikes) < 30 || len(spikes) > 100 {
		t.Errorf("spike spans %d samples, want 30-100 (30-100ms at 1kHz)", len(spikes))
	}
	for _, i := range spikes {
		if phase := s.PhaseAt(i); phase != "steady" {
			t.Errorf("spike at index %d is in phase %q, want steady", i, phase)
		}
	}
}

func TestAnomalyLocationIsReproducible(t *testing.T) {
	a := spikeIndices(t, newSim(17), 0, loopSamples())
	b := spikeIndices(t, newSim(17), 0, loopSamples())

	if len(a) != len(b) {
		t.Fatalf("same seed gave %d and %d spike samples", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("same seed put a spike at %d and %d", a[i], b[i])
		}
	}
}

// Noise is specified per phase, but a ramp's base starts near zero while its
// sigma is sized for the fully-developed signal. That made the noise larger
// than the signal early in ignition, and the non-negative clamp turned every
// such draw into an exact zero — a burst of apparent sensor dropout at the
// moment of ignition. Surfaced by M5, whose "chamber not pressurised" anomaly
// reported a peak of 0.0 psi.
func TestRampNoiseNeverClampsToZero(t *testing.T) {
	s := newSim(23)

	zeros := map[string]int{}
	for _, ch := range s.Range(0, loopSamples()) {
		// Fuel flow is genuinely zero at idle: a closed valve reads nothing.
		if ch.ChannelID == "fuel_flow" {
			continue
		}
		for i, v := range ch.Values {
			if v == 0 {
				zeros[ch.ChannelID]++
				if zeros[ch.ChannelID] == 1 {
					t.Errorf("%s reads exactly 0 at index %d (phase %q): noise exceeded the signal and was clamped",
						ch.ChannelID, i, s.PhaseAt(int64(i)))
				}
			}
		}
	}

	for id, n := range zeros {
		t.Logf("%s: %d clamped samples in one loop", id, n)
	}
}

func TestNoiseScalesWithTheSignalDuringIgnition(t *testing.T) {
	s := newSim(23)

	start := findIndexInPhase(t, s, "ignition")
	// Sample the first tenth of the ignition ramp, where the base is lowest.
	early := s.Range(start-2000, start-1500)

	for _, ch := range early {
		if ch.ChannelID != "chamber_pressure" {
			continue
		}
		for _, v := range ch.Values {
			if v <= 0 {
				t.Fatalf("chamber_pressure hit %v early in ignition; noise should shrink with the base", v)
			}
		}
	}
}

package sim_test

import (
	"testing"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
)

// The thresholds the client's rules use, mirrored here so the simulator can be
// held to them. Keep in step with DEFAULT_RULES in web/src/worker/rules.ts.
type ruleSpec struct {
	channel   string
	op        string
	threshold float64
	label     string
}

var clientRules = []ruleSpec{
	{"chamber_pressure", ">", 1100, "Chamber overpressure"},
	{"chamber_temp", ">", 3500, "Chamber overtemperature"},
	{"vibration", ">", 5.0, "Excessive vibration"},
	{"fuel_flow", ">", 15, "Fuel flow surge"},
	{"chamber_temp", "<", 60, "Thermocouple dropout"},
}

func crosses(op string, v, threshold float64) bool {
	if op == ">" {
		return v > threshold
	}
	return v < threshold
}

/*
The point of the whole exercise.

A "chamber not pressurised" rule once shipped with a threshold that normal
operation sat below for roughly a third of every loop: idle and chill-down are
unpressurised by definition, so the rule detected the test sequence rather than
a fault. A threshold that nominal operation crosses routinely is not an alarm,
it is a description of the duty cycle.

Each rule's threshold must therefore be crossed for only a sliver of a loop —
the injected faults and nothing else.
*/
func TestRuleThresholdsAreNotCrossedByNominalOperation(t *testing.T) {
	const loops = 6
	const maxCrossingFraction = 0.02 // 2% of the run

	s := newSim(31)
	total := loopSamples() * loops
	out := s.Range(0, total)

	byChannel := map[string][]float64{}
	for _, ch := range out {
		byChannel[ch.ChannelID] = ch.Values
	}

	for _, rule := range clientRules {
		values := byChannel[rule.channel]
		if values == nil {
			t.Fatalf("%s: no such channel %q", rule.label, rule.channel)
		}

		crossing := 0
		for _, v := range values {
			if crosses(rule.op, v, rule.threshold) {
				crossing++
			}
		}

		fraction := float64(crossing) / float64(len(values))
		if fraction > maxCrossingFraction {
			t.Errorf("%s (%s %s %g): crossed for %.1f%% of the run; a threshold this close to "+
				"nominal describes the duty cycle rather than detecting a fault",
				rule.label, rule.channel, rule.op, rule.threshold, fraction*100)
		}
		t.Logf("%-26s crossed %.3f%% of samples", rule.label, fraction*100)
	}
}

// Each rule must also actually fire: a threshold nothing ever reaches is
// indistinguishable from a broken detector.
func TestEveryRuleThresholdIsReachedBySomeFault(t *testing.T) {
	const loops = 8

	s := newSim(31)
	out := s.Range(0, loopSamples()*loops)

	byChannel := map[string][]float64{}
	for _, ch := range out {
		byChannel[ch.ChannelID] = ch.Values
	}

	for _, rule := range clientRules {
		found := false
		for _, v := range byChannel[rule.channel] {
			if crosses(rule.op, v, rule.threshold) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s (%s %s %g): never reached across %d loops; no fault produces it",
				rule.label, rule.channel, rule.op, rule.threshold, loops)
		}
	}
}

// A burst has to clear its own carrier. Vibration's 120Hz oscillation scales
// with the level, so a burst that only beat the nominal peak would dip back
// under the threshold every few milliseconds and never satisfy a minimum
// duration.
func TestVibrationBurstStaysAboveThresholdThroughItsCarrier(t *testing.T) {
	s := newSim(31)
	values := channelValues(t, s, "vibration", loopSamples()*6)

	const threshold = 5.0
	longest, current := 0, 0
	for _, v := range values {
		if v > threshold {
			current++
			if current > longest {
				longest = current
			}
		} else {
			current = 0
		}
	}

	// The rule requires 100ms; at 1kHz that is 100 consecutive samples.
	if longest < 100 {
		t.Errorf("longest unbroken stretch above %g was %d samples; the rule needs 100, so the "+
			"burst is being chopped up by its own carrier", threshold, longest)
	}
}

func TestFaultsAreReproducibleAndOccasional(t *testing.T) {
	const loops = 10

	countSpikes := func(seed int64) int {
		s := newSim(seed)
		values := channelValues(t, s, "chamber_pressure", loopSamples()*loops)

		spikes, inSpike := 0, false
		for _, v := range values {
			if v > 1100 {
				if !inSpike {
					spikes++
					inSpike = true
				}
			} else {
				inSpike = false
			}
		}
		return spikes
	}

	first, second := countSpikes(31), countSpikes(31)
	if first != second {
		t.Errorf("same seed produced %d spikes then %d", first, second)
	}
	if first == 0 {
		t.Errorf("no overpressure fault in %d loops", loops)
	}
	// Occasional, not every loop: probability is 0.85, so ten loops should not
	// reliably produce ten.
	if first > loops {
		t.Errorf("got %d spikes in %d loops, expected at most one per loop", first, loops)
	}
	t.Logf("%d overpressure faults across %d loops", first, loops)
}

func TestFaultLibraryCoversEveryChannel(t *testing.T) {
	names := sim.FaultNames()
	if len(names) < 4 {
		t.Fatalf("only %d fault modes: %v", len(names), names)
	}
	t.Logf("fault modes: %v", names)
}

func channelValues(t *testing.T, s *sim.Simulator, channelID string, count int64) []float64 {
	t.Helper()
	for _, ch := range s.Range(0, count) {
		if ch.ChannelID == channelID {
			return ch.Values
		}
	}
	t.Fatalf("channel %q not found", channelID)
	return nil
}

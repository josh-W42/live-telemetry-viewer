package stream_test

import (
	"testing"
	"time"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/stream"
)

// A moment the wall clock is deep in steady state, so "resumed on the clock"
// and "restarted at idle" produce obviously different pressures. The loop is
// 72s (idle 4, chill-down 8, ignition 5, steady 45, shutdown 10), and
// 3630s mod 72 is 30s — thirteen seconds into steady.
const midSteadyNs = int64(3630 * time.Second)

func newPump(bus *stream.Broadcaster) *stream.Pump {
	return stream.NewPump(sim.Config{Seed: 1, RateHz: 1000}, bus, 50*time.Millisecond)
}

func firstPressure(t *testing.T, sub *stream.Subscription) float64 {
	t.Helper()

	select {
	case batch := <-sub.C():
		if len(batch.Channels) == 0 || len(batch.Channels[0].Values) == 0 {
			t.Fatal("batch carried no samples")
		}
		return batch.Channels[0].Values[0] // channel 0 is chamber_pressure
	case <-time.After(time.Second):
		t.Fatal("no batch arrived")
		return 0
	}
}

/*
An always-on instance should not spend a core generating 4,000 samples a
second for nobody. Nothing subscribed means nothing to generate.
*/
func TestPumpPublishesNothingWithNoSubscribers(t *testing.T) {
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := newPump(bus)

	p.Flush(int64(time.Second))

	if got := bus.Published(); got != 0 {
		t.Errorf("published %d batches with nobody watching, want 0", got)
	}
}

/*
The trap this test exists for.

Flush publishes Range(next, target). Skipping while idle *without* advancing
the cursor would make the pump generate the entire idle period in one batch
the moment someone connected — an hour of samples at once after an hour of
quiet. Advancing without generating is sound only because the simulator is
pure: phase comes from the sample index, which comes from the epoch, not from
having run.
*/
func TestPumpResumesInStepAfterIdling(t *testing.T) {
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := newPump(bus)

	p.Flush(midSteadyNs) // an hour of wall clock, nobody watching

	sub := mustSubscribe(t, bus, nil)
	defer sub.Close()

	p.Flush(midSteadyNs + int64(50*time.Millisecond))

	batch := <-sub.C()
	if got := len(batch.Channels[0].Values); got > 200 {
		t.Errorf("first batch after idling carried %d samples; expected about 50, so the "+
			"cursor did not advance while idle", got)
	}
}

/*
A returning viewer picks up wherever the clock is. This is what stops a tab
switch cycling the rig: the client only asks for a restart on a page's first
connection.
*/
func TestResumingWithoutRestartStaysOnTheWallClock(t *testing.T) {
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := newPump(bus)

	p.Flush(midSteadyNs)

	sub := mustSubscribe(t, bus, nil)
	defer sub.Close()

	p.Flush(midSteadyNs + int64(50*time.Millisecond))

	if v := firstPressure(t, sub); v < 50 {
		t.Errorf("resumed at %.1f psi, want the steady-state pressure the wall clock is in", v)
	}
}

/*
Restarting is not just rewinding the index. sim.Range stamps every sample
EpochNs + index x period, so rewinding against the boot epoch would emit
timestamps from an hour ago — and the client plots against Date.now(), so the
chart would draw nothing at all. The restart has to move the epoch.
*/
func TestRestartBeginsTheSequenceAgainFromNow(t *testing.T) {
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := newPump(bus)

	p.Flush(midSteadyNs)

	sub := mustSubscribe(t, bus, nil)
	defer sub.Close()

	p.Restart()
	// The restarting flush sets the epoch to now, so IndexAt(now) is 0 and it
	// publishes nothing by construction. Samples start arriving on the next
	// tick - 50ms later in production.
	p.Flush(midSteadyNs)
	if got := bus.Published(); got != 0 {
		t.Fatalf("the restarting flush published %d batches, want 0", got)
	}

	p.Flush(midSteadyNs + int64(50*time.Millisecond))
	batch := <-sub.C()

	if first := batch.Channels[0].TimestampsNs[0]; first < midSteadyNs {
		t.Errorf("first sample stamped %d, before the restart at %d; the epoch did not move",
			first, midSteadyNs)
	}

	// Ambient, because the sequence began again at idle. On the wall clock
	// this instant is deep in steady state at about 1000 psi.
	if v := batch.Channels[0].Values[0]; v > 50 {
		t.Errorf("first sample after restart was %.1f psi, want ambient ~14.7", v)
	}
}

// A restart is consumed once. Two viewers arriving in the same second must not
// leave the rig restarting again on the next tick, which would make the
// sequence stutter back to idle repeatedly.
func TestRestartAppliesOnlyOnce(t *testing.T) {
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	p := newPump(bus)

	sub := mustSubscribe(t, bus, nil)
	defer sub.Close()

	p.Restart()
	p.Flush(midSteadyNs)                              // performs the restart
	p.Flush(midSteadyNs + int64(50*time.Millisecond)) // first samples, at idle
	<-sub.C()

	// If the flag were still set this would restart again and publish nothing,
	// because a restart puts the cursor and the clock at the same instant.
	p.Flush(midSteadyNs + int64(20*time.Second))

	if got := bus.Published(); got != 2 {
		t.Fatalf("published %d batches, want 2; the restart flag was not consumed", got)
	}

	batch := <-sub.C()
	last := batch.Channels[0].Values[len(batch.Channels[0].Values)-1]
	if last < 50 {
		t.Errorf("twenty seconds in, pressure is %.1f psi; the sequence did not run on", last)
	}
}

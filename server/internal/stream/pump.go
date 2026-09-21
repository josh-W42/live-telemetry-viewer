package stream

import (
	"context"
	"sync/atomic"
	"time"

	telemetryv1 "github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
)

// Pump drives the simulator on a wall clock and publishes batches.
//
// It is the only place in the server that reads the clock. The simulator is
// pure and the broadcaster is passive; the pump is what turns sample indices
// into a live stream.
type Pump struct {
	cfg      sim.Config
	sim      *sim.Simulator
	bus      *Broadcaster
	interval time.Duration

	// next is the first sample index not yet published.
	next int64

	// restart is set from the service goroutine and consumed here.
	restart atomic.Bool
}

// NewPump returns a Pump that flushes a batch every interval.
//
// It takes the simulator's config rather than a simulator, because restarting
// the test sequence means building a new one with a later epoch.
func NewPump(cfg sim.Config, bus *Broadcaster, interval time.Duration) *Pump {
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	return &Pump{cfg: cfg, sim: sim.New(cfg), bus: bus, interval: interval}
}

// Restart asks for the test sequence to begin again at the next flush.
//
// Called when a new visitor arrives to an idle rig, so they watch the sequence
// from idle rather than landing at a random point in it.
func (p *Pump) Restart() { p.restart.Store(true) }

// Run publishes batches until ctx is cancelled.
func (p *Pump) Run(ctx context.Context) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			p.Flush(now.UnixNano())
		}
	}
}

// Flush publishes every sample whose timestamp has arrived.
//
// Exported so the behaviour below can be tested against a clock the test
// controls, rather than by waiting on a ticker.
//
// The target index comes from elapsed wall time rather than from a fixed
// count per tick. If a tick runs late the next one emits proportionally more
// samples, so the stream self-corrects instead of drifting further behind over
// a long run. Batch sizes therefore vary slightly, which is realistic and
// stops the client assuming a fixed size.
func (p *Pump) Flush(nowNs int64) {
	if p.restart.Swap(false) {
		// A new value rather than mutating the existing simulator, so nothing
		// races with the Service's own reference to it. Channels() is
		// epoch-independent, so the two agree on metadata regardless.
		p.sim = sim.New(sim.Config{Seed: p.cfg.Seed, RateHz: p.cfg.RateHz, EpochNs: nowNs})
		p.next = 0
	}

	target := p.sim.IndexAt(nowNs)
	if target <= p.next {
		return
	}

	// Nobody is listening. Advance the cursor so the sequence stays on the
	// wall clock, but generate nothing: the work would be thrown away, and an
	// always-on instance should not burn a core producing telemetry for
	// nobody.
	//
	// Advancing without generating is sound only because the simulator is
	// pure. Skipping without advancing would publish the whole idle period in
	// one batch the moment someone finally connected.
	if p.bus.SubscriberCount() == 0 {
		p.next = target
		return
	}

	samples := p.sim.Range(p.next, target)
	p.next = target

	p.bus.Publish(toProto(samples))
}

// toProto converts simulator output to the wire type. The slices are handed
// over directly rather than copied: Range allocates fresh ones each call and
// nothing reads them afterwards.
func toProto(samples []sim.Samples) []*telemetryv1.ChannelSamples {
	out := make([]*telemetryv1.ChannelSamples, len(samples))
	for i, s := range samples {
		out[i] = &telemetryv1.ChannelSamples{
			ChannelId:    s.ChannelID,
			TimestampsNs: s.TimestampsNs,
			Values:       s.Values,
		}
	}
	return out
}

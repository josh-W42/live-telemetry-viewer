package stream

import (
	"context"
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
	sim      *sim.Simulator
	bus      *Broadcaster
	interval time.Duration

	// next is the first sample index not yet published.
	next int64
}

// NewPump returns a Pump that flushes a batch every interval.
func NewPump(s *sim.Simulator, bus *Broadcaster, interval time.Duration) *Pump {
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	return &Pump{sim: s, bus: bus, interval: interval}
}

// Run publishes batches until ctx is cancelled.
func (p *Pump) Run(ctx context.Context) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			p.flush(now.UnixNano())
		}
	}
}

// flush publishes every sample whose timestamp has arrived.
//
// The target index comes from elapsed wall time rather than from a fixed
// count per tick. If a tick runs late the next one emits proportionally more
// samples, so the stream self-corrects instead of drifting further behind over
// a long run. Batch sizes therefore vary slightly, which is realistic and
// stops the client assuming a fixed size.
func (p *Pump) flush(nowNs int64) {
	target := p.sim.IndexAt(nowNs)
	if target <= p.next {
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

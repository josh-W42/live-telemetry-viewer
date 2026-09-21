// Package stream implements the TelemetryService Connect handlers, the
// fan-out broadcaster behind them, and the pump that feeds it.
package stream

import (
	"context"
	"log"

	"connectrpc.com/connect"

	telemetryv1 "github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1"
	"github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1/telemetryv1connect"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
)

// Service implements telemetryv1connect.TelemetryServiceHandler.
type Service struct {
	sim *sim.Simulator
	bus *Broadcaster

	// onNewSession restarts the test sequence. Nil disables the behaviour,
	// which is what most tests want.
	onNewSession func()
}

// Compile-time proof that Service satisfies the generated interface. If a
// proto change alters a method signature, this fails at build time rather than
// at handler registration.
var _ telemetryv1connect.TelemetryServiceHandler = (*Service)(nil)

// New returns a Service reading channel metadata from s and batches from bus.
func New(s *sim.Simulator, bus *Broadcaster, onNewSession func()) *Service {
	return &Service{sim: s, bus: bus, onNewSession: onNewSession}
}

// ListChannels returns the channels the simulator produces.
func (s *Service) ListChannels(
	_ context.Context,
	_ *connect.Request[telemetryv1.ListChannelsRequest],
) (*connect.Response[telemetryv1.ListChannelsResponse], error) {
	chans := s.sim.Channels()

	out := make([]*telemetryv1.Channel, len(chans))
	for i, c := range chans {
		out[i] = &telemetryv1.Channel{
			Id:           c.ID,
			Name:         c.Name,
			Unit:         c.Unit,
			SampleRateHz: c.SampleRateHz,
			DisplayMin:   c.DisplayMin,
			DisplayMax:   c.DisplayMax,
		}
	}

	return connect.NewResponse(&telemetryv1.ListChannelsResponse{Channels: out}), nil
}

// StreamTelemetry streams batched samples until the client disconnects.
func (s *Service) StreamTelemetry(
	ctx context.Context,
	req *connect.Request[telemetryv1.StreamTelemetryRequest],
	out *connect.ServerStream[telemetryv1.TelemetryBatch],
) error {
	// Checked here rather than in the pump so that "a join mid-run is not a
	// restart" holds by construction: the count can only be zero when nobody
	// else is watching. The check-then-subscribe race is real and benign - two
	// simultaneous cold arrivals both see zero, both ask, and the pump
	// restarts once.
	if req.Msg.NewSession && s.onNewSession != nil && s.bus.SubscriberCount() == 0 {
		s.onNewSession()
	}

	sub, err := s.bus.Subscribe(req.Msg.ChannelIds)
	if err != nil {
		// ResourceExhausted rather than Unavailable: the server is healthy,
		// it is this request that cannot be served right now.
		return connect.NewError(connect.CodeResourceExhausted, err)
	}
	defer sub.Close()

	log.Printf("stream: subscriber connected (channels=%v, total=%d)",
		req.Msg.ChannelIds, s.bus.SubscriberCount())
	defer func() {
		log.Printf("stream: subscriber disconnected (dropped=%d, remaining=%d)",
			sub.Dropped(), s.bus.SubscriberCount()-1)
	}()

	for {
		select {
		case <-ctx.Done():
			// Client hung up or the server is shutting down. Not an error.
			return nil

		case batch, ok := <-sub.C():
			if !ok {
				return nil
			}
			// Send blocks until the batch is written. That is fine: it blocks
			// this one handler goroutine, never the pump, because the
			// broadcaster already handed us a buffered copy.
			if err := out.Send(batch); err != nil {
				return err
			}
		}
	}
}

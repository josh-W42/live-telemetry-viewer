// Package stream implements the TelemetryService Connect handlers.
package stream

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	telemetryv1 "github.com/josh-W42/sift/server/gen/telemetry/v1"
	"github.com/josh-W42/sift/server/gen/telemetry/v1/telemetryv1connect"
)

// Service implements telemetryv1connect.TelemetryServiceHandler.
//
// M0 wires up the transport only: both methods report Unimplemented so the
// browser gets a real, structured Connect error across the wire. M1 replaces
// these with the simulator and the fan-out broadcaster.
type Service struct{}

// Compile-time proof that Service satisfies the generated interface. If a proto
// change alters a method signature, this fails at build time rather than at
// handler registration.
var _ telemetryv1connect.TelemetryServiceHandler = (*Service)(nil)

// New returns a Service.
func New() *Service {
	return &Service{}
}

// ListChannels returns the channels the simulator produces.
func (s *Service) ListChannels(
	_ context.Context,
	_ *connect.Request[telemetryv1.ListChannelsRequest],
) (*connect.Response[telemetryv1.ListChannelsResponse], error) {
	return nil, connect.NewError(
		connect.CodeUnimplemented,
		errors.New("ListChannels arrives in M1"),
	)
}

// StreamTelemetry streams batched samples until the client disconnects.
func (s *Service) StreamTelemetry(
	_ context.Context,
	_ *connect.Request[telemetryv1.StreamTelemetryRequest],
	_ *connect.ServerStream[telemetryv1.TelemetryBatch],
) error {
	return connect.NewError(
		connect.CodeUnimplemented,
		errors.New("StreamTelemetry arrives in M1"),
	)
}

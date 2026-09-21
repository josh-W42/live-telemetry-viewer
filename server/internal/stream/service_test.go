package stream_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	telemetryv1 "github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1"
	"github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1/telemetryv1connect"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/stream"
)

const viteOrigin = "http://localhost:5173"

// newTestServer starts a real HTTP server wired the way main.go wires it,
// including a running pump, and returns a generated client pointed at it plus
// the broadcaster driving it.
//
// The pump matters: a Connect server-stream call does not return to the caller
// until the server writes its first message. A server that subscribes and then
// waits for data that only arrives after the call returns deadlocks. Running
// the pump also matches production, where clients always join a stream already
// in progress.
func newTestServer(t *testing.T) (telemetryv1connect.TelemetryServiceClient, *stream.Broadcaster, *httptest.Server) {
	t.Helper()

	s := sim.New(sim.Config{Seed: 1, RateHz: 1000, EpochNs: time.Now().UnixNano()})
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)

	ctx, cancel := context.WithCancel(context.Background())
	go stream.NewPump(s, bus, 10*time.Millisecond).Run(ctx)

	srv := httptest.NewServer(stream.NewHTTPHandler(stream.New(s, bus), viteOrigin))
	t.Cleanup(func() {
		cancel()
		srv.Close()
	})

	client := telemetryv1connect.NewTelemetryServiceClient(srv.Client(), srv.URL)
	return client, bus, srv
}

func TestListChannelsReturnsTheSimulatorChannels(t *testing.T) {
	client, _, _ := newTestServer(t)

	res, err := client.ListChannels(context.Background(), connect.NewRequest(&telemetryv1.ListChannelsRequest{}))
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}

	if got := len(res.Msg.Channels); got != 4 {
		t.Fatalf("got %d channels, want 4", got)
	}
	for _, ch := range res.Msg.Channels {
		if ch.Id == "" || ch.Name == "" || ch.Unit == "" {
			t.Errorf("incomplete channel metadata: %+v", ch)
		}
		// The viewer draws a fixed axis from these, so an unset range would
		// collapse the chart to a line at zero rather than fail loudly.
		if ch.DisplayMax <= ch.DisplayMin {
			t.Errorf("%s: display range [%v, %v] is empty or inverted",
				ch.Id, ch.DisplayMin, ch.DisplayMax)
		}
		if ch.SampleRateHz != 1000 {
			t.Errorf("%s: rate %v, want 1000", ch.Id, ch.SampleRateHz)
		}
	}
}

func TestStreamTelemetryDeliversBatchesInSequence(t *testing.T) {
	client, _, _ := newTestServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st, err := client.StreamTelemetry(ctx, connect.NewRequest(&telemetryv1.StreamTelemetryRequest{}))
	if err != nil {
		t.Fatalf("StreamTelemetry: %v", err)
	}
	defer st.Close()

	// The pump has been running since the server started, so the first
	// sequence seen is whatever was current when this client subscribed.
	// What matters is that the run is unbroken from there.
	const want = 5
	var prev uint64

	for i := 0; i < want; i++ {
		if !st.Receive() {
			t.Fatalf("stream ended after %d batches: %v", i, st.Err())
		}
		batch := st.Msg()

		if prev != 0 && batch.Sequence != prev+1 {
			t.Errorf("sequence jumped from %d to %d on an idle stream", prev, batch.Sequence)
		}
		prev = batch.Sequence

		if len(batch.Channels) != 4 {
			t.Fatalf("batch carries %d channels, want 4", len(batch.Channels))
		}
		for _, ch := range batch.Channels {
			if len(ch.TimestampsNs) != len(ch.Values) {
				t.Errorf("%s: %d timestamps but %d values", ch.ChannelId, len(ch.TimestampsNs), len(ch.Values))
			}
			if len(ch.Values) == 0 {
				t.Errorf("%s: empty batch", ch.ChannelId)
			}
		}
	}
}

func TestStreamTelemetryHonoursChannelFilter(t *testing.T) {
	client, _, _ := newTestServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st, err := client.StreamTelemetry(ctx, connect.NewRequest(&telemetryv1.StreamTelemetryRequest{
		ChannelIds: []string{"vibration"},
	}))
	if err != nil {
		t.Fatalf("StreamTelemetry: %v", err)
	}
	defer st.Close()

	if !st.Receive() {
		t.Fatalf("stream ended early: %v", st.Err())
	}
	batch := st.Msg()
	if len(batch.Channels) != 1 {
		t.Fatalf("got %d channels, want 1", len(batch.Channels))
	}
	if got := batch.Channels[0].ChannelId; got != "vibration" {
		t.Errorf("got channel %q, want vibration", got)
	}
}

func TestStreamTelemetryUnsubscribesWhenClientDisconnects(t *testing.T) {
	client, bus, _ := newTestServer(t)

	ctx, cancel := context.WithCancel(context.Background())
	st, err := client.StreamTelemetry(ctx, connect.NewRequest(&telemetryv1.StreamTelemetryRequest{}))
	if err != nil {
		t.Fatalf("StreamTelemetry: %v", err)
	}

	waitForSubscribers(t, bus, 1)

	cancel()
	_ = st.Close()

	waitForSubscribers(t, bus, 0)
}

func waitForSubscribers(t *testing.T, bus *stream.Broadcaster, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if bus.SubscriberCount() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("subscriber count stayed at %d, want %d", bus.SubscriberCount(), want)
}

// --- CORS ----------------------------------------------------------------

// preflight issues an OPTIONS request the way a browser would.
//
// rs/cors matches Access-Control-Request-Headers as a sorted set, so the header
// list must be in alphabetical order exactly as browsers send it. An unsorted
// list is rejected and looks indistinguishable from a broken CORS config.
func preflight(t *testing.T, srv *httptest.Server, origin string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodOptions, srv.URL+telemetryv1connect.TelemetryServiceListChannelsProcedure, nil)
	if err != nil {
		t.Fatalf("building preflight: %v", err)
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "connect-protocol-version,content-type")

	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

func TestCORSAllowsTheViteOrigin(t *testing.T) {
	_, _, srv := newTestServer(t)

	res := preflight(t, srv, viteOrigin)

	if got := res.Header.Get("Access-Control-Allow-Origin"); got != viteOrigin {
		t.Errorf("Access-Control-Allow-Origin is %q, want %q", got, viteOrigin)
	}
	allowed := strings.ToLower(res.Header.Get("Access-Control-Allow-Headers"))
	for _, want := range []string{"connect-protocol-version", "content-type"} {
		if !strings.Contains(allowed, want) {
			t.Errorf("Access-Control-Allow-Headers %q is missing %q", allowed, want)
		}
	}
}

func TestCORSRejectsAnUnknownOrigin(t *testing.T) {
	_, _, srv := newTestServer(t)

	res := preflight(t, srv, "http://evil.example")

	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unknown origin was allowed: Access-Control-Allow-Origin is %q", got)
	}
}

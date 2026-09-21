package stream_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/stream"
)

// newHandler builds the handler the way main.go does, without a listener.
func newHandler(t *testing.T, allowedOrigin string, static http.Handler) http.Handler {
	t.Helper()

	s := sim.New(sim.Config{Seed: 1, RateHz: 1000, EpochNs: time.Now().UnixNano()})
	bus := stream.NewBroadcaster(stream.DefaultBufferDepth)
	return stream.NewHTTPHandler(stream.New(s, bus), allowedOrigin, static)
}

func do(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

// Render gates deploys and restarts on this, so a missing or slow health
// endpoint shows up as a deploy that never goes live rather than as an error.
func TestHealthzReportsOK(t *testing.T) {
	rec := do(t, newHandler(t, "", nil), http.MethodGet, "/healthz")

	if rec.Code != http.StatusOK {
		t.Errorf("got %d, want 200", rec.Code)
	}
}

/*
The catch-all that serves the web app must not swallow the RPC prefix.

ServeMux matches the longest registered pattern, so mounting static at "/"
cannot shadow the service path — but that is a property of how the routes are
registered, and registering them differently would break it silently. A
request to the service reaching the static handler would surface as a blank
page rather than an error.
*/
func TestTheStaticHandlerDoesNotShadowTheAPI(t *testing.T) {
	static := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("STATIC"))
	})

	h := newHandler(t, "", static)
	rec := do(t, h, http.MethodPost, "/telemetry.v1.TelemetryService/ListChannels")

	if rec.Body.String() == "STATIC" {
		t.Fatal("an RPC was served by the static handler; the catch-all is shadowing the service")
	}
}

func TestTheStaticHandlerServesEverythingElse(t *testing.T) {
	static := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("STATIC"))
	})

	rec := do(t, newHandler(t, "", static), http.MethodGet, "/some/client/route")

	if rec.Body.String() != "STATIC" {
		t.Errorf("got %q, want the static handler to answer", rec.Body.String())
	}
}

// A nil static handler is how the tests and an API-only run work, and it must
// not panic on a path nothing else claims.
func TestNoStaticHandlerIsFine(t *testing.T) {
	rec := do(t, newHandler(t, "", nil), http.MethodGet, "/some/client/route")

	if rec.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404 with no static handler mounted", rec.Code)
	}
}

/*
On one origin the browser never sends a preflight, so the CORS middleware has
nothing to do in production.

Empty means "no middleware" rather than "allow *" deliberately: a permissive
wildcard in front of an unauthenticated endpoint that streams 68 KiB/s to
anyone who asks would be a worse default than none at all.
*/
func TestNoCORSHeadersWhenNoOriginIsConfigured(t *testing.T) {
	h := newHandler(t, "", nil)

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	req.Header.Set("Origin", "https://somewhere.example")
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("allowed origin %q with CORS switched off", got)
	}
}

// The dev server still needs it: Vite serves the page from :5173 while the API
// answers on :8080.
func TestTheConfiguredOriginIsStillAllowed(t *testing.T) {
	h := newHandler(t, viteOrigin, nil)

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	req.Header.Set("Origin", viteOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != viteOrigin {
		t.Errorf("got %q, want the configured origin to be allowed", got)
	}
}

func TestAnUnknownOriginIsRefusedWhenCORSIsOn(t *testing.T) {
	h := newHandler(t, viteOrigin, nil)

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	req.Header.Set("Origin", "https://somewhere.example")
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("allowed %q, which is not the configured origin", got)
	}
}

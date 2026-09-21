package stream

import (
	"net/http"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1/telemetryv1connect"
)

// NewHTTPHandler mounts the Connect service and wraps it in CORS and h2c.
//
// This lives here rather than in package main so the CORS policy is reachable
// from a test.
func NewHTTPHandler(svc *Service, allowedOrigin string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle(telemetryv1connect.NewTelemetryServiceHandler(svc))

	// h2c serves HTTP/2 over cleartext. Without it Go speaks HTTP/2 only over
	// TLS, so gRPC clients (which require HTTP/2) could not reach a plain
	// http:// dev server. Browsers using the Connect protocol are fine over
	// HTTP/1.1, so this is here for grpc/grpcurl compatibility.
	return h2c.NewHandler(withCORS(mux, allowedOrigin), &http2.Server{})
}

// withCORS allows the Vite dev server to call the API from another origin.
//
// Connect sends and receives several headers of its own (Connect-Protocol-Version,
// Connect-Timeout-Ms, the Grpc-* trailers). A browser blocks any header not
// named in the preflight response, so connectcors supplies the exact lists
// rather than us hand-maintaining them.
func withCORS(h http.Handler, origin string) http.Handler {
	return cors.New(cors.Options{
		AllowedOrigins: []string{origin},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: connectcors.AllowedHeaders(),
		ExposedHeaders: connectcors.ExposedHeaders(),
		MaxAge:         7200, // seconds; caps Chrome's preflight cache
	}).Handler(h)
}

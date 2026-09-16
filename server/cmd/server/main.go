// Command server hosts the telemetry Connect service.
package main

import (
	"errors"
	"flag"
	"log"
	"net/http"
	"time"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/josh-W42/sift/server/gen/telemetry/v1/telemetryv1connect"
	"github.com/josh-W42/sift/server/internal/stream"
)

func main() {
	port := flag.String("port", "8080", "port to listen on")
	// Declared now because the spec calls for them; the simulator reads them in M1.
	rate := flag.Float64("rate", 1000, "samples per second per channel")
	seed := flag.Int64("seed", 1, "simulator seed, for reproducible runs")
	batchInterval := flag.Duration("batch-interval", 50*time.Millisecond, "how often to flush a batch")
	allowedOrigin := flag.String("allowed-origin", "http://localhost:5173", "CORS origin for the Vite dev server")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle(telemetryv1connect.NewTelemetryServiceHandler(stream.New()))

	handler := withCORS(mux, *allowedOrigin)

	addr := ":" + *port
	srv := &http.Server{
		Addr: addr,
		// h2c serves HTTP/2 over cleartext. Without it, Go only speaks HTTP/2
		// over TLS, and gRPC clients (which require HTTP/2) could not reach a
		// plain http:// dev server. Browsers using the Connect protocol are
		// fine over HTTP/1.1, so this is here for grpc/grpcurl compatibility.
		Handler:           h2c.NewHandler(handler, &http2.Server{}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("telemetry server listening on %s (rate=%.0fHz seed=%d batch=%s)", addr, *rate, *seed, *batchInterval)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server: %v", err)
	}
}

// withCORS allows the Vite dev server to call the API from a different origin.
//
// Connect sends and receives a handful of its own headers (Connect-Protocol-Version,
// Connect-Timeout-Ms, the Grpc-* trailers). A browser blocks any header not named
// in the CORS preflight response, so connectcors supplies the exact lists rather
// than us hand-maintaining them.
func withCORS(h http.Handler, origin string) http.Handler {
	return cors.New(cors.Options{
		AllowedOrigins: []string{origin},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: connectcors.AllowedHeaders(),
		ExposedHeaders: connectcors.ExposedHeaders(),
		MaxAge:         7200, // seconds; caps Chrome's preflight cache
	}).Handler(h)
}

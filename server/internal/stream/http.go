package stream

import (
	"net/http"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1/telemetryv1connect"
)

// NewHTTPHandler mounts the Connect service, a health check, and — in a
// deployed build — the web app, all on one origin.
//
// Serving the app from the same handler as the API is what removes CORS from
// the deployment entirely: the browser never makes a cross-origin request, so
// there is no preflight to satisfy and no origin to configure at either end.
//
// `static` may be nil, which is what the tests and an API-only run use.
//
// This lives here rather than in package main so the routing and the CORS
// policy are reachable from a test.
func NewHTTPHandler(svc *Service, allowedOrigin string, static http.Handler) http.Handler {
	mux := http.NewServeMux()

	// The path comes from the generated handler rather than being written out
	// here. ServeMux matches the longest registered pattern, so the catch-all
	// below cannot shadow the service, and nothing has to be kept in step by
	// hand if the proto package ever changes.
	path, connectHandler := telemetryv1connect.NewTelemetryServiceHandler(svc)
	mux.Handle(path, connectHandler)

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	if static != nil {
		mux.Handle("/", static)
	}

	// h2c serves HTTP/2 over cleartext, so grpcurl and native gRPC clients can
	// reach a plain http:// dev server.
	//
	// It is deliberately not load-bearing in production. Render's proxy speaks
	// HTTP/1.1 to the service, and Connect's server-streaming runs over
	// HTTP/1.1 chunked transfer — which is precisely why SPEC.md chose Connect
	// over grpc-web. Only bidirectional streaming would need HTTP/2, and there
	// is none here. Keep this; it costs nothing and it helps locally.
	return h2c.NewHandler(withCORS(mux, allowedOrigin), &http2.Server{})
}

// withCORS allows a cross-origin dev client to call the API.
//
// Connect sends and receives several headers of its own (Connect-Protocol-Version,
// Connect-Timeout-Ms, the Grpc-* trailers). A browser blocks any header not
// named in the preflight response, so connectcors supplies the exact lists
// rather than us hand-maintaining them.
func withCORS(h http.Handler, origin string) http.Handler {
	// No origin configured means the single-origin deployment, where the
	// browser never preflights and this middleware has nothing to do.
	//
	// Empty means "off" rather than "allow *" on purpose: a permissive
	// wildcard on an unauthenticated streaming endpoint would be a worse
	// default than no middleware at all.
	if origin == "" {
		return h
	}

	return cors.New(cors.Options{
		AllowedOrigins: []string{origin},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: connectcors.AllowedHeaders(),
		ExposedHeaders: connectcors.ExposedHeaders(),
		MaxAge:         7200, // seconds; caps Chrome's preflight cache
	}).Handler(h)
}

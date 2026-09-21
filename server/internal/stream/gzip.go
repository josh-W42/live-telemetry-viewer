package stream

import (
	"compress/gzip"
	"net/http"
	"strings"
)

// WithGzip compresses responses for clients that accept it.
//
// The bundle is about 1.6 MB raw and 528 KB gzipped, which is the difference
// between a fast and a slow first paint on a cold link — the moment this whole
// deployment is optimised for.
//
// Done in the app rather than left to the proxy on purpose: whether Render's
// proxy compresses, or buffers, is the one thing about the platform that could
// not be established from its documentation, and a three-fold difference in
// first-paint bytes is not worth leaving to an assumption.
func WithGzip(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.ServeHTTP(w, r)
			return
		}

		gz := gzip.NewWriter(w)
		defer func() { _ = gz.Close() }()

		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")

		h.ServeHTTP(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
}

// WriteHeader drops Content-Length at the moment the handler commits its
// headers, not before.
//
// Deleting it up front does not work, and the failure is silent: http.FileServer
// sets Content-Length itself while serving, so an earlier delete is simply
// overwritten and the response then advertises the uncompressed size while
// carrying compressed bytes. A test caught this; production would have shown
// it as every page load being truncated.
func (w *gzipWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		w.Header().Del("Content-Length")
	}
	w.ResponseWriter.WriteHeader(code)
}

// Write commits the headers itself first. The compressor writes to the
// underlying ResponseWriter, whose implicit WriteHeader would otherwise run
// without passing through the override above.
func (w *gzipWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.gz.Write(b)
}

// Flush passes through to the compressor as well as the underlying writer.
//
// Without this, a streaming handler's flush would stop at the gzip buffer and
// the client would see nothing until that buffer filled - reintroducing inside
// this application the exact failure the platform was checked for. Nothing
// streamed goes through this middleware today, but a handler that did would
// break silently and confusingly.
func (w *gzipWriter) Flush() {
	_ = w.gz.Flush()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

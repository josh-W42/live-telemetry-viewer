package stream_test

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/stream"
)

const body = "telemetry telemetry telemetry "

func gzipped(h http.Handler, accept string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if accept != "" {
		req.Header.Set("Accept-Encoding", accept)
	}

	rec := httptest.NewRecorder()
	stream.WithGzip(h).ServeHTTP(rec, req)
	return rec
}

func writes(text string, n int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(strings.Repeat(text, n)))
	})
}

func TestCompressesWhenTheClientAccepts(t *testing.T) {
	rec := gzipped(writes(body, 200), "gzip")

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding is %q, want gzip", got)
	}

	raw := len(body) * 200
	if rec.Body.Len() >= raw/2 {
		t.Errorf("compressed to %d bytes from %d; barely smaller", rec.Body.Len(), raw)
	}
}

// The compressed bytes have to actually be the original bytes.
func TestTheCompressedBodyRoundTrips(t *testing.T) {
	rec := gzipped(writes(body, 200), "gzip")

	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("not valid gzip: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	if want := strings.Repeat(body, 200); string(got) != want {
		t.Errorf("round trip lost data: %d bytes out, %d in", len(got), len(want))
	}
}

func TestLeavesTheBodyAloneWhenTheClientDoesNotAccept(t *testing.T) {
	rec := gzipped(writes("plain", 1), "")

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("compressed for a client that did not ask: %q", got)
	}
	if rec.Body.String() != "plain" {
		t.Errorf("body was altered: %q", rec.Body.String())
	}
}

// Caches key on it, and a shared cache serving gzip to a client that cannot
// read it is a broken page.
func TestVaryIsSet(t *testing.T) {
	if got := gzipped(writes(body, 10), "gzip").Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary is %q, want it to include Accept-Encoding", got)
	}
}

// A stale Content-Length would describe the uncompressed body and truncate
// the response.
func TestContentLengthIsDropped(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "9999")
		_, _ = w.Write([]byte(strings.Repeat(body, 50)))
	})

	if got := gzipped(h, "gzip").Header().Get("Content-Length"); got == "9999" {
		t.Error("kept the uncompressed Content-Length, which would truncate the body")
	}
}

/*
A flush must reach the socket, not stop at the gzip buffer.

Nothing streamed goes through this middleware today, but a handler that did
would otherwise deliver nothing until the buffer filled - reintroducing inside
this application the exact proxy behaviour the platform was checked for.
*/
func TestFlushReachesTheUnderlyingWriter(t *testing.T) {
	flushed := false
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
		f, ok := w.(http.Flusher)
		if !ok {
			t.Error("the wrapped writer is not a Flusher, so streaming handlers cannot flush")
			return
		}
		f.Flush()
		flushed = true
	})

	rec := gzipped(h, "gzip")
	if !flushed {
		t.Fatal("handler could not flush")
	}
	if rec.Body.Len() == 0 {
		t.Error("nothing reached the writer after a flush")
	}
}

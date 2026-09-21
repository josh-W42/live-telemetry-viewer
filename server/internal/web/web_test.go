package web_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/web"
)

func get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()

	rec := httptest.NewRecorder()
	web.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestServesTheIndex(t *testing.T) {
	rec := get(t, "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<!doctype html>") {
		t.Errorf("body is not an HTML page: %.80q", rec.Body.String())
	}
}

/*
A single-page app owns its own routing, so a deep link the server has never
heard of must still return the page. Without this, refreshing the browser on
any client-side route gives a 404 instead of the app.
*/
func TestUnknownPathsFallBackToTheIndex(t *testing.T) {
	rec := get(t, "/some/client/route")

	if rec.Code != http.StatusOK {
		t.Errorf("got %d for a client-side route, want the index", rec.Code)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<!doctype html>") {
		t.Errorf("fallback did not return the page")
	}
}

/*
Vite fingerprints asset filenames, so a given name's contents can never
change and the file can be cached indefinitely. index.html must not be, or a
deploy would never reach anyone holding a cached copy - they would keep
loading an old page that references assets which no longer exist.
*/
func TestTheIndexIsNotCached(t *testing.T) {
	cc := get(t, "/").Header().Get("Cache-Control")

	if !strings.Contains(cc, "no-cache") {
		t.Errorf("index Cache-Control is %q; a cached index pins visitors to an old deploy", cc)
	}
}

func TestAFallbackResponseIsNotCachedEither(t *testing.T) {
	cc := get(t, "/deep/link").Header().Get("Cache-Control")

	if !strings.Contains(cc, "no-cache") {
		t.Errorf("fallback Cache-Control is %q; it is the index by another name", cc)
	}
}

// The handler must not panic or escape its root when asked for something odd.
func TestOddPathsAreHandled(t *testing.T) {
	for _, path := range []string{"/../go.mod", "//", "/assets/", "/%2e%2e/secret"} {
		rec := get(t, path)
		if rec.Code >= 500 {
			t.Errorf("%s returned %d", path, rec.Code)
		}
	}
}

// Package web serves the built single-page app from inside the binary.
//
// Embedding rather than shipping a directory means the deployable is one file
// and the assets cannot drift from the server that serves them. Serving them
// from the same handler as the API is what removes CORS from the deployment:
// the browser never makes a cross-origin request.
//
// The directory is called `assets` and not `dist` deliberately. The repo's
// .gitignore has a bare `dist/` rule, which matches at any depth and would
// silently swallow the development placeholder committed here.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// The Docker build overwrites this directory with the real bundle. What is
// committed is a placeholder explaining how to run the dev server, which also
// keeps `go run ./cmd/server` compiling on a clean checkout - //go:embed
// fails at compile time if the directory is empty.
//
//go:embed assets
var embedded embed.FS

// Handler serves the app, falling back to index.html for unknown paths.
func Handler() http.Handler {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		// Only reachable if the embed directive above is wrong, which is a
		// compile-shaped mistake rather than a runtime condition.
		panic(err)
	}

	files := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// path.Clean resolves any ".." before it reaches the filesystem. The
		// embedded FS would reject an escape anyway, but rejecting it here
		// means the fallback below sees a name it can actually check.
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")

		if name == "" || !exists(sub, name) {
			// Not a file we hold: hand back the page and let the client route.
			serveIndex(w, r, files)
			return
		}

		// Vite fingerprints asset filenames, so their contents can never
		// change under a given name.
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func exists(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}

func serveIndex(w http.ResponseWriter, r *http.Request, files http.Handler) {
	// No caching: a cached index would pin a visitor to a deploy whose
	// fingerprinted assets have already been replaced.
	w.Header().Set("Cache-Control", "no-cache")

	r = r.Clone(r.Context())
	r.URL.Path = "/"
	files.ServeHTTP(w, r)
}

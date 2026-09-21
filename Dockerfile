# syntax=docker/dockerfile:1

# One container serving the SPA and the API from a single origin. That is what
# removes CORS from the deployment and makes the page and the stream wake
# together, rather than a CDN-instant page hanging on "connecting" while a
# backend spins up.

# ---- 1. Build the web app -------------------------------------------------
#
# slim rather than alpine deliberately: esbuild ships its platform binary as an
# optional dependency, and resolving that against musl under --ignore-scripts
# is an avoidable way to lose an afternoon.
FROM node:24-slim AS web
WORKDIR /app

# Copied before the source so a change to application code does not invalidate
# the dependency layer.
COPY web/package.json web/package-lock.json ./
# Matches `just install`: exactly what the lockfile pins, and no package
# lifecycle hooks.
RUN npm ci --ignore-scripts

COPY web/ ./
# `npm run build` is tsc --noEmit && vite build, so a type error fails the
# image rather than shipping.
RUN npm run build

# ---- 2. Build a static Go binary with the bundle inside it ----------------
#
# The image must satisfy the `go` directive in server/go.mod (1.26.0).
FROM golang:1.26-bookworm AS server
WORKDIR /src

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
# //go:embed cannot reach outside its module, and server/ is the module root
# while web/ is a sibling - so the bundle is copied in here. The directory is
# `assets` and not `dist` because .gitignore has a bare `dist/` rule that
# matches at any depth.
COPY --from=web /app/dist/ ./internal/web/assets/

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/telemetry ./cmd/server

# ---- 3. Run it ------------------------------------------------------------
#
# distroless: no shell, no package manager, nothing to exploit that is not the
# binary itself. Nothing here makes outbound TLS calls, so no CA bundle is
# needed.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/telemetry /telemetry
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/telemetry"]

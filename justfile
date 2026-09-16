# Live Telemetry Viewer
# Every development action goes through this file. Keeping the set of commands
# small, committed and reviewable is the first layer of isolation.

set windows-shell := ["sh", "-cu"]

# List available recipes.
default:
    @just --list

# `npm ci` installs exactly what package-lock.json pins and fails if the lockfile
# is stale. `--ignore-scripts` blocks lifecycle hooks (postinstall and friends),
# which is the main way a transitive dependency executes code on your machine.
# Verified safe here: esbuild ships its platform binary as an optionalDependency,
# so Vite works without running install.js.

# Install web dependencies reproducibly, without running package scripts.
install:
    cd web && npm ci --ignore-scripts

# Regenerate Go and TypeScript from proto/. Needs web/node_modules for the TS plugin.
gen:
    @test -d web/node_modules || just install
    buf generate

# Run the Go API server on :8080.
server:
    cd server && go run ./cmd/server

# Run the Vite dev server on :5173.
web:
    cd web && npm run dev

# Run all tests.
test:
    cd server && go test ./...
    cd web && npm run test

# Lint protos and Go, and typecheck the web app.
lint:
    buf lint
    cd server && go vet ./...
    cd web && npm run typecheck

# Format protos and Go.
fmt:
    buf format -w
    cd server && go fmt ./...

# Verify generated code matches the protos. Fails if `just gen` was not re-run.
gen-check: gen
    @git diff --exit-code -- server/gen web/src/gen \
      || (echo "generated code is stale — commit the result of 'just gen'" && exit 1)

# Run Go tests with coverage and print the total.
cover:
    cd server && go test ./... -coverprofile=coverage.out -covermode=atomic
    cd server && go tool cover -func=coverage.out | tail -1

# Open the Go coverage report in a browser.
cover-html: cover
    cd server && go tool cover -html=coverage.out

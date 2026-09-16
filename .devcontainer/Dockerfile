# Dev container for the live telemetry viewer.
#
# Holds the whole toolchain — Go, Node, buf, just — so `npm install` lifecycle
# scripts and Go build steps run inside a container rather than on the host.
# Only the repository is mounted, so a hostile dependency sees this checkout and
# nothing else on the machine.

# Pull Node from its official image instead of piping an install script into a
# shell. Copying the binary is verifiable; `curl ... | bash` is not.
FROM node:24-bookworm-slim AS node

FROM golang:1.26-bookworm

ARG JUST_VERSION=1.58.0
ARG JUST_SHA256=4a5cc2f53e6f0f8c59092a6cc38291eb729d46a7dd95d3ae582008881b84931d
ARG BUF_VERSION=v1.73.0

# --- Node ---------------------------------------------------------------
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

# --- just ---------------------------------------------------------------
# Downloaded by exact version and verified against a checksum recorded above,
# so a tampered or swapped artifact fails the build instead of executing.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates git; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSLO "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    echo "${JUST_SHA256}  just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz" | sha256sum -c -; \
    tar -xzf "just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz" -C /usr/local/bin just; \
    rm "just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    just --version

# --- buf ----------------------------------------------------------------
# buf is written in Go, so `go install` at a pinned version needs no extra trust
# beyond the Go module proxy this image already relies on.
RUN go install github.com/bufbuild/buf/cmd/buf@${BUF_VERSION} \
 && buf --version

# The codegen plugins are NOT installed here: server/go.mod pins them with `tool`
# directives, and `just gen` invokes them through `go tool`.

WORKDIR /workspaces/telemetry

# Go toolchain layer for the containerized instrumentation agent (realworld-go).
# Builds on the shared base (docker/agent-base.Dockerfile → harness-agent-base), which already provides
# the Node runtime, weaver, baked harness code, Node deps, and gcc/build-essential. Build the base first:
#   docker build -f docker/agent-base.Dockerfile -t harness-agent-base .
#   docker build -f docker/agent-go.Dockerfile   -t harness-agent-go   .
FROM harness-agent-base

# Go toolchain. realworld-go pins `go 1.25.0` in go.mod; install a current 1.25.x. arm64 to match the
# host + Docker Desktop (Apple Silicon). Override at build time with --build-arg GO_VERSION=1.25.x.
ARG GO_VERSION=1.25.11
RUN set -eux; \
  curl -fL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz"; \
  tar -C /usr/local -xzf /tmp/go.tar.gz; \
  rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# realworld-go's SQLite driver is github.com/mattn/go-sqlite3 (cgo), so the in-container `go build`
# needs cgo on. gcc comes from build-essential in the base image.
ENV CGO_ENABLED=1

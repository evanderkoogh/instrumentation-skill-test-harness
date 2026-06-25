# Shared BASE image for the containerized instrumentation agent (HARNESS_CONTAINERIZE=1).
#
# Why containerize: on the host the agent shares the process table / port space / /tmp with the
# harness's own weaver+collector and any concurrent --parallel runs, so it burns turns on
# `ps`/`lsof`/`kill` disambiguation. Inside a container it has its own PID + network namespace, so the
# portable skill's generic process/port commands only ever see the agent's own world.
#
# This base holds only what's common AND slow-changing across every language image: the Node runtime
# that drives the Agent SDK, the Linux weaver + otelcol the agent/lifecycle use, and the harness's Node
# deps (npm ci). It deliberately does NOT bake the harness SOURCE — each per-language image
# (docker/agent-<lang>.Dockerfile) copies that as its LAST layers, AFTER the toolchain install. Keeping
# the volatile source out of the shared base means a harness-code edit busts only the cheap COPY layers
# in each language image, never the toolchain downloads (Go tarball, JDK/Maven, uv) — those stay cached.
#
# The language images therefore bake the FULL harness code at /harness (paths resolve as on the host:
# harnessRoot=/harness, repoDir=/harness/checkouts/<app>, pluginRoot=/harness/agent-skill/honeycomb) —
# including the eval "answer key" (src/evaluation.ts, weaver.ts, envvars.ts, EVALUATION.md, apps/) and
# the orchestration scripts, needed by harness-mode entrypoints. The agent step (run-agent.ts) runs with
# src/sandbox.ts ON, whose default-deny whitelist denies every /harness path outside the checkout +
# otel/ — so the answer key is present-but-unreadable to the agent, exactly the posture of a host run.
# At runtime the checkout, tmp/, and the skill tree are bind-mounted in.
#
# Build order (rebuild base first whenever harness code or deps change, then the language images):
#   docker build -f docker/agent-base.Dockerfile   -t harness-agent-base   .
#   docker build -f docker/agent-<lang>.Dockerfile -t harness-agent-<lang> .
FROM node:22-bookworm-slim

# Toolchain common to all languages: git + curl/xz for fetching weaver, build-essential for native
# builds (Python wheels that compile, Go cgo, etc.). lsof is required by the in-container lifecycle:
# apps' cmd_start and traffic.sh probe ports with `lsof` (port_in_use), and the lifecycle waits on the
# collector the same way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git xz-utils build-essential lsof \
  && rm -rf /var/lib/apt/lists/*

# Linux weaver — the agent runs `weaver registry live-check` to self-verify. The host's otel/weaver is
# a macOS binary and is NOT mounted; fetch the matching Linux build. Tracks `latest` like the host's
# download-tools step (harness.sh). Use the statically-linked MUSL build: the gnu build requires
# GLIBC_2.39, newer than this base image ships, whereas musl has no libc dependency.
# NOTE: aarch64 — host + Docker Desktop are arm64 (Apple Silicon).
RUN set -eux; \
  asset="weaver-aarch64-unknown-linux-musl.tar.xz"; \
  curl -fL -o "/tmp/$asset" "https://github.com/open-telemetry/weaver/releases/latest/download/$asset"; \
  mkdir -p /opt/weaver; \
  tar -xJf "/tmp/$asset" -C /tmp; \
  found="$(find /tmp -type f -name weaver | head -1)"; \
  mv "$found" /opt/weaver/weaver; \
  chmod +x /opt/weaver/weaver; \
  rm -rf "/tmp/$asset"
ENV PATH="/opt/weaver:${PATH}"

# Linux otelcol-contrib — the per-run fan-out collector the in-container lifecycle (docker/lifecycle.sh)
# launches: app -> collector -> {Honeycomb, weaver}. The host otel/otelcol-contrib is a macOS binary and
# isn't mounted, so fetch the Linux build here (mirrors harness.sh download-tools: resolve the latest tag,
# download otelcol-contrib_<ver>_linux_<arch>.tar.gz). aarch64 — host + Docker Desktop are arm64.
RUN set -eux; \
  arch="arm64"; \
  ver="$(curl -fsSL https://api.github.com/repos/open-telemetry/opentelemetry-collector-releases/releases/latest \
        | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"; \
  asset="otelcol-contrib_${ver}_linux_${arch}.tar.gz"; \
  curl -fL -o "/tmp/$asset" \
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${ver}/${asset}"; \
  tar -xzf "/tmp/$asset" -C /tmp; \
  mv /tmp/otelcol-contrib /usr/local/bin/otelcol-contrib; \
  chmod +x /usr/local/bin/otelcol-contrib; \
  rm -rf "/tmp/$asset"

WORKDIR /harness

# Node deps first (cached unless the lockfile changes). package-lock.json is present in the repo.
COPY package.json package-lock.json ./
RUN npm ci

# NOTE: the harness SOURCE is intentionally NOT copied here — each agent-<lang> image copies it as its
# final layers, after the toolchain, so a code edit doesn't invalidate the toolchain cache. The
# ENTRYPOINT below resolves against that per-language copy at runtime (base is never run directly).

# Run as an arbitrary non-root uid at runtime (`docker run --user`) so files written into the
# bind-mounted checkout stay host-owned. node_modules/.bin/tsx is world-readable from `npm ci`.
ENTRYPOINT ["node_modules/.bin/tsx", "src/run-agent.ts"]

# Shared BASE image for the containerized instrumentation agent (HARNESS_CONTAINERIZE=1).
#
# Why containerize: on the host the agent shares the process table / port space / /tmp with the
# harness's own weaver+collector and any concurrent --parallel runs, so it burns turns on
# `ps`/`lsof`/`kill` disambiguation. Inside a container it has its own PID + network namespace, so the
# portable skill's generic process/port commands only ever see the agent's own world.
#
# This base holds everything common to every language image: the Node runtime that drives the Agent
# SDK, the Linux weaver the agent self-verifies with, the harness's Node deps, and the harness CODE
# baked at /harness so paths resolve exactly as on the host (harnessRoot=/harness,
# repoDir=/harness/checkouts/<app>, pluginRoot=/harness/agent-skill/honeycomb) — letting
# src/instrumentation.ts and src/sandbox.ts run unchanged. Per-language images (docker/agent-<lang>.
# Dockerfile) are `FROM harness-agent-base` and add ONLY that language's toolchain.
#
# At runtime the checkout, tmp/, and the skill tree are bind-mounted in; the eval "answer key"
# (src/evaluation.ts, weaver.ts, envvars.ts, EVALUATION.md, apps/) is never copied (see .dockerignore),
# so it is physically absent.
#
# Build order (rebuild base first whenever harness code or deps change, then the language images):
#   docker build -f docker/agent-base.Dockerfile   -t harness-agent-base   .
#   docker build -f docker/agent-<lang>.Dockerfile -t harness-agent-<lang> .
FROM node:22-bookworm-slim

# Toolchain common to all languages: git + curl/xz for fetching weaver, build-essential for native
# builds (Python wheels that compile, Go cgo, etc.).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git xz-utils build-essential \
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

WORKDIR /harness

# Node deps first (cached unless the lockfile changes). package-lock.json is present in the repo.
COPY package.json package-lock.json ./
RUN npm ci

# tsconfig + the agent-runtime source only. .dockerignore drops the eval answer-key files from src/,
# so they are absent from the image entirely; everything the agent needs (run-agent → instrumentation
# → sandbox/pricing) is import-reachable without them.
COPY tsconfig.json ./
COPY src/ ./src/

# Run as an arbitrary non-root uid at runtime (`docker run --user`) so files written into the
# bind-mounted checkout stay host-owned. node_modules/.bin/tsx is world-readable from `npm ci`.
ENTRYPOINT ["node_modules/.bin/tsx", "src/run-agent.ts"]

# Python toolchain layer for the containerized instrumentation agent (beaverhabits).
# Builds on the shared base (docker/agent-base.Dockerfile → harness-agent-base), which already provides
# the Node runtime, weaver, baked harness code, and Node deps. Build the base first:
#   docker build -f docker/agent-base.Dockerfile   -t harness-agent-base   .
#   docker build -f docker/agent-python.Dockerfile -t harness-agent-python .
FROM harness-agent-base

# uv (Python package/_interpreter_ manager) — beaverhabits builds/runs with `uv sync` / `uv run`.
# uv fetches its own managed Python, so we don't install a system Python. (build-essential for any
# wheels that compile comes from the base image.)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Harness source LAST — after the toolchain above — so a harness-code edit re-runs only these cheap
# COPY layers and leaves the toolchain cached. Baked at /harness (paths resolve as on the host:
# harnessRoot=/harness, repoDir=/harness/checkouts/<app>, pluginRoot=/harness/agent-skill/honeycomb).
# Includes the eval "answer key" (src/evaluation.ts, weaver.ts, envvars.ts, EVALUATION.md, apps/),
# denied to the agent step by src/sandbox.ts. (.env stays out via .dockerignore; secrets by name.)
WORKDIR /harness
COPY tsconfig.json ./
COPY src/ ./src/
COPY apps/ ./apps/
COPY EVALUATION.md harness.sh ports.sh collector.run.template.yaml ./
COPY docker/lifecycle.sh ./lifecycle.sh

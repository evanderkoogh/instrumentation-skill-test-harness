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

# BeaverHabits — app profile for the OTel skill test harness.
# Sourced by harness.sh; defines APP_* variables and cmd_* overrides.

APP_NAME="beaverhabits"
APP_REPO="https://github.com/daya0576/beaverhabits.git"
APP_CLEAN_SHA="a4e860e6a66ed8482a8b51829cfb87be69ad0baa"
APP_HTTP_PORT="$BEAVERHABITS_HTTP_PORT"  # from the central registry (ports.sh)
APP_OTEL_AGENT_TYPE="python"
APP_DATASET="beaverhabits"
# How to start the app for LOCAL verification (surfaced to the agent via the prompt).
APP_START_HINT="from the repo root: HABITS_STORAGE=USER_DISK NICEGUI_STORAGE_SECRET=test TRUSTED_LOCAL_EMAIL=test@example.com uv run uvicorn beaverhabits.main:app --port $APP_HTTP_PORT --host 0.0.0.0"

cmd_build() {
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "Repo not found. Run 'download' first." >&2
    exit 1
  fi
  export PATH="$HOME/.local/bin:$PATH"

  # uv console scripts (e.g. .venv/bin/uvicorn) hardcode the venv's absolute
  # python path in their shebang. If the checkout dir was moved or renamed
  # (e.g. scratch_dir -> code), those shebangs point at a path that no longer
  # exists and `uv sync` will happily reuse the venv, so `start` later dies with
  # "bad interpreter". (.venv/bin/python itself is a symlink to the uv-managed
  # interpreter and keeps resolving, so it can't be used to detect this.)
  # Detect a stale console-script shebang and recreate the venv from scratch.
  if [[ -f "$REPO_DIR/.venv/bin/uvicorn" ]]; then
    shebang_py="$(sed -n '1s/^#!//p' "$REPO_DIR/.venv/bin/uvicorn")"
    if [[ -n "$shebang_py" && ! -x "$shebang_py" ]]; then
      echo "Stale .venv detected (console-script interpreter '$shebang_py' missing) — recreating..."
      rm -rf "$REPO_DIR/.venv"
    fi
  fi

  echo "Installing dependencies with uv..."
  (cd "$REPO_DIR" && uv sync)
  echo "Build complete."
}

cmd_start() {
  mkdir -p "$LOG_DIR"

  if [[ -f "$PID_FILE" ]]; then
    echo "PID file exists — server may already be running. Run 'status' to check." >&2
    exit 1
  fi

  if port_in_use "$APP_HTTP_PORT"; then
    echo "Port $APP_HTTP_PORT is already in use." >&2
    exit 1
  fi

  # Fail fast: async SQLAlchemy engine passed without .sync_engine crashes at startup.
  if grep -r "SQLAlchemyInstrumentor" "$REPO_DIR" --include="*.py" -l 2>/dev/null | \
     xargs grep -l "instrument.*engine=" 2>/dev/null | \
     xargs grep -v "sync_engine" 2>/dev/null | \
     grep -q "instrument.*engine="; then
    echo "ERROR: SQLAlchemyInstrumentor called with async engine (missing .sync_engine)." >&2
    echo "Fix: change engine=X to engine=X.sync_engine in telemetry.py." >&2
    exit 1
  fi

  # NOTE: service.name is intentionally NOT set here. The instrumentation skill must
  # hardcode service.name in the application's OTel Resource so spans land in the
  # "$APP_DATASET" dataset. The evaluation verifies this (service_name criterion).
  local otel_resource_attrs=""
  if [[ -f "$REPO_DIR/.skill-version" ]]; then
    # shellcheck disable=SC1090
    source "$REPO_DIR/.skill-version"
    otel_resource_attrs="service.instrumentation_skill.branch=${SKILL_BRANCH},service.instrumentation_skill.git_sha=${SKILL_SHA},service.instrumentation_skill.commit=${SKILL_COMMIT_MSG}"
  fi

  echo "Starting beaverhabits on port $APP_HTTP_PORT..."
  (
    export PATH="$HOME/.local/bin:$PATH"
    cd "$REPO_DIR"
    HABITS_STORAGE=USER_DISK \
    NICEGUI_STORAGE_SECRET=test-secret \
    TRUSTED_LOCAL_EMAIL=test@example.com \
    OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-https://api.honeycomb.io}" \
    OTEL_EXPORTER_OTLP_HEADERS="${OTEL_EXPORTER_OTLP_HEADERS:-}" \
    OTEL_RESOURCE_ATTRIBUTES="$otel_resource_attrs" \
    uv run uvicorn beaverhabits.main:app --workers 1 --port "$APP_HTTP_PORT" --host 0.0.0.0
  ) > "$LOG_DIR/beaverhabits.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  echo "Waiting for server to boot..."
  until grep -q "Application startup complete" "$LOG_DIR/beaverhabits.log" 2>/dev/null; do
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Server process died. Check $LOG_DIR/beaverhabits.log" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  done

  echo ""
  echo "Server is up:"
  echo "  BeaverHabits -> http://localhost:$APP_HTTP_PORT"
  echo "  Demo (no auth) -> http://localhost:$APP_HTTP_PORT/demo"
  echo ""
  echo "Logs: $LOG_DIR/beaverhabits.log"
  echo "Stop with: ./harness.sh beaverhabits stop"
}

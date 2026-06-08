# BeaverHabits — app profile for the OTel skill test harness.
# Sourced by harness.sh; defines APP_* variables and cmd_* overrides.

APP_NAME="beaverhabits"
APP_REPO="https://github.com/evanderkoogh/beaverhabits.git"
APP_CLEAN_BRANCH="clean"
APP_HTTP_PORT=9001
APP_OTEL_AGENT_TYPE="python"
APP_DATASET="beaverhabits"

cmd_build() {
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "Repo not found. Run 'download' first." >&2
    exit 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
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
    OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-beaverhabits}" \
    OTEL_RESOURCE_ATTRIBUTES="$otel_resource_attrs" \
    uv run uvicorn beaverhabits.main:app --workers 1 --port 9001 --host 0.0.0.0
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

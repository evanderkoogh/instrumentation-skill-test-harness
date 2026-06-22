# RealWorld "Conduit" backend (Go) — app profile for the OTel skill test harness.
# A Medium-clone REST API built with Gin + GORM + SQLite + JWT.
# Sourced by harness.sh; defines APP_* variables and cmd_* overrides.

APP_NAME="realworld-go"
APP_REPO="https://github.com/gothinkster/golang-gin-realworld-example-app.git"
APP_CLEAN_SHA="626c372d259472148d93303f74aa9b9a1cdcef24"
APP_CLEAN_BRANCH="main"
# 8090 (not 8080) so this can run concurrently with broadleaf, whose site HTTP
# connector binds 8080. The traffic script and cmd_start both honor APP_HTTP_PORT.
APP_HTTP_PORT="$REALWORLDGO_HTTP_PORT"  # from the central registry (ports.sh)
APP_OTEL_AGENT_TYPE="go"   # SDK-based; no external agent binary (see harness_download_agent)
APP_DATASET="realworld-go"

BINARY_NAME="conduit"
# How to start the app for LOCAL verification (surfaced to the agent via the prompt).
APP_START_HINT="from the repo root: build with 'go build -o $BINARY_NAME .', then run 'PORT=$APP_HTTP_PORT ./$BINARY_NAME'"

cmd_build() {
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "Repo not found. Run 'download' first." >&2
    exit 1
  fi
  echo "Building (go build ./...)..."
  ( cd "$REPO_DIR" && go build ./... )
  echo "Build complete."
}

cmd_start() {
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "Repo not found. Run 'download' first." >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR"

  if [[ -f "$PID_FILE" ]]; then
    echo "PID file exists — server may already be running. Run 'status' to check." >&2
    exit 1
  fi

  if port_in_use "$APP_HTTP_PORT"; then
    echo "Port $APP_HTTP_PORT is already in use." >&2
    exit 1
  fi

  # The skill applies instrumentation as code changes, and run.ts builds BEFORE
  # instrumenting — so (re)build from source here to capture those changes.
  echo "Compiling $BINARY_NAME from source..."
  ( cd "$REPO_DIR" && go build -o "$BINARY_NAME" . )

  # SQLite lives under ./data/gorm.db (GORM auto-migrates on boot); ensure the dir exists.
  mkdir -p "$REPO_DIR/data"

  # Harness-tracking attributes (harness.run_id, service.instrumentation_skill.*) are NOT
  # set on the app — the fan-out collector stamps them onto the Honeycomb-bound copy only,
  # keeping the weaver pipeline's view of the telemetry clean (see collector.template.yaml).
  # NOTE: service.name is intentionally NOT set here. The instrumentation skill is
  # responsible for hardcoding service.name in the application's OTel Resource so that
  # spans land in the "$APP_DATASET" dataset. The evaluation verifies this (service_name
  # criterion). OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS are sourced
  # from .env by harness.sh.

  echo "Starting $APP_NAME on port $APP_HTTP_PORT..."
  ( cd "$REPO_DIR" && PORT="$APP_HTTP_PORT" "./$BINARY_NAME" ) > "$LOG_DIR/app.log" 2>&1 &
  local app_pid=$!
  echo "$app_pid" > "$PID_FILE"

  echo "Waiting for the server to accept requests..."
  local waited=0
  until curl -fsS "http://localhost:$APP_HTTP_PORT/api/ping/" > /dev/null 2>&1; do
    sleep 1
    if ! kill -0 "$app_pid" 2>/dev/null; then
      echo "App process died. Check $LOG_DIR/app.log" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
    (( ++waited ))
    if (( waited >= 60 )); then
      echo "Server did not become ready within 60s. Check $LOG_DIR/app.log" >&2
      exit 1
    fi
  done

  echo ""
  echo "Server is up:"
  echo "  API -> http://localhost:$APP_HTTP_PORT/api"
  echo ""
  echo "Logs: $LOG_DIR/app.log"
  echo "Stop with: ./harness.sh $APP_NAME stop"
}

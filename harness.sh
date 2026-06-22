#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$SCRIPT_DIR/apps"
CHECKOUTS_DIR="$SCRIPT_DIR/checkouts"

usage() {
  echo "Usage: $(basename "$0") <app> {download|download-agent|download-tools|build|bootstrap|start|stop|restart|status|reset [--purge]|clean|traffic|instrument|ports}"
  echo ""
  echo "  <app>            App profile name (directory under apps/)"
  echo ""
  echo "  download         Clone the app repo (skips if already present)"
  echo "  download-agent   Download or install the OTel agent for this app type"
  echo "  download-tools   Download weaver + otelcol-contrib binaries into otel/"
  echo "  build            Build the application"
  echo "  bootstrap        Run one-time setup (e.g. seed database)"
  echo "  start            Start the application in the background"
  echo "  stop             Stop running servers"
  echo "  restart          Stop, clean, then start"
  echo "  status           Show whether servers are running"
  echo "  reset [--purge]  Check out clean branch and create a new scratch branch"
  echo "  clean            Remove logs/ and .playwright-mcp/"
  echo "  traffic          Generate representative traffic against the running app"
  echo "  instrument       Write tmp/.instrument-prompt.<app>.md for clean-context instrumentation"
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

APP="$1"
COMMAND="$2"
shift 2

APP_DIR="$APPS_DIR/$APP"
REPO_DIR="$CHECKOUTS_DIR/$APP"
# All generated, run-scoped scratch files live under tmp/ (gitignored) rather than
# the repo root. App-scoped so multiple apps can run concurrently without clobbering.
TMP_DIR="$SCRIPT_DIR/tmp"
mkdir -p "$TMP_DIR"
LOG_DIR="$SCRIPT_DIR/logs/$APP"
PID_FILE="$TMP_DIR/.harness.$APP.pids"
# Per-run weaver-capture pipeline (see start_collector / stop_collector). All
# app-scoped so concurrent runs get isolated ports, configs, and report files.
COLLECTOR_PID_FILE="$TMP_DIR/.harness.$APP.collector.pid"
COLLECTOR_CONFIG="$TMP_DIR/.harness.$APP.collector.yaml"
WEAVER_PID_FILE="$TMP_DIR/.harness.$APP.weaver.pid"
WEAVER_STATE_FILE="$TMP_DIR/.harness.$APP.weaver.json"
WEAVER_REPORT_DIR="$LOG_DIR/weaver-report"
# Enabled by default; set HARNESS_WEAVER_CAPTURE=0 to export straight to Honeycomb.
HARNESS_WEAVER_CAPTURE="${HARNESS_WEAVER_CAPTURE:-1}"

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# Load the central port registry (defines per-app port vars, app_ports(), ports_check()).
# config.sh files reference these vars so all ports live in one place; run `./harness.sh
# <anyapp> ports` to verify there are no collisions.
if [[ -f "$SCRIPT_DIR/ports.sh" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/ports.sh"
fi

# Load app config (defines APP_* variables and optional cmd_* function overrides)
if [[ ! -f "$APP_DIR/config.sh" ]]; then
  echo "App '$APP' not found. Expected config at: $APP_DIR/config.sh" >&2
  echo "Available apps: $(ls "$APPS_DIR" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$APP_DIR/config.sh"

# --- Shared helpers ---

port_in_use() {
  lsof -ti tcp:"$1" > /dev/null 2>&1
}

# Kill anything bound to the given ports — leftovers from a prior run or from an agent's
# own verification (which now starts the app). Safe to call before `start` because ports.sh
# keeps each app's ports disjoint from every other app's, so we only ever kill our own.
clear_ports() {
  local p pids
  for p in "$@"; do
    pids=$(lsof -ti tcp:"$p" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "Clearing port $p (killing PIDs: $(echo "$pids" | tr '\n' ' '))"
      kill $pids 2>/dev/null || true
      sleep 1
      pids=$(lsof -ti tcp:"$p" 2>/dev/null || true)
      [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
    fi
  done
}

# `ports` command — print the registry map and verify no collisions.
harness_ports() {
  if declare -f ports_check > /dev/null 2>&1; then
    ports_check
  else
    echo "ports.sh not loaded — no registry available." >&2
    exit 1
  fi
}

# Pick a currently-unused TCP port in the ephemeral-ish range. Randomized start so
# concurrent runs are unlikely to collide; the collector logs a bind error (caught
# downstream) in the rare race.
free_port() {
  local p tries=0
  while (( tries < 200 )); do
    p=$(( 20000 + RANDOM % 20000 ))
    if ! port_in_use "$p"; then echo "$p"; return 0; fi
    (( tries++ ))
  done
  echo "free_port: no free port found" >&2
  return 1
}

# Locate the weaver registry the skill created somewhere in the checkout. A weaver
# registry is a directory containing a manifest — modern `manifest.yaml` or the legacy
# `registry_manifest.yaml`. Prints the registry directory, or nothing if none is found.
find_registry() {
  local manifest
  manifest=$(find "$REPO_DIR" \( -name manifest.yaml -o -name registry_manifest.yaml \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1)
  [[ -n "$manifest" ]] && dirname "$manifest"
}

make_scratch_branch() {
  local base="scratch_$(date +%Y-%m-%d)"
  local branch="$base"
  local index=1
  while git -C "$REPO_DIR" rev-parse --verify "$branch" &>/dev/null; do
    branch="${base}-${index}"
    (( index++ ))
  done
  echo "$branch"
}

# Bring up the per-run weaver-capture pipeline:
#
#   app --OTLP--> otelcol-contrib --+--otlphttp--> Honeycomb  (existing query eval)
#                                   +--otlp------> weaver registry live-check (OTLP receiver)
#
# weaver scores the live telemetry against the registry the skill created. The report is
# finalized + read by src/weaver.ts (it POSTs the weaver admin /stop endpoint, then reads
# live_check.json). Dynamically-allocated ports + app-scoped config/pid/state/report keep
# concurrent runs isolated. On any problem we warn and fall back to direct-to-Honeycomb
# export rather than aborting the run.
start_collector() {
  [[ "$HARNESS_WEAVER_CAPTURE" == "1" ]] || return 0
  local col_bin="$SCRIPT_DIR/otel/otelcol-contrib"
  local weaver_bin="$SCRIPT_DIR/otel/weaver"
  local template="$SCRIPT_DIR/collector.template.yaml"
  if [[ ! -x "$col_bin" || ! -x "$weaver_bin" || ! -f "$template" ]]; then
    echo "weaver-capture tooling unavailable (run 'download-tools') — exporting straight to Honeycomb." >&2
    return 0
  fi

  # Real Honeycomb destination, captured BEFORE we override the app's env below.
  local hc_endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT:-https://api.honeycomb.io}"
  local hc_key=""
  if [[ -n "${OTEL_EXPORTER_OTLP_HEADERS:-}" ]]; then
    hc_key=$(printf '%s' "$OTEL_EXPORTER_OTLP_HEADERS" | sed -E 's/.*x-honeycomb-team=([^,]+).*/\1/')
  fi

  local weaver_grpc weaver_admin col_grpc col_http
  weaver_grpc=$(free_port); weaver_admin=$(free_port)
  col_grpc=$(free_port);    col_http=$(free_port)

  mkdir -p "$LOG_DIR"
  rm -rf "$WEAVER_REPORT_DIR"; mkdir -p "$WEAVER_REPORT_DIR"

  # Prefer the registry the skill created in the checkout (auto-discovered); else weaver's
  # upstream semconv default.
  local registry_dir registry_arg=() registry_used="upstream-semconv"
  registry_dir=$(find_registry)
  if [[ -n "$registry_dir" ]]; then
    registry_arg=(--registry "$registry_dir")
    registry_used="$registry_dir"
  fi

  echo "Starting weaver live-check receiver (grpc:$weaver_grpc admin:$weaver_admin registry:$registry_used)..."
  # Long inactivity timeout: src/weaver.ts explicitly finalizes via the admin /stop endpoint.
  # NOTE: we deliberately do NOT pass --include-unreferenced. The registry the skill
  # produces is expected to be self-describing — it must `import` the upstream semconv
  # attribute groups it builds on (see the otel-instrumentation-implementation skill), so
  # standard attributes (http.*, db.*, server.*, …) resolve on their own. A registry that
  # only declares semconv as a `dependency` without importing from it will (correctly)
  # score those standard attributes as violations: that is a real portability defect in
  # the registry, not a measurement artifact, and we want the run to surface it.
  "$weaver_bin" registry live-check \
    --input-source otlp \
    --otlp-grpc-address 127.0.0.1 --otlp-grpc-port "$weaver_grpc" \
    --admin-port "$weaver_admin" \
    "${registry_arg[@]}" \
    --format json --output "$WEAVER_REPORT_DIR" \
    --inactivity-timeout 600 > "$LOG_DIR/weaver.log" 2>&1 &
  local weaver_pid=$!
  echo "$weaver_pid" > "$WEAVER_PID_FILE"

  local waited=0
  until grep -q "OTLP receiver will stop" "$LOG_DIR/weaver.log" 2>/dev/null; do
    sleep 1
    if ! kill -0 "$weaver_pid" 2>/dev/null; then
      echo "weaver failed to start — check $LOG_DIR/weaver.log. Falling back to direct export." >&2
      rm -f "$WEAVER_PID_FILE"; return 0
    fi
    (( ++waited ))
    if (( waited >= 60 )); then
      echo "weaver not ready within 60s — check $LOG_DIR/weaver.log. Falling back to direct export." >&2
      kill "$weaver_pid" 2>/dev/null || true; rm -f "$WEAVER_PID_FILE"; return 0
    fi
  done

  # Per-run id stamped onto every span by the collector (resource/honeycomb processor) so the
  # evaluation can scope its queries to this run. Provided by run.ts; fall back to an
  # app+timestamp id if invoked standalone.
  local run_id="${HARNESS_RUN_ID:-$APP-$(date +%s)}"

  # Skill-version attributes are stamped onto Honeycomb-bound telemetry by the collector
  # (not by the app), so the weaver pipeline sees clean app telemetry. Read them from the
  # .skill-version marker written at instrument time; default to "unknown" if absent.
  local skill_branch="unknown" skill_git_sha="unknown" skill_commit="unknown"
  if [[ -f "$REPO_DIR/.skill-version" ]]; then
    # shellcheck disable=SC1091
    source "$REPO_DIR/.skill-version"
    skill_branch="${SKILL_BRANCH:-unknown}"
    skill_git_sha="${SKILL_SHA:-unknown}"
    skill_commit="${SKILL_COMMIT_MSG:-unknown}"
  fi
  # Escape characters special to a sed replacement (\, &, |) — the commit message is free text.
  local esc='s/[\\&|]/\\&/g'
  skill_branch=$(printf '%s' "$skill_branch" | sed -e "$esc")
  skill_git_sha=$(printf '%s' "$skill_git_sha" | sed -e "$esc")
  skill_commit=$(printf '%s' "$skill_commit" | sed -e "$esc")

  sed \
    -e "s|%COLLECTOR_GRPC_PORT%|$col_grpc|g" \
    -e "s|%COLLECTOR_HTTP_PORT%|$col_http|g" \
    -e "s|%HONEYCOMB_ENDPOINT%|$hc_endpoint|g" \
    -e "s|%API_KEY%|$hc_key|g" \
    -e "s|%WEAVER_GRPC_ENDPOINT%|127.0.0.1:$weaver_grpc|g" \
    -e "s|%RUN_ID%|$run_id|g" \
    -e "s|%SKILL_BRANCH%|$skill_branch|g" \
    -e "s|%SKILL_GIT_SHA%|$skill_git_sha|g" \
    -e "s|%SKILL_COMMIT%|$skill_commit|g" \
    "$template" > "$COLLECTOR_CONFIG"

  echo "Starting fan-out collector (app http:$col_http -> Honeycomb + weaver)..."
  "$col_bin" --config "$COLLECTOR_CONFIG" > "$LOG_DIR/collector.log" 2>&1 &
  local col_pid=$!
  echo "$col_pid" > "$COLLECTOR_PID_FILE"

  waited=0
  until port_in_use "$col_http"; do
    sleep 1
    if ! kill -0 "$col_pid" 2>/dev/null; then
      echo "Collector failed to start — check $LOG_DIR/collector.log. Falling back to direct export." >&2
      rm -f "$COLLECTOR_PID_FILE"; kill "$weaver_pid" 2>/dev/null || true; rm -f "$WEAVER_PID_FILE"
      return 0
    fi
    (( ++waited ))
    if (( waited >= 20 )); then
      echo "Collector not ready within 20s — check $LOG_DIR/collector.log. Falling back to direct export." >&2
      return 0
    fi
  done

  # State for src/weaver.ts to finalize (POST /stop) and read the report.
  cat > "$WEAVER_STATE_FILE" <<EOF
{"adminPort": $weaver_admin, "reportFile": "$WEAVER_REPORT_DIR/live_check.json", "registry": "$registry_used"}
EOF

  # Point the app's OTLP exporter at the local collector. cmd_start launches the app in
  # a subshell that inherits this exported env; the collector forwards to the real
  # Honeycomb endpoint/key captured above.
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$col_http"
  export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
  export OTEL_EXPORTER_OTLP_HEADERS=""
  echo "App OTLP export -> $OTEL_EXPORTER_OTLP_ENDPOINT (fan-out to Honeycomb + weaver live-check)"
}

stop_collector() {
  local pid
  if [[ -f "$COLLECTOR_PID_FILE" ]]; then
    pid=$(cat "$COLLECTOR_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping fan-out collector (PID $pid)..."
      kill "$pid"
    fi
    rm -f "$COLLECTOR_PID_FILE" "$COLLECTOR_CONFIG"
  fi
  if [[ -f "$WEAVER_PID_FILE" ]]; then
    pid=$(cat "$WEAVER_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping weaver live-check (PID $pid)..."
      kill "$pid"
    fi
    rm -f "$WEAVER_PID_FILE"
  fi
  rm -f "$WEAVER_STATE_FILE"
}

# --- Generic implementations (harness_*) ---
# Apps override these by defining cmd_<name>() in their config.sh.

harness_download() {
  if [[ -d "$REPO_DIR/.git" ]]; then
    echo "Repo already cloned at $REPO_DIR — skipping."
    return
  fi
  if [[ -n "${APP_CLEAN_SHA:-}" ]]; then
    echo "Cloning $APP_REPO..."
    git clone "$APP_REPO" "$REPO_DIR"
    echo "Checking out $APP_CLEAN_SHA..."
    git -C "$REPO_DIR" checkout "$APP_CLEAN_SHA"
  else
    local branch="${APP_CLEAN_BRANCH:-main}"
    echo "Cloning $APP_REPO (branch: $branch)..."
    git clone --branch "$branch" "$APP_REPO" "$REPO_DIR"
  fi
  if declare -f cmd_setup > /dev/null 2>&1; then
    echo "Running app setup..."
    cmd_setup
  fi
  local scratch_branch
  scratch_branch="$(make_scratch_branch)"
  echo "Switching to $scratch_branch..."
  git -C "$REPO_DIR" checkout -b "$scratch_branch"
  echo "Done. Working branch: $scratch_branch"
}

harness_download_agent() {
  case "${APP_OTEL_AGENT_TYPE:-none}" in
    java)
      local agent_jar="$SCRIPT_DIR/otel/opentelemetry-javaagent.jar"
      if [[ -f "$agent_jar" ]]; then
        echo "Agent already present: $agent_jar ($(du -sh "$agent_jar" | cut -f1))"
        return 0
      fi
      mkdir -p "$SCRIPT_DIR/otel"
      echo "Downloading OpenTelemetry Java agent..."
      curl -L -o "$agent_jar" \
        https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
      echo "Downloaded: $(du -sh "$agent_jar" | cut -f1) -> $agent_jar"
      ;;
    python)
      echo "For Python apps, install the OTel SDK as a package dependency:"
      echo "  pip install opentelemetry-distro opentelemetry-exporter-otlp"
      ;;
    node)
      echo "For Node.js apps, install the OTel SDK as a package dependency:"
      echo "  npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node"
      ;;
    *)
      echo "No agent binary needed for $APP (APP_OTEL_AGENT_TYPE=${APP_OTEL_AGENT_TYPE:-none})."
      ;;
  esac
}

# Download the weaver + otelcol-contrib binaries into otel/ (idempotent).
# - weaver: the live-check tool the evaluation runs, and that the skill uses to
#   validate the registry it creates. Its release assets are version-less, so the
#   GitHub "latest" redirect works.
# - otelcol-contrib: the per-run collector that fans telemetry out to Honeycomb AND
#   a capture file (the core collector lacks the `file` exporter). Its asset filename
#   embeds the version, so resolve the latest tag from the API (override with
#   OTELCOL_VERSION=x.y.z to pin).
harness_download_tools() {
  mkdir -p "$SCRIPT_DIR/otel"
  local uname_s uname_m
  uname_s=$(uname -s)
  uname_m=$(uname -m)

  # --- weaver ---
  local weaver_bin="$SCRIPT_DIR/otel/weaver"
  if [[ -x "$weaver_bin" ]]; then
    echo "weaver already present: $weaver_bin"
  else
    local w_arch w_os
    case "$uname_m" in
      arm64|aarch64) w_arch="aarch64" ;;
      x86_64|amd64)  w_arch="x86_64" ;;
      *) echo "Unsupported arch for weaver: $uname_m" >&2; exit 1 ;;
    esac
    case "$uname_s" in
      Darwin) w_os="apple-darwin" ;;
      Linux)  w_os="unknown-linux-gnu" ;;
      *) echo "Unsupported OS for weaver: $uname_s" >&2; exit 1 ;;
    esac
    local w_asset="weaver-${w_arch}-${w_os}.tar.xz"
    echo "Downloading weaver ($w_asset)..."
    local tmp; tmp=$(mktemp -d)
    curl -fL -o "$tmp/$w_asset" \
      "https://github.com/open-telemetry/weaver/releases/latest/download/${w_asset}"
    tar -xJf "$tmp/$w_asset" -C "$tmp"
    local found; found=$(find "$tmp" -type f -name weaver | head -1)
    [[ -n "$found" ]] || { echo "weaver binary not found in archive" >&2; exit 1; }
    mv "$found" "$weaver_bin"
    chmod +x "$weaver_bin"
    rm -rf "$tmp"
    echo "Installed: $weaver_bin"
  fi

  # --- otelcol-contrib ---
  local col_bin="$SCRIPT_DIR/otel/otelcol-contrib"
  if [[ -x "$col_bin" ]]; then
    echo "otelcol-contrib already present: $col_bin"
  else
    local c_arch c_os
    case "$uname_m" in
      arm64|aarch64) c_arch="arm64" ;;
      x86_64|amd64)  c_arch="amd64" ;;
      *) echo "Unsupported arch for otelcol: $uname_m" >&2; exit 1 ;;
    esac
    case "$uname_s" in
      Darwin) c_os="darwin" ;;
      Linux)  c_os="linux" ;;
      *) echo "Unsupported OS for otelcol: $uname_s" >&2; exit 1 ;;
    esac
    local tmp; tmp=$(mktemp -d)
    local col_version="${OTELCOL_VERSION:-}"
    if [[ -z "$col_version" ]]; then
      echo "Resolving latest otelcol-contrib version..."
      # Fetch to a file first: piping curl into `grep -m1` closes the pipe early,
      # which trips `set -o pipefail` and aborts the script.
      curl -fsSL https://api.github.com/repos/open-telemetry/opentelemetry-collector-releases/releases/latest \
        -o "$tmp/release.json"
      col_version=$(grep -m1 '"tag_name"' "$tmp/release.json" | sed -E 's/.*"v?([^"]+)".*/\1/')
    fi
    [[ -n "$col_version" ]] || { echo "Could not resolve otelcol-contrib version" >&2; exit 1; }
    local c_asset="otelcol-contrib_${col_version}_${c_os}_${c_arch}.tar.gz"
    echo "Downloading otelcol-contrib v$col_version ($c_asset)..."
    curl -fL -o "$tmp/$c_asset" \
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${col_version}/${c_asset}"
    tar -xzf "$tmp/$c_asset" -C "$tmp"
    local found; found=$(find "$tmp" -type f -name otelcol-contrib | head -1)
    [[ -n "$found" ]] || { echo "otelcol-contrib binary not found in archive" >&2; exit 1; }
    mv "$found" "$col_bin"
    chmod +x "$col_bin"
    rm -rf "$tmp"
    echo "Installed: $col_bin (v$col_version)"
  fi
}

harness_build() {
  echo "No build command defined for '$APP'. Add cmd_build() to apps/$APP/config.sh." >&2
  exit 1
}

harness_bootstrap() {
  echo "No bootstrap step defined — skipping."
}

harness_start() {
  echo "No start command defined for '$APP'. Add cmd_start() to apps/$APP/config.sh." >&2
  exit 1
}

harness_stop() {
  # Always tear down the capture collector, even if the app PID file is gone.
  stop_collector
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No PID file found — servers may not be running."
    return
  fi
  local pids
  read -r -a pids < "$PID_FILE"
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping PID $pid..."
      kill "$pid"
    fi
  done
  for pid in "${pids[@]}"; do
    local waited=0
    while kill -0 "$pid" 2>/dev/null; do
      sleep 1
      (( ++waited ))
      if (( waited >= 30 )); then
        echo "PID $pid did not stop within 30s — sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
        break
      fi
    done
  done
  rm -f "$PID_FILE"
  echo "Servers stopped."
}

harness_restart() {
  dispatch stop
  harness_clean
  dispatch start
}

harness_status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "Servers are not running (no PID file)."
    return
  fi
  local pids
  read -r -a pids < "$PID_FILE"
  for pid in "${pids[@]}"; do
    echo "PID $pid: $(kill -0 "$pid" 2>/dev/null && echo running || echo dead)"
  done
}

harness_reset() {
  local purge=false
  if [[ "${1:-}" == "--purge" ]]; then
    purge=true
  fi
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    echo "Repo not found. Run '$0 $APP download' first." >&2
    exit 1
  fi
  local current_branch
  current_branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"

  if [[ -n "${APP_CLEAN_SHA:-}" ]]; then
    # SHA mode: detach to the pinned commit, no branch tracking required
    if $purge; then
      if [[ "$current_branch" != scratch_* ]]; then
        echo "Cannot purge: not on a scratch branch (current: $current_branch)." >&2
        exit 1
      fi
      echo "Switching to $APP_CLEAN_SHA before purge..."
      git -C "$REPO_DIR" checkout "$APP_CLEAN_SHA"
      git -C "$REPO_DIR" restore .
      git -C "$REPO_DIR" clean -fd
      find "$REPO_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
      echo "Deleting local branch '$current_branch'..."
      git -C "$REPO_DIR" branch -D "$current_branch"
      if git -C "$REPO_DIR" ls-remote --exit-code origin "$current_branch" &>/dev/null; then
        echo "Deleting remote branch '$current_branch'..."
        git -C "$REPO_DIR" push origin --delete "$current_branch"
      else
        echo "No remote branch '$current_branch' to delete."
      fi
    else
      git -C "$REPO_DIR" checkout "$APP_CLEAN_SHA"
      git -C "$REPO_DIR" restore .
      git -C "$REPO_DIR" clean -fd
      find "$REPO_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
    fi
  else
    # Branch mode (legacy: fork with a named clean branch)
    local clean_branch="${APP_CLEAN_BRANCH:-main}"
    if $purge; then
      if [[ "$current_branch" == "$clean_branch" ]]; then
        echo "Cannot purge the '$clean_branch' branch." >&2
        exit 1
      fi
      echo "Switching to $clean_branch before purge..."
      git -C "$REPO_DIR" checkout "$clean_branch"
      git -C "$REPO_DIR" restore .
      git -C "$REPO_DIR" clean -fd
      find "$REPO_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
      echo "Deleting local branch '$current_branch'..."
      git -C "$REPO_DIR" branch -D "$current_branch"
      if git -C "$REPO_DIR" ls-remote --exit-code origin "$current_branch" &>/dev/null; then
        echo "Deleting remote branch '$current_branch'..."
        git -C "$REPO_DIR" push origin --delete "$current_branch"
      else
        echo "No remote branch '$current_branch' to delete."
      fi
    else
      git -C "$REPO_DIR" checkout "$clean_branch"
      git -C "$REPO_DIR" restore .
      git -C "$REPO_DIR" clean -fd
      find "$REPO_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
    fi
  fi

  if declare -f cmd_setup > /dev/null 2>&1; then
    echo "Running app setup..."
    cmd_setup
  fi
  local scratch_branch
  scratch_branch="$(make_scratch_branch)"
  echo "Creating branch '$scratch_branch'..."
  git -C "$REPO_DIR" checkout -b "$scratch_branch"
  echo "Done. Working branch: $scratch_branch"
}

harness_clean() {
  echo "Removing logs/..."
  rm -rf "$LOG_DIR"
  echo "Removing tmp/ scratch files for $APP..."
  rm -f "$TMP_DIR/.harness.$APP".* "$TMP_DIR/.instrument-prompt.$APP.md"
  echo "Removing .playwright-mcp/..."
  rm -rf "$SCRIPT_DIR/.playwright-mcp"
  echo "Clean complete."
}

harness_traffic() {
  local traffic_script="$APP_DIR/traffic.sh"
  if [[ ! -f "$traffic_script" ]]; then
    echo "No traffic script at: $traffic_script" >&2
    echo "Create apps/$APP/traffic.sh or define cmd_traffic() in config.sh." >&2
    exit 1
  fi
  # traffic.sh runs in a fresh bash; export the port vars so it can target the
  # ports this app was actually started on (config.sh sets these without export).
  export APP_HTTP_PORT="${APP_HTTP_PORT:-}"
  export APP_HTTPS_PORT="${APP_HTTPS_PORT:-}"
  bash "$traffic_script"
}

harness_instrument() {
  # The marketplace symlink points at the in-development skill repo; the extracted
  # plugin cache is a (potentially stale) published copy. Read CONTENT from the
  # marketplace path so runs exercise the same skill the version metadata is taken
  # from. Fall back to the cache only if the marketplace layout isn't present.
  local skill_git_root="$HOME/.claude/plugins/marketplaces/honeycomb-plugins"
  local claude_plugin_root="$skill_git_root/honeycomb"
  local skill_file="$claude_plugin_root/skills/otel-instrumentation/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    local plugin_base="$HOME/.claude/plugins/cache/honeycomb-plugins/honeycomb"
    local latest_version
    latest_version=$(ls "$plugin_base" 2>/dev/null | sort -V | tail -1)
    local plugin_link="$plugin_base/$latest_version"
    if [[ -L "$plugin_link" ]]; then
      claude_plugin_root=$(readlink "$plugin_link")
    else
      claude_plugin_root="$plugin_link"
    fi
    skill_file="$claude_plugin_root/skills/otel-instrumentation/SKILL.md"
  fi
  if [[ ! -f "$skill_file" ]]; then
    echo "Skill not found at: $skill_file" >&2
    exit 1
  fi

  local api_key="YOUR_API_KEY"
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    local headers_line
    headers_line=$(grep "^OTEL_EXPORTER_OTLP_HEADERS=" "$SCRIPT_DIR/.env" || true)
    if [[ -n "$headers_line" ]]; then
      api_key="${headers_line##*=}"
    fi
  fi

  local otlp_endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT:-https://api.honeycomb.io}"

  local skill_content
  skill_content=$(sed "s|\${CLAUDE_PLUGIN_ROOT}|$claude_plugin_root|g" "$skill_file")

  # skill_git_root (the marketplace symlink → dev repo) is set at the top of this
  # function; it has a .git so we can read the branch/SHA the content came from.
  local skill_branch skill_sha
  skill_branch=$(git -C "$skill_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  skill_sha=$(git -C "$skill_git_root" rev-parse --short HEAD 2>/dev/null || echo "unknown")

  # Make the representative-traffic script the agent can't otherwise see (it lives outside
  # the sandbox in apps/<app>/) available INSIDE the checkout so the agent's own verification
  # can drive the exact same traffic the harness uses, instead of inventing its own.
  local verify_traffic_rel=".harness-verify-traffic.sh"
  if [[ -f "$APP_DIR/traffic.sh" ]]; then
    cp "$APP_DIR/traffic.sh" "$REPO_DIR/$verify_traffic_rel" 2>/dev/null || true
  fi
  # Ports this app must bind (from the registry) + how to start it, surfaced to the agent so
  # its verification uses the right ports/start instead of guessing.
  local verify_ports="(none registered)"
  if declare -f app_ports > /dev/null 2>&1; then
    verify_ports="$(app_ports "$APP")"
    [[ -z "$verify_ports" ]] && verify_ports="(none registered)"
  fi
  local start_hint="${APP_START_HINT:-see the run and start scripts in the checkout}"
  # Escape characters special to a sed replacement (\, &, |) so hints can't corrupt the render.
  start_hint=$(printf '%s' "$start_hint" | sed -e 's/[\\&|]/\\&/g')

  local subst=(-e "s|%REPO_DIR%|$REPO_DIR|g" -e "s|%API_KEY%|$api_key|g" -e "s|%OTLP_ENDPOINT%|$otlp_endpoint|g" -e "s|%APP_DATASET%|${APP_DATASET:-}|g" -e "s|%VERIFY_PORTS%|$verify_ports|g" -e "s|%START_HINT%|$start_hint|g" -e "s|%TRAFFIC_SCRIPT%|$verify_traffic_rel|g")

  local app_preamble=""
  if [[ -f "$APP_DIR/instrument-preamble.md" ]]; then
    app_preamble=$(sed "${subst[@]}" "$APP_DIR/instrument-preamble.md")
  fi

  local root_preamble=""
  if [[ -f "$SCRIPT_DIR/instrument-preamble.md" ]]; then
    root_preamble=$(sed "${subst[@]}" "$SCRIPT_DIR/instrument-preamble.md")
  fi

  local preamble=""
  if [[ -n "$app_preamble" && -n "$root_preamble" ]]; then
    preamble="$app_preamble"$'\n\n'"$root_preamble"
  else
    preamble="${app_preamble}${root_preamble}"
  fi

  local skill_commit_msg
  skill_commit_msg=$(git -C "$skill_git_root" log -1 --format=%s 2>/dev/null || echo "unknown")

  # Write .skill-version so cmd_start can tag spans regardless of language
  cat > "$REPO_DIR/.skill-version" <<EOF
SKILL_BRANCH=$skill_branch
SKILL_SHA=$skill_sha
SKILL_COMMIT_MSG="$skill_commit_msg"
EOF

  local prompt_file="$TMP_DIR/.instrument-prompt.$APP.md"
  {
    if [[ -n "$preamble" ]]; then
      printf '%s\n\n---\n' "$preamble"
    fi
    printf '%s\n---\n\n' "$skill_content"
    echo "Explore the codebase at $REPO_DIR, then apply instrumentation following the skill above."
  } > "$prompt_file"

  echo "Agent prompt written to: $prompt_file"
  echo "Skill: $skill_branch @ $skill_sha (source: $claude_plugin_root)"
  echo ""
  echo "Next: spawn a clean-context Agent using the Agent tool, with the contents"
  echo "of $prompt_file as the prompt."
}

# --- Dispatcher ---

dispatch() {
  local cmd="$1"
  shift
  local func_name="${cmd//-/_}"
  # Bring up the weaver-capture collector and redirect the app's OTLP export before
  # the app starts (start_collector exports the override env this shell passes on).
  # Clear any leftover processes on this app's registered ports before any step that boots
  # the real app — `bootstrap` seeds the DB by launching it, `start` runs it for real. A
  # process leaked by a prior/failed run (or by the agent's own verification) would otherwise
  # hold a port and fail the boot (e.g. "Port 8443 was already in use"). No-op if the app
  # isn't in the registry; disjoint ports (ports.sh) guarantee we never touch a peer app
  # under --parallel.
  if [[ "$func_name" == "start" || "$func_name" == "bootstrap" ]]; then
    if declare -f app_ports > /dev/null 2>&1; then
      clear_ports $(app_ports "$APP")
    fi
  fi
  if [[ "$func_name" == "start" ]]; then
    start_collector
    # Simulate an operator opting into the stable HTTP + database semantic conventions
    # at the deployment level: export it as a real env var before the app process starts.
    # This is what a real environment would provide, so apps whose launch path the skill
    # can't edit still get the opt-in honored. (The skill is still expected to communicate
    # this to users — see the env_var_output criterion.)
    export OTEL_SEMCONV_STABILITY_OPT_IN="${OTEL_SEMCONV_STABILITY_OPT_IN:-http,database}"
  fi
  if declare -f "cmd_${func_name}" > /dev/null 2>&1; then
    "cmd_${func_name}" "$@"
  elif declare -f "harness_${func_name}" > /dev/null 2>&1; then
    "harness_${func_name}" "$@"
  else
    echo "Unknown command: $cmd" >&2
    usage
  fi
}

dispatch "$COMMAND" "$@"

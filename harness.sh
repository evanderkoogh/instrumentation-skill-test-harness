#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$SCRIPT_DIR/apps"
CHECKOUTS_DIR="$SCRIPT_DIR/checkouts"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$SCRIPT_DIR/.harness.pids"

usage() {
  echo "Usage: $(basename "$0") <app> {download|download-agent|build|bootstrap|start|stop|restart|status|reset [--purge]|clean|traffic|instrument}"
  echo ""
  echo "  <app>            App profile name (directory under apps/)"
  echo ""
  echo "  download         Clone the app repo (skips if already present)"
  echo "  download-agent   Download or install the OTel agent for this app type"
  echo "  build            Build the application"
  echo "  bootstrap        Run one-time setup (e.g. seed database)"
  echo "  start            Start the application in the background"
  echo "  stop             Stop running servers"
  echo "  restart          Stop, clean, then start"
  echo "  status           Show whether servers are running"
  echo "  reset [--purge]  Check out clean branch and create a new scratch branch"
  echo "  clean            Remove logs/ and .playwright-mcp/"
  echo "  traffic          Generate representative traffic against the running app"
  echo "  instrument       Write .instrument-prompt.md for clean-context instrumentation"
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

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
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
  bash "$traffic_script"
}

harness_instrument() {
  local plugin_base="$HOME/.claude/plugins/cache/honeycomb-plugins/honeycomb"
  local latest_version
  latest_version=$(ls "$plugin_base" | sort -V | tail -1)
  local plugin_link="$plugin_base/$latest_version"
  local claude_plugin_root
  if [[ -L "$plugin_link" ]]; then
    claude_plugin_root=$(readlink "$plugin_link")
  else
    claude_plugin_root="$plugin_link"
  fi

  local skill_file="$claude_plugin_root/skills/otel-instrumentation/SKILL.md"
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

  # The cache is an extracted copy with no .git; the marketplace symlink points to the actual repo
  local skill_git_root="$HOME/.claude/plugins/marketplaces/honeycomb-plugins"
  local skill_branch skill_sha
  skill_branch=$(git -C "$skill_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  skill_sha=$(git -C "$skill_git_root" rev-parse --short HEAD 2>/dev/null || echo "unknown")

  local subst=(-e "s|%REPO_DIR%|$REPO_DIR|g" -e "s|%API_KEY%|$api_key|g" -e "s|%OTLP_ENDPOINT%|$otlp_endpoint|g")

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

  local prompt_file="$SCRIPT_DIR/.instrument-prompt.md"
  {
    if [[ -n "$preamble" ]]; then
      printf '%s\n\n---\n' "$preamble"
    fi
    printf '%s\n---\n\n' "$skill_content"
    echo "Explore the codebase at $REPO_DIR, then apply instrumentation following the skill above."
  } > "$prompt_file"

  echo "Agent prompt written to: $prompt_file"
  echo "Skill: $skill_branch @ $skill_sha (plugin version: $latest_version)"
  echo ""
  echo "Next: spawn a clean-context Agent using the Agent tool, with the contents"
  echo "of $prompt_file as the prompt."
}

# --- Dispatcher ---

dispatch() {
  local cmd="$1"
  shift
  local func_name="${cmd//-/_}"
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

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$SCRIPT_DIR/DemoSite"
REPO_URL="https://github.com/evanderkoogh/broadleaf-demosite.git"
PID_FILE="$SCRIPT_DIR/.broadleaf.pids"
LOG_DIR="$SCRIPT_DIR/logs"
MAVEN_OPTS_VAL="-Xmx1g"

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

usage() {
  echo "Usage: $0 {download|build|bootstrap|start|stop|restart|status|reset [--purge]|clean}"
  echo ""
  echo "  download        Clone the DemoSite repo (skips if already present)"
  echo "  build           Build all modules (skips tests)"
  echo "  bootstrap       Seed the HSQLDB schema via mvn spring-boot:run (run once after build"
  echo "                   or after /tmp is cleared). Required before the first 'start'."
  echo "  start           Start site (port 8080) and admin (port 8081) in background"
  echo "  stop            Stop running servers"
  echo "  restart         Stop then start"
  echo "  status          Show whether servers are running"
  echo "  reset [--purge]  Check out 'clean' and create a new dated scratch branch."
  echo "                   With --purge, also delete the current branch locally and remotely."
  echo "  clean           Remove logs/ and .playwright-mcp/ directories"
  exit 1
}

cmd_download() {
  if [[ -d "$DEMO_DIR/.git" ]]; then
    echo "DemoSite already cloned at $DEMO_DIR — skipping."
    return
  fi
  local scratch_branch="scratch_$(date +%Y-%m-%d)"
  echo "Cloning DemoSite (branch: clean)..."
  git clone --branch clean "$REPO_URL" "$DEMO_DIR"
  echo "Switching to $scratch_branch..."
  git -C "$DEMO_DIR" checkout -b "$scratch_branch"
  echo "Done. Working branch: $scratch_branch"
}

cmd_build() {
  if [[ ! -d "$DEMO_DIR" ]]; then
    echo "DemoSite not found. Run '$0 download' first." >&2
    exit 1
  fi
  echo "Building (this takes a few minutes on first run)..."
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/pom.xml" clean install -DskipTests
  echo "Build complete."
}

port_in_use() {
  lsof -ti tcp:"$1" > /dev/null 2>&1
}

cmd_bootstrap() {
  # Broadleaf's embedded HSQLDB needs one mvn spring-boot:run pass to create the correct
  # schema (entity extension adds columns that are missed on a completely fresh database).
  # Run this once after build or after /tmp is cleared. Subsequent starts use java -cp.
  if [[ -d /tmp/broadleaf-hsqldb ]]; then
    echo "HSQLDB already seeded at /tmp/broadleaf-hsqldb — skipping bootstrap."
    echo "Delete /tmp/broadleaf-hsqldb to force a re-seed."
    return
  fi

  mkdir -p "$LOG_DIR"
  local bootstrap_log="$LOG_DIR/bootstrap.log"

  echo "Bootstrapping HSQLDB schema via mvn spring-boot:run (this takes ~60s)..."
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/site/pom.xml" spring-boot:run \
    > "$bootstrap_log" 2>&1 &
  local pid=$!

  until grep -q "Started SiteApplication" "$bootstrap_log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Bootstrap failed. Check $bootstrap_log" >&2
      exit 1
    fi
  done

  kill "$pid"
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    (( ++waited ))
    if (( waited >= 30 )); then kill -9 "$pid" 2>/dev/null || true; break; fi
  done

  echo "Bootstrap complete. HSQLDB schema seeded at /tmp/broadleaf-hsqldb."
}

cmd_start() {
  if [[ ! -f "$DEMO_DIR/site/target/site.jar" && ! -d "$DEMO_DIR/site/target/classes" ]]; then
    echo "Build artifacts not found. Run '$0 build' first." >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR"

  if [[ -f "$PID_FILE" ]]; then
    echo "PID file exists — servers may already be running. Run '$0 status' to check." >&2
    exit 1
  fi

  if port_in_use 8080; then
    echo "Port 8080 is already in use." >&2
    exit 1
  fi
  if port_in_use 8081; then
    echo "Port 8081 is already in use." >&2
    exit 1
  fi

  echo "Starting site on port 8080..."
  if [[ -x "$DEMO_DIR/start-site.sh" ]]; then
    MAVEN_OPTS="$MAVEN_OPTS_VAL" "$DEMO_DIR/start-site.sh" > "$LOG_DIR/site.log" 2>&1 &
  else
    MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/site/pom.xml" spring-boot:run \
      > "$LOG_DIR/site.log" 2>&1 &
  fi
  SITE_PID=$!

  # Wait for site to fully start (and bring up embedded Solr) before launching admin
  echo "Waiting for site to boot..."
  until grep -q "Started SiteApplication" "$LOG_DIR/site.log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$SITE_PID" 2>/dev/null; then
      echo "Site process died. Check $LOG_DIR/site.log" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  done

  echo "Starting admin on port 8081..."
  if [[ -x "$DEMO_DIR/start-admin.sh" ]]; then
    MAVEN_OPTS="$MAVEN_OPTS_VAL" "$DEMO_DIR/start-admin.sh" > "$LOG_DIR/admin.log" 2>&1 &
  else
    MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/admin/pom.xml" spring-boot:run \
      > "$LOG_DIR/admin.log" 2>&1 &
  fi
  ADMIN_PID=$!

  echo "$SITE_PID $ADMIN_PID" > "$PID_FILE"

  until grep -q "Started AdminApplication" "$LOG_DIR/admin.log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$ADMIN_PID" 2>/dev/null; then
      echo "Admin process died. Check $LOG_DIR/admin.log" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  done

  echo ""
  echo "Servers are up:"
  echo "  Store  -> http://localhost:8080"
  echo "  Admin  -> http://localhost:8081/admin  (admin / admin)"
  echo ""
  echo "Logs: $LOG_DIR/"
  echo "Stop with: $0 stop"
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No PID file found — servers may not be running."
    return
  fi

  read -r SITE_PID ADMIN_PID < "$PID_FILE"

  for PID in $SITE_PID $ADMIN_PID; do
    if kill -0 "$PID" 2>/dev/null; then
      echo "Stopping PID $PID..."
      kill "$PID"
    fi
  done

  # Wait for processes to fully exit so ports are released before returning
  for PID in $SITE_PID $ADMIN_PID; do
    local waited=0
    while kill -0 "$PID" 2>/dev/null; do
      sleep 1
      (( ++waited ))
      if (( waited >= 30 )); then
        echo "PID $PID did not stop within 30s — sending SIGKILL"
        kill -9 "$PID" 2>/dev/null || true
        break
      fi
    done
  done

  rm -f "$PID_FILE"
  echo "Servers stopped."
}

make_scratch_branch() {
  local base="scratch_$(date +%Y-%m-%d)"
  local branch="$base"
  local index=1
  while git -C "$DEMO_DIR" rev-parse --verify "$branch" &>/dev/null; do
    branch="${base}-${index}"
    (( index++ ))
  done
  echo "$branch"
}

cmd_reset() {
  local purge=false
  if [[ "${1:-}" == "--purge" ]]; then
    purge=true
  fi

  if [[ ! -d "$DEMO_DIR/.git" ]]; then
    echo "DemoSite not found. Run '$0 download' first." >&2
    exit 1
  fi

  local current_branch
  current_branch="$(git -C "$DEMO_DIR" rev-parse --abbrev-ref HEAD)"

  if $purge; then
    if [[ "$current_branch" == "clean" ]]; then
      echo "Cannot purge the 'clean' branch." >&2
      exit 1
    fi
    echo "Switching to clean before purge..."
    git -C "$DEMO_DIR" checkout clean
    echo "Deleting local branch '$current_branch'..."
    git -C "$DEMO_DIR" branch -D "$current_branch"
    if git -C "$DEMO_DIR" ls-remote --exit-code origin "$current_branch" &>/dev/null; then
      echo "Deleting remote branch '$current_branch'..."
      git -C "$DEMO_DIR" push origin --delete "$current_branch"
    else
      echo "No remote branch '$current_branch' to delete."
    fi
  else
    git -C "$DEMO_DIR" checkout clean
  fi

  local scratch_branch
  scratch_branch="$(make_scratch_branch)"
  echo "Creating branch '$scratch_branch'..."
  git -C "$DEMO_DIR" checkout -b "$scratch_branch"
  echo "Done. Working branch: $scratch_branch"
}

cmd_clean() {
  echo "Removing logs/..."
  rm -rf "$LOG_DIR"
  echo "Removing .playwright-mcp/..."
  rm -rf "$SCRIPT_DIR/.playwright-mcp"
  echo "Clean complete."
}

cmd_status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "Servers are not running (no PID file)."
    return
  fi

  read -r SITE_PID ADMIN_PID < "$PID_FILE"
  echo "Site  PID $SITE_PID: $(kill -0 "$SITE_PID" 2>/dev/null && echo running || echo dead)"
  echo "Admin PID $ADMIN_PID: $(kill -0 "$ADMIN_PID" 2>/dev/null && echo running || echo dead)"
}

case "${1:-}" in
  download)  cmd_download ;;
  build)     cmd_build ;;
  bootstrap) cmd_bootstrap ;;
  start)     cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_stop; cmd_clean; cmd_start ;;
  status)   cmd_status ;;
  reset)   cmd_reset "${2:-}" ;;
  clean)   cmd_clean ;;
  *)       usage ;;
esac

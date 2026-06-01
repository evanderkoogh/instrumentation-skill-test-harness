#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$SCRIPT_DIR/DemoSite"
REPO_URL="https://github.com/BroadleafCommerce/DemoSite.git"
PID_FILE="$SCRIPT_DIR/.broadleaf.pids"
LOG_DIR="$SCRIPT_DIR/logs"
MAVEN_OPTS_VAL="-Xmx1g"

usage() {
  echo "Usage: $0 {download|build|start|stop|restart|status}"
  echo ""
  echo "  download   Clone the DemoSite repo (skips if already present)"
  echo "  build      Build all modules (skips tests)"
  echo "  start      Start site (port 8080) and admin (port 8081) in background"
  echo "  stop       Stop running servers"
  echo "  restart    Stop then start"
  echo "  status     Show whether servers are running"
  exit 1
}

cmd_download() {
  if [[ -d "$DEMO_DIR/.git" ]]; then
    echo "DemoSite already cloned at $DEMO_DIR — skipping."
    return
  fi
  echo "Cloning DemoSite..."
  git clone "$REPO_URL" "$DEMO_DIR"
  echo "Done."
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
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/site/pom.xml" spring-boot:run \
    > "$LOG_DIR/site.log" 2>&1 &
  SITE_PID=$!

  echo "Starting admin on port 8081..."
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$DEMO_DIR/admin/pom.xml" spring-boot:run \
    > "$LOG_DIR/admin.log" 2>&1 &
  ADMIN_PID=$!

  echo "$SITE_PID $ADMIN_PID" > "$PID_FILE"

  echo "Waiting for servers to boot..."
  until grep -q "Started " "$LOG_DIR/site.log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$SITE_PID" 2>/dev/null; then
      echo "Site process died. Check $LOG_DIR/site.log" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  done

  until grep -q "Started " "$LOG_DIR/admin.log" 2>/dev/null; do
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

  rm -f "$PID_FILE"
  echo "Servers stopped."
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
  download) cmd_download ;;
  build)    cmd_build ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_stop; cmd_start ;;
  status)   cmd_status ;;
  *)        usage ;;
esac

# Broadleaf Commerce DemoSite — app profile for the OTel skill test harness.
# Sourced by harness.sh; defines APP_* variables and cmd_* overrides.

APP_NAME="broadleaf"
APP_REPO="https://github.com/BroadleafCommerce/DemoSite.git"
APP_CLEAN_SHA="8b6741b84048324fb7e618bc4b643762209ce9c3"
APP_HTTP_PORT=8080
APP_OTEL_AGENT_TYPE="java"
APP_DATASET="broadleaf-site"

MAVEN_OPTS_VAL="-Xmx1g"

cmd_setup() {
  # Copy harness baseline files into the checkout (not in upstream repo).
  cp "$APP_DIR/files/start-site.sh"  "$REPO_DIR/start-site.sh"
  cp "$APP_DIR/files/start-admin.sh" "$REPO_DIR/start-admin.sh"
  chmod +x "$REPO_DIR/start-site.sh" "$REPO_DIR/start-admin.sh"
  echo "Baseline files installed."
}

cmd_build() {
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "DemoSite not found. Run 'download' first." >&2
    exit 1
  fi
  echo "Building (this takes a few minutes on first run)..."
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$REPO_DIR/pom.xml" clean install -DskipTests
  echo "Build complete."
}

cmd_bootstrap() {
  # Broadleaf's embedded HSQLDB needs one mvn spring-boot:run pass to create the correct
  # schema (entity extension scanning adds columns missed on a completely fresh database).
  if [[ -d /tmp/broadleaf-hsqldb ]]; then
    echo "HSQLDB already seeded at /tmp/broadleaf-hsqldb — skipping bootstrap."
    echo "Delete /tmp/broadleaf-hsqldb to force a re-seed."
    return
  fi

  mkdir -p "$LOG_DIR"
  local bootstrap_log="$LOG_DIR/bootstrap.log"

  echo "Bootstrapping HSQLDB schema via mvn spring-boot:run (this takes ~60s)..."
  MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$REPO_DIR/site/pom.xml" spring-boot:run \
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
  if [[ ! -f "$REPO_DIR/site/target/site.jar" && \
        ! -d "$REPO_DIR/site/target/classes" && \
        ! -f "$REPO_DIR/site/target/ROOT.jar" ]]; then
    echo "Build artifacts not found. Run 'build' first." >&2
    exit 1
  fi

  if grep -q "opentelemetry-javaagent.jar" "$REPO_DIR/start-site.sh" 2>/dev/null; then
    if [[ ! -f "$SCRIPT_DIR/otel/opentelemetry-javaagent.jar" ]]; then
      echo "OTel agent not found. Run 'download-agent' first." >&2
      exit 1
    fi
  fi

  mkdir -p "$LOG_DIR"

  if [[ -f "$PID_FILE" ]]; then
    echo "PID file exists — servers may already be running. Run 'status' to check." >&2
    exit 1
  fi

  if port_in_use 8080; then echo "Port 8080 is already in use." >&2; exit 1; fi
  if port_in_use 8081; then echo "Port 8081 is already in use." >&2; exit 1; fi

  echo "Starting site on port 8080..."
  if [[ -x "$REPO_DIR/start-site.sh" ]]; then
    MAVEN_OPTS="$MAVEN_OPTS_VAL" "$REPO_DIR/start-site.sh" > "$LOG_DIR/site.log" 2>&1 &
  else
    MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$REPO_DIR/site/pom.xml" spring-boot:run \
      > "$LOG_DIR/site.log" 2>&1 &
  fi
  local site_pid=$!

  echo "Waiting for site to boot..."
  until grep -q "Started SiteApplication" "$LOG_DIR/site.log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$site_pid" 2>/dev/null; then
      echo "Site process died. Check $LOG_DIR/site.log" >&2
      exit 1
    fi
  done

  echo "Starting admin on port 8081..."
  if [[ -x "$REPO_DIR/start-admin.sh" ]]; then
    MAVEN_OPTS="$MAVEN_OPTS_VAL" "$REPO_DIR/start-admin.sh" > "$LOG_DIR/admin.log" 2>&1 &
  else
    MAVEN_OPTS="$MAVEN_OPTS_VAL" mvn -f "$REPO_DIR/admin/pom.xml" spring-boot:run \
      > "$LOG_DIR/admin.log" 2>&1 &
  fi
  local admin_pid=$!

  echo "$site_pid $admin_pid" > "$PID_FILE"

  until grep -q "Started AdminApplication" "$LOG_DIR/admin.log" 2>/dev/null; do
    sleep 3
    if ! kill -0 "$admin_pid" 2>/dev/null; then
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
  echo "Stop with: ./broadleaf.sh stop"
}

cmd_status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "Servers are not running (no PID file)."
    return
  fi
  local site_pid admin_pid
  read -r site_pid admin_pid < "$PID_FILE"
  echo "Site  PID $site_pid: $(kill -0 "$site_pid" 2>/dev/null && echo running || echo dead)"
  echo "Admin PID $admin_pid: $(kill -0 "$admin_pid" 2>/dev/null && echo running || echo dead)"
}

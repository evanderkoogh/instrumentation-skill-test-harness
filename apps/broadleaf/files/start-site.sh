#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPRING_INSTRUMENT="$SCRIPT_DIR/site/target/agents/spring-instrument.jar"
JAR="$SCRIPT_DIR/site/target/ROOT.jar"
EXPLODED="$SCRIPT_DIR/site/target/ROOT-exploded"

if [[ ! -d "$EXPLODED" || "$JAR" -nt "$EXPLODED" ]]; then
  rm -rf "$EXPLODED"
  mkdir -p "$EXPLODED"
  (cd "$EXPLODED" && jar -xf "$JAR")
fi

# Harness-tracking attributes (harness.run_id, service.instrumentation_skill.*) are NOT set
# here — the fan-out collector stamps them onto the Honeycomb-bound copy only, keeping the
# weaver pipeline's view of the telemetry clean (see collector.template.yaml).

exec java \
  -javaagent:"$SPRING_INSTRUMENT" \
  -Dhttp.server.port="${SITE_HTTP_PORT:-8080}" \
  -Dserver.port="${SITE_HTTPS_PORT:-8443}" \
  -cp "$EXPLODED/BOOT-INF/classes:$EXPLODED/BOOT-INF/lib/*" \
  com.community.SiteApplication

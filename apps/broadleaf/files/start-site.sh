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

if [[ -f "$SCRIPT_DIR/.skill-version" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.skill-version"
  export OTEL_RESOURCE_ATTRIBUTES="service.instrumentation_skill.branch=${SKILL_BRANCH},service.instrumentation_skill.git_sha=${SKILL_SHA}"
fi

exec java \
  -javaagent:"$SPRING_INSTRUMENT" \
  -cp "$EXPLODED/BOOT-INF/classes:$EXPLODED/BOOT-INF/lib/*" \
  com.community.SiteApplication

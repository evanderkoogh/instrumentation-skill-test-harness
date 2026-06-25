#!/usr/bin/env bash
# In-container post-agent lifecycle (container-only mode). Baked into the image at /harness and run by
# a single foreground `docker run` (see runLifecycleInContainer in src/container.ts). It does the whole
# scored lifecycle in one isolated PID+network namespace, then exits — the host reads back
# tmp/.eval-results.<app>.json. This replaces the host plumbing that used to do the same thing across
# the shared host (harness.sh start_collector, free_port, lsof kill-before-start, ports.sh).
#
#   app --OTLP--> otelcol-contrib --+--otlphttp--> Honeycomb        (run-scoped query eval)
#                                   +--otlp------> weaver live-check (registry scoring)
#
# Because every run gets its own netns, the collector/weaver ports are FIXED constants here — they can
# never collide with another run. Telemetry still egresses to Honeycomb; only inbound host ports go away.
set -euo pipefail

APP="${1:?usage: lifecycle.sh <app>}"
cd /harness

# Fixed netns-internal ports — safe because each run is its own isolated network namespace.
COL_GRPC=4317
COL_HTTP=4318
WEAVER_GRPC=4319
WEAVER_ADMIN=4320

LOG_DIR="/harness/logs/$APP"
REPO_DIR="/harness/checkouts/$APP"
WEAVER_REPORT_DIR="$LOG_DIR/weaver-report"
mkdir -p "$LOG_DIR"

# Real Honeycomb destination for the collector's exporter (forwarded by the host launcher), captured
# BEFORE we point the app at the local collector below.
HC_ENDPOINT="${HARNESS_HC_ENDPOINT:-https://api.honeycomb.io}"
HC_KEY="${HARNESS_INGEST_KEY:-}"
RUN_ID="${HARNESS_RUN_ID:-$APP-local}"

# --- weaver live-check receiver (registry scoring) ---
# Auto-discover the registry the skill created in the checkout; else weaver's upstream-semconv default.
REGISTRY_USED="upstream-semconv"
registry_arg=()
manifest="$(find "$REPO_DIR" \( -name manifest.yaml -o -name registry_manifest.yaml \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1 || true)"
if [[ -n "$manifest" ]]; then
  REGISTRY_USED="$(dirname "$manifest")"
  registry_arg=(--registry "$REGISTRY_USED")
fi

rm -rf "$WEAVER_REPORT_DIR"; mkdir -p "$WEAVER_REPORT_DIR"
echo "[lifecycle] starting weaver live-check (grpc:$WEAVER_GRPC admin:$WEAVER_ADMIN registry:$REGISTRY_USED)"
weaver registry live-check \
  --input-source otlp \
  --otlp-grpc-address 127.0.0.1 --otlp-grpc-port "$WEAVER_GRPC" \
  --admin-port "$WEAVER_ADMIN" \
  "${registry_arg[@]}" \
  --format json --output "$WEAVER_REPORT_DIR" \
  --inactivity-timeout 600 > "$LOG_DIR/weaver.log" 2>&1 &
WEAVER_PID=$!

# weaver is a best-effort add-on: if it never comes up we keep going (collector still scopes the run to
# Honeycomb) and run-eval reports the weaver criterion skipped.
WEAVER_OK=1
waited=0
until grep -q "OTLP receiver will stop" "$LOG_DIR/weaver.log" 2>/dev/null; do
  sleep 1
  if ! kill -0 "$WEAVER_PID" 2>/dev/null; then
    echo "[lifecycle] weaver failed to start — see $LOG_DIR/weaver.log; weaver criterion will be skipped." >&2
    WEAVER_OK=0; break
  fi
  if (( ++waited >= 60 )); then
    echo "[lifecycle] weaver not ready in 60s — see $LOG_DIR/weaver.log; weaver criterion will be skipped." >&2
    kill "$WEAVER_PID" 2>/dev/null || true; WEAVER_OK=0; break
  fi
done

# --- fan-out collector (app -> Honeycomb + weaver) ---
# Render the shared template with the fixed ports, the real Honeycomb destination, the run id (scopes
# the eval's queries), and the skill-version attributes (forwarded from the host). These are stamped on
# the Honeycomb-bound copy only, so weaver scores clean app telemetry — same contract as the old host
# collector (see collector.run.template.yaml).
esc='s/[\\&|]/\\&/g'
sk_branch="$(printf '%s' "${HARNESS_SKILL_BRANCH:-unknown}" | sed -e "$esc")"
sk_sha="$(printf '%s' "${HARNESS_SKILL_SHA:-unknown}" | sed -e "$esc")"
sk_commit="$(printf '%s' "${HARNESS_SKILL_COMMIT:-unknown}" | sed -e "$esc")"
sk_hash="$(printf '%s' "${HARNESS_SKILL_CONTENT_HASH:-unknown}" | sed -e "$esc")"
sk_uncommitted="$(printf '%s' "${HARNESS_SKILL_UNCOMMITTED:-unknown}" | sed -e "$esc")"

COLLECTOR_CONFIG="/harness/tmp/.lifecycle.$APP.collector.yaml"
sed \
  -e "s|%COLLECTOR_GRPC_PORT%|$COL_GRPC|g" \
  -e "s|%COLLECTOR_HTTP_PORT%|$COL_HTTP|g" \
  -e "s|%HONEYCOMB_ENDPOINT%|$HC_ENDPOINT|g" \
  -e "s|%API_KEY%|$HC_KEY|g" \
  -e "s|%WEAVER_GRPC_ENDPOINT%|127.0.0.1:$WEAVER_GRPC|g" \
  -e "s|%RUN_ID%|$RUN_ID|g" \
  -e "s|%SKILL_BRANCH%|$sk_branch|g" \
  -e "s|%SKILL_GIT_SHA%|$sk_sha|g" \
  -e "s|%SKILL_COMMIT%|$sk_commit|g" \
  -e "s|%SKILL_CONTENT_HASH%|$sk_hash|g" \
  -e "s|%SKILL_UNCOMMITTED%|$sk_uncommitted|g" \
  /harness/collector.run.template.yaml > "$COLLECTOR_CONFIG"

echo "[lifecycle] starting fan-out collector (app http:$COL_HTTP -> Honeycomb + weaver)"
otelcol-contrib --config "$COLLECTOR_CONFIG" > "$LOG_DIR/collector.log" 2>&1 &
COL_PID=$!
waited=0
until lsof -ti tcp:"$COL_HTTP" > /dev/null 2>&1; do
  sleep 1
  if ! kill -0 "$COL_PID" 2>/dev/null; then
    echo "[lifecycle] collector failed to start — see $LOG_DIR/collector.log" >&2
    exit 1
  fi
  if (( ++waited >= 20 )); then
    echo "[lifecycle] collector not ready within 20s — see $LOG_DIR/collector.log" >&2
    exit 1
  fi
done

# Point the app's OTLP exporter at the local collector before booting it. harness.sh start (now just
# cmd_start, collector plumbing removed) launches the app in a subshell that inherits this env.
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$COL_HTTP"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS=""
# Metrics default to a 60s export cycle — longer than a harness run. Shorten so metrics flush in time.
export OTEL_METRIC_EXPORT_INTERVAL="10000"

# Build the app FOR LINUX inside the container before starting it. The host can't do this in
# container-only mode — a host build produces host-platform artifacts (e.g. a macOS .venv / native
# objects) the Linux container can't run. cmd_build is idempotent and uses the bind-mounted toolchain
# caches (HOME: uv / GOPATH / ~/.m2), so when the agent container already built it this is fast; when
# the checkout still holds a host build, cmd_build detects the mismatch and rebuilds.
echo "[lifecycle] building app: $APP"
./harness.sh "$APP" build

echo "[lifecycle] starting app: $APP"
# tmp/ is bind-mounted from the host, so a PID file left by the agent container's own verification boot
# (or a prior run) can linger and make cmd_start refuse to start ("PID file exists"). Clear it — this
# container is the sole owner of the app from here on.
rm -f "/harness/tmp/.harness.$APP.pids"
./harness.sh "$APP" start

echo "[lifecycle] generating traffic: $APP"
./harness.sh "$APP" traffic

echo "[lifecycle] waiting 15s for spans to flush"
sleep 15

# --- evaluate (in-process here; weaver admin + registry passed via env, no host state file) ---
echo "[lifecycle] evaluating: $APP"
if [[ "$WEAVER_OK" == "1" ]]; then
  export HARNESS_WEAVER_ADMIN_PORT="$WEAVER_ADMIN"
  export HARNESS_WEAVER_REGISTRY="$REGISTRY_USED"
fi
node_modules/.bin/tsx src/run-eval.ts "$APP"

echo "[lifecycle] done"

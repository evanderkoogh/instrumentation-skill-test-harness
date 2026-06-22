#!/usr/bin/env bash
# Generates representative HTTP traffic against BeaverHabits.
# Uses /demo routes which require no authentication.
set -euo pipefail

# Port is exported by harness.sh (harness_traffic); falls back to the registry default.
PORT="${APP_HTTP_PORT:-9101}"
if ! lsof -ti tcp:"$PORT" > /dev/null 2>&1; then
  echo "Server is not running on port $PORT. Run './harness.sh beaverhabits start' first." >&2
  exit 1
fi

base="http://localhost:$PORT"
paths=(
  "/demo"
  "/demo/add"
  "/demo/stats"
  "/demo/order"
  "/demo/completion-status"
  "/login"
  "/register"
)

echo "Generating traffic against $base..."
for path in "${paths[@]}"; do
  printf "  GET %-40s" "$path"
  curl -s -o /dev/null -w "%{http_code} (%{time_total}s)\n" "$base$path" || echo "FAILED"
done
echo "Done. Allow ~10s for spans to flush to Honeycomb."

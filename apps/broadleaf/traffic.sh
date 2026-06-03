#!/usr/bin/env bash
# Generates representative HTTP traffic against the Broadleaf DemoSite.
# Called by harness.sh when running: ./broadleaf.sh traffic
set -euo pipefail

if ! lsof -ti tcp:8443 > /dev/null 2>&1; then
  echo "Site is not running on port 8443. Run './broadleaf.sh start' first." >&2
  exit 1
fi

base="https://localhost:8443"
paths=(
  "/"
  "/hot-sauces"
  "/hot-sauces?page=2"
  "/hot-sauces/hoppin_hot_sauce"
  "/hot-sauces/day_of_the_dead_chipotle_hot_sauce"
  "/hot-sauces/armageddon_hot_sauce_to_end_all"
  "/hot-sauces/green_ghost"
  "/merchandise"
  "/cart"
  "/search?q=hot"
  "/search?q=cajun"
)

echo "Generating traffic against $base..."
for path in "${paths[@]}"; do
  printf "  GET %-50s" "$path"
  curl -sk -o /dev/null -w "%{http_code} (%{time_total}s)\n" --insecure "$base$path" || echo "FAILED"
done
echo "Done. Allow ~10s for spans to flush to Honeycomb."

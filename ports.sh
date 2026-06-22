#!/usr/bin/env bash
# ports.sh — single source of truth for every TCP port each app binds.
#
# Sourced by harness.sh (which re-exposes the vars to apps/<app>/config.sh, the
# port preflight, and the kill-before-start step). Run `./harness.sh <anyapp> ports`
# to print the map and verify there are no collisions.
#
# RULES:
#   - Every port an app binds must be listed here — including *implicit* ones the
#     framework opens that aren't in config.sh (e.g. Broadleaf's embedded HSQLDB).
#   - All ports must be globally DISJOINT: parallel runs share one host, and the
#     kill-before-start step clears an app's own ports, so an overlap would let one
#     app kill or collide with another.
#   - The harness's per-run collector/weaver ports are allocated separately in
#     20000-40000 (harness.sh free_port) and are intentionally out of this range.

# --- broadleaf (Spring Boot site + admin + embedded HSQLDB) ---
BROADLEAF_HTTP_PORT=8080         # site HTTP connector
BROADLEAF_HTTPS_PORT=8443        # site HTTPS connector (traffic target)
BROADLEAF_ADMIN_HTTP_PORT=8081   # admin HTTP connector
BROADLEAF_ADMIN_HTTPS_PORT=8444  # admin HTTPS connector
BROADLEAF_HSQLDB_PORT=9001       # embedded HSQLDB (Broadleaf framework default — reserve it)

# --- beaverhabits (uvicorn; SQLite, no DB port) ---
BEAVERHABITS_HTTP_PORT=9101      # moved off 9001 (reserved above for broadleaf HSQLDB)

# --- realworld-go (Gin; SQLite, no DB port) ---
REALWORLDGO_HTTP_PORT=8090       # always passed via PORT so it never defaults to 8080

# Apps that have registered ports. Add new apps here.
registered_apps() { echo "broadleaf beaverhabits realworld-go"; }

# All ports a given app binds (space-separated). Used by the preflight check and
# the kill-before-start step.
app_ports() {
  case "$1" in
    broadleaf)
      echo "$BROADLEAF_HTTP_PORT $BROADLEAF_HTTPS_PORT $BROADLEAF_ADMIN_HTTP_PORT $BROADLEAF_ADMIN_HTTPS_PORT $BROADLEAF_HSQLDB_PORT" ;;
    beaverhabits)
      echo "$BEAVERHABITS_HTTP_PORT" ;;
    realworld-go)
      echo "$REALWORLDGO_HTTP_PORT" ;;
    *)
      echo "" ;;
  esac
}

# Verify no port is claimed by two apps. Prints the map; returns non-zero on conflict.
ports_check() {
  local a p seen_app conflict=0
  declare -A owner
  for a in $(registered_apps); do
    for p in $(app_ports "$a"); do
      seen_app="${owner[$p]:-}"
      if [[ -n "$seen_app" && "$seen_app" != "$a" ]]; then
        echo "PORT CONFLICT: $p claimed by both '$seen_app' and '$a'" >&2
        conflict=1
      fi
      owner[$p]="$a"
    done
  done
  for a in $(registered_apps); do
    echo "  $a: $(app_ports "$a")"
  done
  if [[ "$conflict" == "1" ]]; then
    echo "Port registry has conflicts (see above)." >&2
    return 1
  fi
  echo "Port registry OK — no conflicts."
  return 0
}

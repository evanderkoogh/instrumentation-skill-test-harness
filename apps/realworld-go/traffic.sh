#!/usr/bin/env bash
# Generates representative traffic against the RealWorld "Conduit" Go backend.
# Exercises auth, article CRUD, comments, tags, profiles, plus a few error paths,
# so instrumentation produces server spans across many routes and DB read/write spans.
# Called by harness.sh when running: ./harness.sh realworld-go traffic
set -euo pipefail

PORT="${APP_HTTP_PORT:-8080}"
base="http://localhost:$PORT/api"

if ! curl -fsS "$base/ping/" > /dev/null 2>&1; then
  echo "Server is not responding on port $PORT. Run './harness.sh realworld-go start' first." >&2
  exit 1
fi

# Unique suffix so repeated runs don't collide on a persistent SQLite DB.
suffix="$$_${RANDOM}"
user="tester_${suffix}"
email="tester_${suffix}@example.com"
pass="password123"

# Pull fields out of JSON responses without requiring jq.
token_from() {
  python3 -c 'import sys,json; print(json.load(sys.stdin)["user"]["token"])' 2>/dev/null || true
}
slug_from() {
  python3 -c 'import sys,json; print(json.load(sys.stdin)["article"]["slug"])' 2>/dev/null || true
}

req() {
  # req METHOD PATH [DATA] [AUTH_TOKEN]
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local args=(-sk -o /dev/null -w "%{http_code} (%{time_total}s)\n" -X "$method" "$base$path")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Token $auth")
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  printf "  %-6s %-42s" "$method" "$path"
  curl "${args[@]}" || echo "FAILED"
}

# Same as req but captures the body (for token / slug extraction).
capture() {
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local args=(-sk -X "$method" "$base$path")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Token $auth")
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  curl "${args[@]}"
}

echo "Generating traffic against $base (user: $user)..."

# --- Auth ---
req GET "/ping/"
reg_body=$(capture POST "/users" "{\"user\":{\"username\":\"$user\",\"email\":\"$email\",\"password\":\"$pass\"}}")
printf "  %-6s %-42s%s\n" "POST" "/users (register)" "ok"
login_body=$(capture POST "/users/login" "{\"user\":{\"email\":\"$email\",\"password\":\"$pass\"}}")
token=$(printf '%s' "$login_body" | token_from)
if [[ -z "$token" ]]; then
  token=$(printf '%s' "$reg_body" | token_from)
fi
printf "  %-6s %-42s%s\n" "POST" "/users/login" "$( [[ -n "$token" ]] && echo "token acquired" || echo "NO TOKEN" )"

req GET "/user" "" "$token"

# --- Article writes ---
declare -a slugs=()
tags=("dragons" "training" "golang" "observability")
for i in 1 2 3; do
  art_body=$(capture POST "/articles" \
    "{\"article\":{\"title\":\"How to train your dragon ${suffix}-${i}\",\"description\":\"Ever wonder how?\",\"body\":\"It takes a Jacobian. Iteration ${i}.\",\"tagList\":[\"${tags[$((i-1))]}\",\"${tags[3]}\"]}}" \
    "$token")
  slug=$(printf '%s' "$art_body" | slug_from)
  [[ -n "$slug" ]] && slugs+=("$slug")
  printf "  %-6s %-42s%s\n" "POST" "/articles (#$i)" "$( [[ -n "$slug" ]] && echo "$slug" || echo "FAILED" )"
done

# --- Article reads + interactions ---
req GET "/articles?limit=10&offset=0"
req GET "/articles?tag=golang"
req GET "/articles/feed" "" "$token"
req GET "/tags"
req GET "/profiles/$user"
req POST "/profiles/$user/follow" "" "$token"

for slug in "${slugs[@]}"; do
  req GET    "/articles/$slug"
  req POST   "/articles/$slug/favorite" "" "$token"
  req POST   "/articles/$slug/comments" "{\"comment\":{\"body\":\"Thank you so much!\"}}" "$token"
  req GET    "/articles/$slug/comments"
  req DELETE "/articles/$slug/favorite" "" "$token"
done

# --- Error paths (exercise 401 / 404 handlers) ---
req GET  "/articles/this-slug-does-not-exist-$suffix"
req GET  "/user"                                # missing token -> 401
req POST "/articles" "{\"article\":{}}"          # unauthenticated -> 401

echo "Done. Allow ~10s for spans to flush to Honeycomb."

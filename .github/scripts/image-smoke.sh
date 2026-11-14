#!/usr/bin/env bash
# make image-smoke: the prod-image smoke test (ADR-0009, test-hooks.md §6).
# Runs the production image exactly as built (NODE_ENV comes from the image,
# no test hooks) with production-like config against a throwaway, migrated
# Postgres, and checks:
#   1. the image holds only dist/, node_modules/, package.json and public/, the
#      test-hook sentinel appears nowhere in /app, and dist/ has no `_test` word
#   2. config refuses TEST_HOOKS=1 and a missing TRUST_PROXY_HOPS
#   3. /api/healthz and /api/readyz respond 200
#   4. the security headers and CSP are present
#   5. the Host check rejects a foreign host
#   6. /api/_test/reset and /api/_test/login return 404
#   7. the SPA loads from STATIC_DIR (once frontend/ exists)
# Builds the image first when it is not there yet (make image).
source "$(dirname "$0")/lib.sh"
require_docker
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required (brew install jq)"

if ! has_pkg backend; then
  log "make image-smoke: skipped (needs backend/package.json; found: $(workspace_pkgs_text))"
  exit 0
fi

tag="$(image_tag)"
if ! docker image inspect "$tag" >/dev/null 2>&1; then
  bash "$ROOT/.github/scripts/image.sh"
fi

export COMPOSE_PROJECT_NAME=shoestring-smoke
export POSTGRES_DB=shoestring_test
export POSTGRES_PORT="${SMOKE_POSTGRES_PORT:-55434}"
SMOKE_PORT="${SMOKE_PORT:-58080}"
APP_NAME="shoestring-smoke-app"
NETWORK="${COMPOSE_PROJECT_NAME}_default"
BASE="http://127.0.0.1:$SMOKE_PORT"
# Postgres plus the one-shot migrate service; no backend/frontend dev servers.
PROFILE_ARGS=(--profile db)

# Fresh throwaway credentials, passed to containers by name (-e VAR), so values
# never appear in argv or logs.
export_throwaway_credentials
# Production-like config. APP_ORIGIN is a reserved .test name (RFC 6761); the
# database is the compose service (a local host, so no sslmode=verify-full).
# EMAIL_API_KEY is a dummy: nothing in the smoke sends email.
export APP_ORIGIN="https://shoestring.test"
export WEBAUTHN_RP_ID="shoestring.test"
export DATABASE_URL="postgres://app:${APP_DB_PASSWORD}@postgres:5432/$POSTGRES_DB"
export EMAIL_API_KEY="re_smoke_dummy_not_a_key"
export EMAIL_FROM="Shoestring <no-reply@shoestring.test>"
export EMAIL_DAILY_QUOTA=100
export TRUST_PROXY_HOPS=1
export LOG_LEVEL=info
APP_ENV=(-e APP_ORIGIN -e WEBAUTHN_RP_ID -e DATABASE_URL -e APP_KEYRING
  -e EMAIL_API_KEY -e EMAIL_FROM -e EMAIL_DAILY_QUOTA -e TRUST_PROXY_HOPS -e LOG_LEVEL)
# Tighter than Cloud Run: read-only root, no capabilities. A failure here means
# the app writes outside /tmp or needs a capability, worth knowing either way.
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges)

failures=0
pass() { note "PASS  $*"; }
# expect <label> <want> <got>
expect() {
  if [ "$3" = "$2" ]; then pass "$1: $3"; else fail "$1: got $3, want $2"; fi
}
fail() {
  note "FAIL  $*"
  failures=$((failures + 1))
}

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] || [ "$failures" -ne 0 ]; then
    log "Last app logs"
    docker logs --tail 60 "$APP_NAME" 2>&1 || true
  fi
  docker rm -f "$APP_NAME" shoestring-smoke-refuse >/dev/null 2>&1 || true
  compose_test down --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# --- 1. image contents ----------------------------------------------------------
log "Image contents ($tag)"
# The scan runs with the image's own node (distroless has no shell or grep).
# Same word rule as backend/scripts/test-hooks-tripwire.ts and the Dockerfile.
scan='
const fs = require("node:fs"), path = require("node:path");
const WORD = /(?<![A-Za-z0-9_])_test(?![A-Za-z0-9_])/, SENTINEL = "__SHOESTRING_TEST_HOOKS__";
const allowed = new Set(["dist", "node_modules", "package.json", "public"]);
const extra = fs.readdirSync("/app").filter((n) => !allowed.has(n));
const sentinel = [], word = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) {
      const t = fs.readFileSync(p, "latin1");
      if (t.includes(SENTINEL)) sentinel.push(p);
      if (p.startsWith("/app/dist/") && /\.(m|c)?js$/.test(p) && WORD.test(t)) word.push(p);
    }
  }
};
walk("/app");
console.log(JSON.stringify({ extra, sentinel, word }));
'
contents="$(docker run --rm --network none --entrypoint /nodejs/bin/node "$tag" -e "$scan")"
extra="$(printf '%s' "$contents" | jq -r '.extra | join(" ")')"
sentinel="$(printf '%s' "$contents" | jq -r '.sentinel | join(" ")')"
word="$(printf '%s' "$contents" | jq -r '.word | join(" ")')"
if [ -z "$extra" ]; then pass "/app holds only dist, node_modules, package.json, public"; else fail "unexpected entries in /app: $extra"; fi
if [ -z "$sentinel" ]; then pass "test-hook sentinel absent from all of /app"; else fail "sentinel found in: $sentinel"; fi
if [ -z "$word" ]; then pass "no \`_test\` word in /app/dist"; else fail "\`_test\` found in: $word"; fi

# --- 2. config refusals (no database needed: config fails before any connect) ---
log "Config refusals"
# expect_refusal <label> <expected message> <docker env args...>
expect_refusal() {
  local label="$1" want="$2" code running out
  shift 2
  docker run -d --name shoestring-smoke-refuse --network none "${HARDEN[@]}" "$@" "$tag" >/dev/null
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Running}}' shoestring-smoke-refuse)" = "false" ] && break
    sleep 0.5
  done
  code="$(docker inspect -f '{{.State.ExitCode}}' shoestring-smoke-refuse)"
  running="$(docker inspect -f '{{.State.Running}}' shoestring-smoke-refuse)"
  out="$(docker logs shoestring-smoke-refuse 2>&1 || true)"
  docker rm -f shoestring-smoke-refuse >/dev/null
  if [ "$running" = "false" ] && [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qF "$want"; then
    pass "$label: refused to start (exit $code)"
  else
    fail "$label: expected a refusal containing \"$want\" (running=$running, exit $code)"
  fi
}
expect_refusal "TEST_HOOKS=1" "TEST_HOOKS=1 is refused in production" "${APP_ENV[@]}" -e TEST_HOOKS=1
# A later -e wins; config treats a blank value as unset.
expect_refusal "blank TRUST_PROXY_HOPS" "TRUST_PROXY_HOPS is required in production" \
  "${APP_ENV[@]}" -e TRUST_PROXY_HOPS=
# The admin entry is a separate bundle: prove it loads in the image too. With
# no command it must reach its own usage check (exit 2, outcome usage_error)
# rather than crash on a missing module (exit 1).
set +e
admin_out="$(docker run --rm --network none "${HARDEN[@]}" "$tag" dist/admin.js 2>&1)"
admin_rc=$?
set -e
if [ "$admin_rc" -eq 2 ] && printf '%s' "$admin_out" | grep -q '"outcome":"usage_error"'; then
  pass "dist/admin.js loads (usage error, exit 2)"
else
  fail "dist/admin.js did not load cleanly (exit $admin_rc)"
fi

# --- throwaway Postgres + migrations --------------------------------------------
log "Starting throwaway Postgres and applying migrations (project $COMPOSE_PROJECT_NAME)"
compose_test run --rm --quiet-pull migrate
note "Database migrated after $(elapsed)"

log "Starting the production image ($tag) on 127.0.0.1:$SMOKE_PORT"
docker run -d --name "$APP_NAME" --network "$NETWORK" -p "127.0.0.1:$SMOKE_PORT:8080" \
  "${HARDEN[@]}" "${APP_ENV[@]}" "$tag" >/dev/null
up=0
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' "$APP_NAME")" = "true" ] || die "the app container exited (logs below)"
  if curl -fsS -o /dev/null "$BASE/api/healthz" 2>/dev/null; then
    up=1
    break
  fi
  sleep 0.5
done
[ "$up" -eq 1 ] || die "the app did not answer /api/healthz within 30s"
note "Listening after $(elapsed)"

# --- 3-7. HTTP checks -----------------------------------------------------------
log "HTTP checks"
HOST_H="Host: shoestring.test"
# status <curl args...>: prints the HTTP status code only.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

expect "GET /api/healthz" 200 "$(status "$BASE/api/healthz")"
expect "GET /api/readyz (database, migrations, keyring)" 200 "$(status "$BASE/api/readyz")"

headers="$(curl -s -D - -o /dev/null -H "$HOST_H" "$BASE/api/healthz" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
for h in "content-security-policy: default-src 'self'" "frame-ancestors 'none'" \
  "strict-transport-security: max-age=" "x-content-type-options: nosniff" \
  "x-frame-options: deny" "referrer-policy: no-referrer" "cross-origin-opener-policy: same-origin"; do
  if printf '%s' "$headers" | grep -qF "$h"; then pass "header: $h"; else fail "missing header: $h"; fi
done

# A non-exempt route: the right Host passes the Host check (401, no session),
# a foreign Host is rejected before anything else (400).
expect "GET /api/auth/session, app Host, no session" 401 "$(status -H "$HOST_H" "$BASE/api/auth/session")"
expect "GET /api/auth/session, foreign Host" 400 "$(status -H "Host: evil.example" "$BASE/api/auth/session")"

for p in reset login; do
  expect "POST /api/_test/$p" 404 "$(status -X POST -H "$HOST_H" -H "Origin: $APP_ORIGIN" \
    -H 'Content-Type: application/json' --data '{}' "$BASE/api/_test/$p")"
done

if has_pkg frontend; then
  expect "GET / (SPA)" 200 "$(status -H "$HOST_H" -H 'Accept: text/html' "$BASE/")"
  expect "GET /some/deep/link (index.html fallback)" 200 \
    "$(status -H "$HOST_H" -H 'Accept: text/html' "$BASE/some/deep/link")"
else
  note "SKIP  SPA checks: frontend/ has no package.json yet (API-only image)"
fi

if docker logs "$APP_NAME" 2>&1 | grep -q "test hooks registered"; then
  fail "logs say test hooks registered"
fi

if [ "$failures" -ne 0 ]; then die "make image-smoke: $failures check(s) failed"; fi
log "make image-smoke: passed in $(elapsed)"

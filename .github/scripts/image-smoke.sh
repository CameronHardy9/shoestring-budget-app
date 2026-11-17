#!/usr/bin/env bash
# make image-smoke: the prod-image smoke test (ADR-0009, test-hooks.md §6).
# Runs the production image exactly as built (NODE_ENV comes from the image,
# no test hooks) with production-like config against a throwaway, migrated
# Postgres, and checks:
#   1. the image holds only dist/, node_modules/, package.json and public/, the
#      test-hook sentinel appears nowhere in /app, and dist/ has no `_test` word
#   2. config refuses TEST_HOOKS=1 and a missing TRUST_PROXY_HOPS
#   3. /api/healthz and /api/readyz respond 200
#   4. the security headers and CSP (exact script-src and style-src) on
#      /api/healthz, and on /, an SPA deep link and /sw.js once frontend/ exists (F-53)
#   5. the Host check rejects a foreign host
#   6. /api/_test/reset and /api/_test/login return 404
#   7. the SPA loads from STATIC_DIR (once frontend/ exists), and no source map
#      is in /app/public or reachable over HTTP (they go to Sentry privately)
#   8. with SENTRY_DSN set, the server starts (loads its bundled Sentry chunk)
#      and the CSP names the DSN's ingest host
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
const sentinel = [], word = [], maps = [], mapRefs = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) {
      const t = fs.readFileSync(p, "latin1");
      if (t.includes(SENTINEL)) sentinel.push(p);
      if (p.startsWith("/app/dist/") && /\.(m|c)?js$/.test(p) && WORD.test(t)) word.push(p);
      if (p.startsWith("/app/public/") && p.endsWith(".map")) maps.push(p);
      if (p.startsWith("/app/public/") && /\.(m|c)?js$/.test(p) && /[#@] sourceMappingURL=/.test(t)) mapRefs.push(p);
    }
  }
};
walk("/app");
console.log(JSON.stringify({ extra, sentinel, word, maps, mapRefs }));
'
contents="$(docker run --rm --network none --entrypoint /nodejs/bin/node "$tag" -e "$scan")"
extra="$(printf '%s' "$contents" | jq -r '.extra | join(" ")')"
sentinel="$(printf '%s' "$contents" | jq -r '.sentinel | join(" ")')"
word="$(printf '%s' "$contents" | jq -r '.word | join(" ")')"
if [ -z "$extra" ]; then pass "/app holds only dist, node_modules, package.json, public"; else fail "unexpected entries in /app: $extra"; fi
if [ -z "$sentinel" ]; then pass "test-hook sentinel absent from all of /app"; else fail "sentinel found in: $sentinel"; fi
if [ -z "$word" ]; then pass "no \`_test\` word in /app/dist"; else fail "\`_test\` found in: $word"; fi
# Source maps go to Sentry privately (make sourcemaps-upload), never to users.
maps="$(printf '%s' "$contents" | jq -r '.maps | join(" ")')"
map_refs="$(printf '%s' "$contents" | jq -r '.mapRefs | join(" ")')"
if [ -z "$maps" ]; then pass "no source maps in /app/public"; else fail "source maps in /app/public: $maps"; fi
if [ -z "$map_refs" ]; then pass "no sourceMappingURL comment in /app/public JS"; else fail "sourceMappingURL in: $map_refs"; fi

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

# start_app [docker env args...]: runs the image as $APP_NAME and waits for healthz.
start_app() {
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$APP_NAME" --network "$NETWORK" -p "127.0.0.1:$SMOKE_PORT:8080" \
    "${HARDEN[@]}" "${APP_ENV[@]}" "$@" "$tag" >/dev/null
  local up=0
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
}

log "Starting the production image ($tag) on 127.0.0.1:$SMOKE_PORT, without SENTRY_DSN"
start_app

# --- 3-7. HTTP checks -----------------------------------------------------------
log "HTTP checks"
HOST_H="Host: shoestring.test"
# status <curl args...>: prints the HTTP status code only.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# The exact script-src and style-src every response must carry (F-23, F-53).
# style-src allows exactly the two React Aria hashes the owner approved
# (2026-11-14, security sign-off in FINDINGS F-23), read from their source of
# truth: frontend/src/security/csp.ts, whose unit test recomputes them from the
# installed react-aria (the backend's copy is pinned to it by a backend test).
WANT_SCRIPT_SRC="script-src 'self'"
WANT_STYLE_SRC=""
if has_pkg frontend; then
  CSP_SOURCE="$ROOT/frontend/src/security/csp.ts"
  [ -f "$CSP_SOURCE" ] || die "$CSP_SOURCE is missing: the smoke reads the approved style hashes from it"
  style_hashes="$(awk '/REACT_ARIA_STYLE_HASHES *=/ { on = 1 } on { print } on && /\]/ { exit }' "$CSP_SOURCE" |
    grep -oE "sha256-[A-Za-z0-9+/]+=*" || true)"
  n_hashes="$(printf '%s' "$style_hashes" | grep -c . || true)"
  # Exactly two: another hash is a CSP change that needs security sign-off.
  [ "$n_hashes" = 2 ] ||
    die "expected exactly 2 sha256 hashes in REACT_ARIA_STYLE_HASHES ($CSP_SOURCE), found $n_hashes"
  WANT_STYLE_SRC="style-src 'self' $(printf '%s\n' "$style_hashes" | sed "s/.*/'&'/" | paste -sd ' ' -)"
fi
SEC_HEADERS=("content-security-policy: default-src 'self'" "frame-ancestors 'none'"
  "strict-transport-security: max-age=" "x-content-type-options: nosniff"
  "x-frame-options: deny" "referrer-policy: no-referrer" "cross-origin-opener-policy: same-origin"
  "cross-origin-resource-policy: same-origin")

# content_type <curl args...>: the Content-Type of a GET, without parameters.
content_type() { curl -s -o /dev/null -w '%{content_type}' -H "$HOST_H" "$@" | sed 's/;.*//' || true; }

# check_headers <label> [curl args...] <url>: status 200 with the app Host,
# every header in SEC_HEADERS (case-insensitive), and in the CSP exactly one
# script-src and one style-src with the exact values above, no -elem/-attr
# variant that would override them, and no 'unsafe-*' or nonce source.
check_headers() {
  local label="$1" raw code low csp d n_script=0 n_style=0 h
  shift
  raw="$(curl -s -D - -o /dev/null -w '\n%{http_code}' -H "$HOST_H" "$@" | tr -d '\r' || true)"
  code="$(printf '%s' "$raw" | tail -n 1)"
  expect "$label" 200 "$code"
  low="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  for h in "${SEC_HEADERS[@]}"; do
    if printf '%s' "$low" | grep -qF "$h"; then pass "$label header: $h"; else fail "$label missing header: $h"; fi
  done
  # Values keep their case: the hashes are base64.
  csp="$(printf '%s\n' "$raw" | sed -n 's/^[Cc][Oo][Nn][Tt][Ee][Nn][Tt]-[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]-[Pp][Oo][Ll][Ii][Cc][Yy]: *//p')"
  [ "$(printf '%s\n' "$csp" | grep -c .)" -le 1 ] || fail "$label: more than one Content-Security-Policy header"
  while IFS= read -r d; do
    d="$(printf '%s' "$d" | sed -E 's/^ +//; s/ +$//')"
    case "$d" in
      "script-src "*)
        n_script=$((n_script + 1))
        expect "$label CSP script-src" "$WANT_SCRIPT_SRC" "$d"
        ;;
      "style-src "*)
        n_style=$((n_style + 1))
        if [ -n "$WANT_STYLE_SRC" ]; then expect "$label CSP style-src" "$WANT_STYLE_SRC" "$d"; fi
        ;;
      script-src-* | style-src-*) fail "$label CSP has $d (overrides script-src/style-src)" ;;
    esac
  done <<EOF_CSP
$(printf '%s' "$csp" | tr ';' '\n')
EOF_CSP
  [ "$n_script" -eq 1 ] || fail "$label CSP: $n_script script-src directives, want 1"
  [ "$n_style" -eq 1 ] || fail "$label CSP: $n_style style-src directives, want 1"
  if printf '%s' "$csp" | grep -qiE "'unsafe-|'nonce-"; then fail "$label CSP allows 'unsafe-*' or a nonce"; fi
}

expect "GET /api/healthz" 200 "$(status "$BASE/api/healthz")"
expect "GET /api/readyz (database, migrations, keyring)" 200 "$(status "$BASE/api/readyz")"

check_headers "GET /api/healthz" "$BASE/api/healthz"

# A non-exempt route: the right Host passes the Host check (401, no session),
# a foreign Host is rejected before anything else (400).
expect "GET /api/auth/session, app Host, no session" 401 "$(status -H "$HOST_H" "$BASE/api/auth/session")"
expect "GET /api/auth/session, foreign Host" 400 "$(status -H "Host: evil.example" "$BASE/api/auth/session")"

for p in reset login; do
  expect "POST /api/_test/$p" 404 "$(status -X POST -H "$HOST_H" -H "Origin: $APP_ORIGIN" \
    -H 'Content-Type: application/json' --data '{}' "$BASE/api/_test/$p")"
done

if has_pkg frontend; then
  # F-53: the documents are where the CSP matters most. Same header checks as
  # healthz, plus the exact script-src and style-src, on the SPA entry, the
  # index.html fallback and the service worker.
  check_headers "GET / (SPA)" -H 'Accept: text/html' "$BASE/"
  expect "GET / content type" text/html "$(content_type -H 'Accept: text/html' "$BASE/")"
  check_headers "GET /some/deep/link (index.html fallback)" -H 'Accept: text/html' "$BASE/some/deep/link"
  expect "GET /some/deep/link content type" text/html \
    "$(content_type -H 'Accept: text/html' "$BASE/some/deep/link")"
  check_headers "GET /sw.js" "$BASE/sw.js"
  # The maps exist (in the sourcemaps stage) but are not served: a map URL next
  # to every script the document loads answers 404, and with Accept: text/html
  # at most the SPA fallback (index.html), never a map.
  scripts="$(curl -s -H "$HOST_H" -H 'Accept: text/html' "$BASE/" |
    grep -oE 'src="/assets/[^"]+\.js"' | sed -E 's/^src="//; s/"$//' || true)"
  if [ -z "$scripts" ]; then fail "GET /: found no /assets/*.js script to probe for a map"; fi
  for js in $scripts; do
    expect "GET $js" 200 "$(status -H "$HOST_H" "$BASE$js")"
    expect "GET $js.map" 404 "$(status -H "$HOST_H" "$BASE$js.map")"
    if curl -s -H "$HOST_H" -H 'Accept: text/html' "$BASE$js.map" | grep -q '"mappings"'; then
      fail "GET $js.map (Accept: text/html) returned a source map"
    else
      pass "GET $js.map (Accept: text/html): no source map"
    fi
  done
  sw_type="$(content_type "$BASE/sw.js")"
  case "$sw_type" in
    application/javascript | text/javascript) pass "GET /sw.js content type: $sw_type" ;;
    *) fail "GET /sw.js content type: got $sw_type, want JavaScript" ;;
  esac
else
  note "SKIP  SPA checks: frontend/ has no package.json yet (API-only image)"
fi

if docker logs "$APP_NAME" 2>&1 | grep -q "test hooks registered"; then
  fail "logs say test hooks registered"
fi

# --- 8. with SENTRY_DSN ----------------------------------------------------------
# The server imports @sentry/node only when SENTRY_DSN is set, from a lazy chunk
# rolldown bundles into dist/ (no Sentry package in node_modules). Starting with
# a DSN proves the chunk is in the image and loads under the hardened runtime.
# The DSN is the e2e fake on a .test host that never resolves, so nothing is
# sent; the CSP must then name exactly its ingest origin.
log "Restarting the image with SENTRY_DSN (fake .test DSN)"
start_app -e "SENTRY_DSN=$E2E_SENTRY_DSN"
sentry_host="$(printf '%s' "$E2E_SENTRY_DSN" | sed -E 's#^https://[^@]*@([^/]*)/.*#\1#')"
s_headers="$(curl -s -D - -o /dev/null -H "$HOST_H" "$BASE/api/healthz" | tr -d '\r' || true)"
if printf '%s' "$s_headers" | grep -qiE "^content-security-policy:.*connect-src 'self' https://$sentry_host(;|$)"; then
  pass "with SENTRY_DSN: connect-src 'self' https://$sentry_host"
else
  fail "with SENTRY_DSN: connect-src does not name https://$sentry_host"
fi
if printf '%s' "$s_headers" | grep -qiE "^reporting-endpoints: csp=\"https://$sentry_host/api/1/security/"; then
  pass "with SENTRY_DSN: Reporting-Endpoints points at the ingest host"
else
  fail "with SENTRY_DSN: no Reporting-Endpoints for the ingest host"
fi
expect "with SENTRY_DSN: GET /api/readyz" 200 "$(status "$BASE/api/readyz")"

if [ "$failures" -ne 0 ]; then die "make image-smoke: $failures check(s) failed"; fi
log "make image-smoke: passed in $(elapsed)"

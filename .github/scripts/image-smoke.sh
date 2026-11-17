#!/usr/bin/env bash
# make image-smoke: the prod-image smoke test (ADR-0009, test-hooks.md §6).
# Migrates a throwaway Postgres with the migrate job image (make image-migrate),
# then runs the production image exactly as built (NODE_ENV comes from the
# image, no test hooks) with production-like config against it, and checks:
#   M. the migrate image holds only its allowlist (compiled migrate CLI, pg,
#      dbmate with this platform's binary, migrations/, roles.sql), refuses a
#      missing or insecure MIGRATOR_DATABASE_URL, bootstraps and migrates the
#      database, and re-runs the way the Cloud Run job does (MIGRATOR_DATABASE_URL
#      only) without printing any credential
#   1. the image holds only dist/, node_modules/, package.json and public/, the
#      test-hook sentinel appears nowhere in /app, and dist/ has no `_test` word;
#      nothing of db/ is anywhere in the image (no @shoestring package, seed,
#      testing or test-support code, migrations, roles.sql or dbmate)
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
#   B. the backup job image runs as non-root, holds bash, pg_dump (major >= 17),
#      age, curl and the CA bundle and exactly deploy/backup/backup.sh, refuses
#      missing config before doing anything, and with the read-only `backup`
#      role from db/roles.sql: its own entrypoint dumps and encrypts the
#      throwaway database (stopping at the upload, which needs GCP), and a
#      pg_dump | age round trip decrypts to a dump listing every table
# Builds any image first when it is not there yet (make image, make
# image-migrate, make image-backup).
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
migrate_tag="$(migrate_image_tag)"
if ! docker image inspect "$migrate_tag" >/dev/null 2>&1; then
  bash "$ROOT/.github/scripts/image-migrate.sh"
fi
backup_tag="$(backup_image_tag)"
if ! docker image inspect "$backup_tag" >/dev/null 2>&1; then
  bash "$ROOT/.github/scripts/image-backup.sh"
fi

export COMPOSE_PROJECT_NAME=shoestring-smoke
export POSTGRES_DB=shoestring_test
export POSTGRES_PORT="${SMOKE_POSTGRES_PORT:-55434}"
SMOKE_PORT="${SMOKE_PORT:-58080}"
APP_NAME="shoestring-smoke-app"
MIGRATE_NAME="shoestring-smoke-migrate"
BACKUP_NAME="shoestring-smoke-backup"
NETWORK="${COMPOSE_PROJECT_NAME}_default"
BASE="http://127.0.0.1:$SMOKE_PORT"
# Postgres only: migrations come from the migrate image, not the dev compose
# migrate service; no backend/frontend dev servers.
PROFILE_ARGS=()

# Fresh throwaway credentials, passed to containers by name (-e VAR), so values
# never appear in argv or logs.
export_throwaway_credentials
# The read-only backup role's password (db/roles.sql creates the role without
# one; the smoke sets it as the superuser before the backup checks).
BACKUP_DB_PASSWORD="$(rand_hex 24)"
export BACKUP_DB_PASSWORD
# Production-like config. APP_ORIGIN is a reserved .test name (RFC 6761); the
# database is the compose service (a local host, so no sslmode=verify-full).
# EMAIL_API_KEY is a dummy: nothing in the smoke sends email.
export APP_ORIGIN="https://shoestring.test"
export WEBAUTHN_RP_ID="shoestring.test"
export DATABASE_URL="postgres://app:${APP_DB_PASSWORD}@postgres:5432/$POSTGRES_DB"
# The migrate job's one variable, and the superuser URL for the local role
# bootstrap (never set in production, where the owner runs roles.sql once).
export MIGRATOR_DATABASE_URL="postgres://migrator:${MIGRATOR_DB_PASSWORD}@postgres:5432/$POSTGRES_DB"
export DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/$POSTGRES_DB"
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
# The image-content scans run as root with HARDEN plus the one capability that
# lets them list and read every file regardless of mode (for example the
# nonroot user's 0700 home), so no directory is skipped. Nothing is writable.
SCAN_HARDEN=("${HARDEN[@]}" --cap-add DAC_READ_SEARCH)

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
  docker rm -f "$APP_NAME" "$MIGRATE_NAME" "$BACKUP_NAME" shoestring-smoke-refuse >/dev/null 2>&1 || true
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

# F-43: the backend bundle inlines the data-access code it uses, so nothing of
# db/ belongs in the internet-facing image: no workspace package, seed, testing
# or test-support code, migrations, roles.sql or dbmate (its binary or package),
# by path anywhere in the filesystem, and no dbmate migration SQL in /app by
# content. Runs as root with SCAN_HARDEN (read-only, no network, only
# DAC_READ_SEARCH) so no directory is skipped.
db_scan='
const fs = require("node:fs"), path = require("node:path");
const SKIP = new Set(["/proc", "/sys", "/dev"]);
const NAME = /^(@shoestring|migrations|testing|test-support|seed)$|^seed\.|^roles\.sql$|dbmate/i;
const MIGRATION_SQL = /^-- migrate:(up|down)/m;
const found = [], unreadable = [];
let entries = 0;
const walk = (d) => {
  let list;
  try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { unreadable.push(d); return; }
  for (const e of list) {
    const p = path.join(d, e.name);
    if (SKIP.has(p)) continue;
    entries++;
    if (NAME.test(e.name)) found.push(p);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && p.startsWith("/app/") && MIGRATION_SQL.test(fs.readFileSync(p, "latin1"))) found.push(p);
  }
};
walk("/");
console.log(JSON.stringify({ entries, found, unreadable }));
'
db_contents="$(docker run --rm --network none "${SCAN_HARDEN[@]}" --user 0:0 --entrypoint /nodejs/bin/node "$tag" -e "$db_scan")"
db_found="$(printf '%s' "$db_contents" | jq -r '.found | join(" ")')"
db_unreadable="$(printf '%s' "$db_contents" | jq -r '.unreadable | join(" ")')"
db_entries="$(printf '%s' "$db_contents" | jq -r '.entries')"
# A scan that saw almost nothing proves nothing (the image has thousands of files).
if [ "$db_entries" -lt 1000 ]; then fail "db-content scan saw only $db_entries entries"; fi
if [ -n "$db_unreadable" ]; then fail "db-content scan could not read: $db_unreadable"; fi
if [ -z "$db_found" ]; then
  pass "no db/ content anywhere in the image ($db_entries entries: @shoestring, seed, testing, test-support, migrations, roles.sql, dbmate)"
else
  fail "db/ content in the runtime image: $db_found"
fi

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

# --- M. the migrate job image ---------------------------------------------------
log "Migrate image contents ($migrate_tag)"
migrate_scan='
const fs = require("node:fs"), path = require("node:path");
const SENTINEL = "__SHOESTRING_TEST_HOOKS__";
const allowed = new Set(["dist", "migrations", "node_modules", "package.json", "roles.sql"]);
const extra = fs.readdirSync("/app").filter((n) => !allowed.has(n));
const bad = [], distExtra = [], sentinel = [], binaries = [];
// Our seed/testing code anywhere outside node_modules; in node_modules no
// workspace package and no kysely (third-party packages may ship their own
// test helpers, for example pg-protocol/src/testing).
const OURS = /^(testing|test-support|seed)$|^seed\./, ANYWHERE = /^(@shoestring|kysely)$|^kysely@/;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (ANYWHERE.test(e.name) || (!p.startsWith("/app/node_modules/") && OURS.test(e.name))) bad.push(p);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;
    if (p.startsWith("/app/dist/") && !p.endsWith(".js")) distExtra.push(p);
    if (/\/@dbmate\/[^/]+\/bin\/dbmate$/.test(p)) binaries.push(p);
    if (fs.readFileSync(p, "latin1").includes(SENTINEL)) sentinel.push(p);
  }
};
walk("/app");
const want = "@dbmate/linux-" + process.arch + "/bin/dbmate";
const migrations = fs.readdirSync("/app/migrations").filter((n) => n.endsWith(".sql")).length;
console.log(JSON.stringify({ extra, bad, distExtra, sentinel, binaries, want,
  ok: binaries.length === 1 && binaries[0].endsWith(want), migrations,
  entry: fs.existsSync("/app/dist/cli/migrate.js") }));
'
m_contents="$(docker run --rm --network none "${SCAN_HARDEN[@]}" --user 0:0 --entrypoint /nodejs/bin/node "$migrate_tag" -e "$migrate_scan")"
m_field() { printf '%s' "$m_contents" | jq -r "$1"; }
if [ -z "$(m_field '.extra | join(" ")')" ]; then pass "migrate /app holds only dist, migrations, node_modules, package.json, roles.sql"; else fail "unexpected entries in migrate /app: $(m_field '.extra | join(" ")')"; fi
if [ -z "$(m_field '.bad | join(" ")')" ]; then pass "migrate image: no workspace package, seed, testing, test-support or kysely"; else fail "migrate image contains: $(m_field '.bad | join(" ")')"; fi
if [ -z "$(m_field '.distExtra | join(" ")')" ]; then pass "migrate dist/ holds only compiled JS (no maps, declarations or sources)"; else fail "migrate dist/ extras: $(m_field '.distExtra | join(" ")')"; fi
if [ -z "$(m_field '.sentinel | join(" ")')" ]; then pass "test-hook sentinel absent from the migrate image"; else fail "sentinel in migrate image: $(m_field '.sentinel | join(" ")')"; fi
if [ "$(m_field '.ok')" = true ]; then pass "exactly one dbmate binary, for this platform ($(m_field '.want'))"; else fail "dbmate binaries: $(m_field '.binaries | join(" ")'), want only $(m_field '.want')"; fi
expect "migrate image: compiled CLI present" true "$(m_field '.entry')"
n_sql="$(find "$ROOT/db/migrations" -name '*.sql' | grep -c . || true)"
expect "migrate image: migrations (db/migrations has $n_sql)" "$n_sql" "$(m_field '.migrations')"

# run_migrate <name> <docker args...>: runs the migrate image with its own
# entrypoint (no command or args, as the Cloud Run job does), hardened like the
# app. Sets m_rc and m_out. Credentials go in by name (-e VAR), never in argv.
run_migrate() {
  local name="$1"
  shift
  set +e
  m_out="$(docker run --rm --name "$name" "${HARDEN[@]}" "$@" "$migrate_tag" 2>&1)"
  m_rc=$?
  set -e
}
# no_secrets_in <label> <text>: none of this run's passwords or URLs was printed.
no_secrets_in() {
  local v leaked=""
  for v in POSTGRES_PASSWORD APP_DB_PASSWORD MIGRATOR_DB_PASSWORD BACKUP_DB_PASSWORD; do
    if printf '%s' "$2" | grep -qF "${!v}"; then leaked="$leaked $v"; fi
  done
  if [ -z "$leaked" ]; then pass "$1: no credential in the output"; else fail "$1: printed$leaked"; fi
}

log "Migrate image refusals (no database needed)"
run_migrate "$MIGRATE_NAME" --network none
if [ "$m_rc" -ne 0 ] && printf '%s' "$m_out" | grep -qF "MIGRATOR_DATABASE_URL is not set"; then
  pass "no MIGRATOR_DATABASE_URL: refused (exit $m_rc)"
else
  fail "no MIGRATOR_DATABASE_URL: expected a refusal (exit $m_rc)"
fi
# A remote host without sslmode=verify-full is refused before any connection (F-28, F-42).
# A dummy password: this URL is passed in argv and never reaches a server.
run_migrate "$MIGRATE_NAME" --network none \
  -e "MIGRATOR_DATABASE_URL=postgres://migrator:dummy-not-a-password@db.shoestring.test:5432/shoestring?sslmode=require"
if [ "$m_rc" -ne 0 ] && printf '%s' "$m_out" | grep -qF "must use sslmode=verify-full"; then
  pass "remote MIGRATOR_DATABASE_URL without verify-full: refused (exit $m_rc)"
else
  fail "remote MIGRATOR_DATABASE_URL without verify-full: expected a refusal (exit $m_rc)"
fi
no_secrets_in "refusal" "$m_out"

# --- B. the backup job image (no database needed) --------------------------------
log "Backup image ($backup_tag)"
# run_backup <docker args...> [-- <command args>]: runs the backup image hardened
# like the Cloud Run job would be (read-only root, in-memory /tmp). Sets b_rc
# and b_out.
run_backup() {
  set +e
  b_out="$(docker run --rm --name "$BACKUP_NAME" "${HARDEN[@]}" "$@" 2>&1)"
  b_rc=$?
  set -e
}
run_backup --network none --entrypoint id "$backup_tag" -u
if [ "$b_rc" -eq 0 ] && [ "$b_out" != 0 ]; then pass "backup image runs as uid $b_out (non-root)"; else fail "backup image uid: $b_out (exit $b_rc)"; fi
# Tools on PATH, the CA bundle (libpq's sslrootcert=system and curl), and the
# entrypoint script byte for byte from deploy/backup/ (owned by sre), not
# writable by the job user.
tools_check='
for c in bash pg_dump pg_restore age age-keygen curl; do command -v "$c" >/dev/null || echo "missing $c"; done
[ -s /etc/ssl/certs/ca-certificates.crt ] || echo "missing /etc/ssl/certs/ca-certificates.crt"
[ -w /usr/local/bin/backup.sh ] && echo "backup.sh is writable by uid $(id -u)"
echo "sha256 $(sha256sum /usr/local/bin/backup.sh | cut -d " " -f 1)"
echo "version $(pg_dump --version)"
'
run_backup --network none --entrypoint bash "$backup_tag" -c "$tools_check"
problems="$(printf '%s\n' "$b_out" | grep -E '^(missing|backup.sh is writable)' || true)"
if [ "$b_rc" -eq 0 ] && [ -z "$problems" ]; then
  pass "backup image: bash, pg_dump, pg_restore, age, age-keygen, curl, CA bundle"
else
  fail "backup image tools (exit $b_rc): $(printf '%s' "$problems" | paste -sd ';' -)"
fi
want_sum="$(_sha256 <"$ROOT/deploy/backup/backup.sh" | cut -d ' ' -f 1)"
expect "backup image: entrypoint is deploy/backup/backup.sh (sha256)" "$want_sum" \
  "$(printf '%s\n' "$b_out" | sed -n 's/^sha256 //p')"
pg_version="$(printf '%s\n' "$b_out" | sed -n 's/^version pg_dump (PostgreSQL) //p')"
pg_major="${pg_version%%.*}"
case "$pg_major" in
  '' | *[!0-9]*) fail "backup image: could not read the pg_dump version" ;;
  *) if [ "$pg_major" -ge 17 ]; then pass "backup image: pg_dump $pg_version (major >= 17)"; else fail "backup image: pg_dump $pg_version, need major >= 17 (Neon is 17)"; fi ;;
esac
# Missing required config: the entrypoint stops at once with a clear message,
# before any connection (no network at all here).
run_backup --network none "$backup_tag"
if [ "$b_rc" -ne 0 ] && printf '%s' "$b_out" | grep -qF "BACKUP_DATABASE_URL is required"; then
  pass "backup: no config, refused (exit $b_rc)"
else
  fail "backup: no config, expected \"BACKUP_DATABASE_URL is required\" (exit $b_rc)"
fi
run_backup --network none -e "BACKUP_DATABASE_URL=postgres://backup:dummy-not-a-password@db.shoestring.test/x" \
  -e BACKUP_BUCKET=shoestring-backups-smoke "$backup_tag"
if [ "$b_rc" -ne 0 ] && printf '%s' "$b_out" | grep -qF "BACKUP_AGE_RECIPIENT is required"; then
  pass "backup: no age recipient, refused (exit $b_rc)"
else
  fail "backup: no age recipient, expected \"BACKUP_AGE_RECIPIENT is required\" (exit $b_rc)"
fi

log "Starting throwaway Postgres (project $COMPOSE_PROJECT_NAME)"
compose_test up -d --wait --quiet-pull postgres >/dev/null
note "Postgres healthy after $(elapsed)"

# First run: the local bootstrap (roles.sql as superuser, role passwords from
# the URLs), standing in for the owner's one-time roles.sql in production.
log "Migrating with the migrate image ($migrate_tag): bootstrap run"
run_migrate "$MIGRATE_NAME" --network "$NETWORK" -e MIGRATOR_DATABASE_URL -e DATABASE_URL -e DATABASE_ADMIN_URL
printf '%s
' "$m_out" | sed 's/^/    | /'
no_secrets_in "bootstrap run" "$m_out"
if [ "$m_rc" -ne 0 ] || ! printf '%s' "$m_out" | grep -qx "migrate: done"; then
  die "the migrate image failed to migrate the throwaway database (exit $m_rc)"
fi
pass "bootstrap run: migrated (exit 0)"
# Second run exactly as the Cloud Run job: MIGRATOR_DATABASE_URL only. Nothing
# left to apply; roles.sql re-applies and verifies the grants as migrator.
log "Migrating again as the Cloud Run job does (MIGRATOR_DATABASE_URL only)"
run_migrate "$MIGRATE_NAME" --network "$NETWORK" -e MIGRATOR_DATABASE_URL
printf '%s
' "$m_out" | sed 's/^/    | /'
no_secrets_in "job-shaped run" "$m_out"
if [ "$m_rc" -eq 0 ] && printf '%s' "$m_out" | grep -qx "migrate: done"; then
  pass "job-shaped run: idempotent, grants verified (exit 0)"
else
  fail "job-shaped run failed (exit $m_rc)"
fi
note "Database migrated after $(elapsed)"

# --- B. backup against the migrated database --------------------------------------
log "Backup with the read-only backup role ($backup_tag)"
# roles.sql creates `backup` without a password (production sets it on Neon).
# Set this run's throwaway one as the superuser, through stdin (never argv).
printf "ALTER ROLE backup PASSWORD '%s';\n" "$BACKUP_DB_PASSWORD" |
  compose_test exec -T postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" >/dev/null
export BACKUP_DATABASE_URL="postgres://backup:${BACKUP_DB_PASSWORD}@postgres:5432/$POSTGRES_DB"
# 1. The real entrypoint, configured like the job (a throwaway public key, a
#    fake bucket). pg_dump | age must succeed and pass the size floor; the run
#    then stops at the access-token request, because the metadata server only
#    exists on GCP (pinned to this container's own closed port 80 here, so
#    nothing leaves the machine). Reaching that request proves the dump stage.
smoke_recipient="$(docker run --rm --network none "${HARDEN[@]}" --entrypoint bash "$backup_tag" \
  -c 'age-keygen 2>/dev/null | age-keygen -y')"
run_backup --network "$NETWORK" --add-host metadata.google.internal:127.0.0.1 \
  -e BACKUP_DATABASE_URL -e BACKUP_BUCKET=shoestring-backups-smoke -e "BACKUP_AGE_RECIPIENT=$smoke_recipient" \
  "$backup_tag"
printf '%s\n' "$b_out" | sed 's/^/    | /'
no_secrets_in "backup entrypoint" "$b_out"
if [ "$b_rc" -ne 0 ] && printf '%s' "$b_out" | grep -qF "metadata.google.internal" &&
  ! printf '%s' "$b_out" | grep -qE "smaller than|pg_dump:|age:"; then
  pass "backup entrypoint: dumped and encrypted, then stopped at the GCP token request (exit $b_rc)"
else
  fail "backup entrypoint: expected the dump to pass and the run to stop at the metadata server (exit $b_rc)"
fi
# 2. Round trip in one container: the same pg_dump flags as backup.sh piped
#    through age to a throwaway key in the in-memory /tmp, then decrypted
#    straight into pg_restore --list. Plaintext never touches a file.
roundtrip='
set -euo pipefail
umask 077
age-keygen -o /tmp/key 2>/dev/null
pg_dump --format=custom --no-owner --no-privileges --compress=6 --dbname="$BACKUP_DATABASE_URL" \
  | age --encrypt --recipient "$(age-keygen -y /tmp/key)" >/tmp/dump.age
echo "header $(head -c 21 /tmp/dump.age)"
echo "bytes $(wc -c </tmp/dump.age | tr -d " ")"
if grep -qa PGDMP /tmp/dump.age; then echo "plaintext dump marker in the ciphertext"; fi
age --decrypt --identity /tmp/key /tmp/dump.age | pg_restore --list >/tmp/toc
echo "tables $(grep -c " TABLE DATA public " /tmp/toc || true)"
'
run_backup --network "$NETWORK" -e BACKUP_DATABASE_URL --entrypoint bash "$backup_tag" -c "$roundtrip"
no_secrets_in "backup round trip" "$b_out"
n_tables="$(compose_test exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')"
b_field() { printf '%s\n' "$b_out" | sed -n "s/^$1 //p"; }
if [ "$b_rc" -ne 0 ]; then
  printf '%s\n' "$b_out" | sed 's/^/    | /'
  fail "backup round trip failed (exit $b_rc)"
else
  expect "backup round trip: age ciphertext" "age-encryption.org/v1" "$(b_field header)"
  if printf '%s' "$b_out" | grep -q "plaintext dump marker"; then fail "backup round trip: PGDMP marker in the ciphertext"; else pass "backup round trip: no plaintext marker in $(b_field bytes) encrypted bytes"; fi
  expect "backup round trip: decrypted dump lists every public table" "$n_tables" "$(b_field tables)"
fi

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

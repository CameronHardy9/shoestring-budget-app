#!/usr/bin/env bash
# make e2e: start a throwaway stack (separate compose project, tmpfs Postgres,
# TEST_HOOKS=1), apply migrations, run the tests/ suites, then tear down.
#
# Contract with tests/package.json (test-engineer):
#   "e2e"    integration + contract + e2e suites, run on the host against BASE_URL
#   "visual" screenshot suite, run inside the pinned Playwright container
# Environment passed to both: BASE_URL, APP_ORIGIN, DATABASE_URL,
# MIGRATOR_DATABASE_URL, DATABASE_ADMIN_URL (host ports), CI.
source "$(dirname "$0")/lib.sh"
require_node
require_docker

export COMPOSE_PROJECT_NAME=shoestring-e2e
export POSTGRES_DB=shoestring_test
# Fresh random passwords and keys for this run only; nothing is written to disk.
export_throwaway_credentials
export POSTGRES_PORT="${E2E_POSTGRES_PORT:-55433}"
export BACKEND_PORT="${E2E_BACKEND_PORT:-53000}"
export FRONTEND_PORT="${E2E_FRONTEND_PORT:-55173}"
if has_pkg frontend; then app_port=$FRONTEND_PORT; else app_port=$BACKEND_PORT; fi
export APP_ORIGIN="http://localhost:$app_port"
export BASE_URL="$APP_ORIGIN"
export DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
export MIGRATOR_DATABASE_URL="postgres://migrator:${MIGRATOR_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
export DATABASE_URL="postgres://app:${APP_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    log "make e2e failed (exit $rc): last stack logs"
    compose_test logs --no-color --tail=150 || true
  fi
  log "Tearing down e2e stack"
  compose_test down --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

log "Starting e2e stack (areas: $(active_areas_text); app at $APP_ORIGIN)"
compose_test up -d --build --remove-orphans --wait --wait-timeout 300
note "Stack healthy after $(elapsed)"

if ! has_pkg tests; then
  log "make e2e: no suites yet (tests/package.json does not exist)."
  note "The e2e stack started and passed its health checks; nothing else to run."
  exit 0
fi

ran=0
if has_script tests e2e; then
  log "Running tests: e2e (integration, contract, end-to-end) on the host"
  pnpm --filter ./tests run e2e
  ran=1
fi

if has_script tests visual; then
  img="$(tool_image playwright)"
  want="$(echo "$img" | sed -E 's/.*:v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
  have="$(cd tests && node -p 'require("@playwright/test/package.json").version' 2>/dev/null || echo unknown)"
  [ "$want" = "$have" ] ||
    die "Playwright image is v$want but tests/ has @playwright/test $have. Pin them to the same version (.github/tools/Dockerfile and tests/package.json)."
  pull_quiet "$img"
  log "Running tests: visual (screenshots) in $img"
  # Host networking so the browser uses the same origin (localhost) as the host
  # suites; works on Linux CI and on OrbStack. The image has no corepack, so the
  # pinned pnpm from package.json "packageManager" runs through npm exec. Runs as
  # root (writes to fresh volumes) and hands tests/ outputs back to your UID.
  docker run --rm --network host --ipc host --init \
    -e CI="${CI:-}" -e BASE_URL -e APP_ORIGIN -e DATABASE_URL -e MIGRATOR_DATABASE_URL \
    -e DATABASE_ADMIN_URL -e HOST_UID -e HOST_GID \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_store_dir=/app/node_modules/.pnpm-store \
    -v "$ROOT:/app" \
    -v shoestring_pw_node_modules:/app/node_modules \
    -v shoestring_pw_node_modules_tests:/app/tests/node_modules \
    -v shoestring_pw_node_modules_db:/app/db/node_modules \
    -w /app "$img" \
    bash -c 'pm="$(node -p "require(\"./package.json\").packageManager.split(\"+\")[0]")";
             pnpm() { npm exec --yes --package="$pm" -- pnpm "$@"; };
             pnpm install --frozen-lockfile --filter "./tests..." &&
             pnpm --filter ./tests run visual; rc=$?;
             chown -R "$HOST_UID:$HOST_GID" /app/tests 2>/dev/null; exit $rc'
  ran=1
fi

if [ "$ran" -eq 0 ]; then
  log "make e2e: no suites yet (tests/package.json has no \"e2e\" or \"visual\" script)."
  exit 0
fi
log "make e2e: done in $(elapsed)"

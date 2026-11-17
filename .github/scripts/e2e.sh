#!/usr/bin/env bash
# The e2e stack: separate compose project, tmpfs Postgres, TEST_HOOKS=1, and
# the e2e edge as the one trusted proxy hop (docker-compose.test.yml).
#
#   e2e.sh       make e2e       fresh stack, run the tests/ suites, tear down
#   e2e.sh up    make e2e-up    start (or reuse) a long-lived stack and write
#                               tests/.env.stack, which the suites read when
#                               APP_ORIGIN is not exported (tests/support/env.ts)
#   e2e.sh down  make e2e-down  stop it and delete tests/.env.stack
# The two never share a stack: make e2e uses project shoestring-e2e on ports
# 55xxx, make e2e-up uses shoestring-e2e-local on 56xxx, so make e2e never
# disturbs a stack started with make e2e-up (stop that one with make e2e-down).
#
# Contract with tests/package.json (test-engineer):
#   "e2e"    integration + contract + e2e suites, run on the host
#   "visual" screenshot suite, run inside the pinned Playwright container
# Environment passed to both: APP_ORIGIN, BASE_URL (= APP_ORIGIN, the edge in
# front of Vite), API_URL (the edge in front of the backend), BACKEND_PORT,
# DATABASE_URL, MIGRATOR_DATABASE_URL, DATABASE_ADMIN_URL (host ports),
# E2E_SENTRY_DSN (a fake DSN on a .test host), CI.
# The backend derives the client IP from the edge's X-Forwarded-For entry; a
# test acts as another client with X-E2E-Client-IP (.github/scripts/e2e-edge.mjs).
source "$(dirname "$0")/lib.sh"
require_docker

MODE="${1:-run}"
STACK_FILE="$ROOT/tests/.env.stack"

# stack_env <project> <postgres port> <backend port> <frontend port>
stack_env() {
  export COMPOSE_PROJECT_NAME="$1"
  export POSTGRES_DB=shoestring_test
  export POSTGRES_PORT="$2"
  export BACKEND_PORT="$3"
  export FRONTEND_PORT="$4"
  local app_port
  if has_pkg frontend; then app_port=$FRONTEND_PORT; else app_port=$BACKEND_PORT; fi
  export APP_ORIGIN="http://localhost:$app_port"
  export BASE_URL="$APP_ORIGIN"
  export API_URL="http://127.0.0.1:$BACKEND_PORT"
  # Fake Sentry DSN for suites that build the production SPA with one
  # (VITE_SENTRY_DSN) and intercept its host; see lib.sh.
  export E2E_SENTRY_DSN
}

# db_urls: the three database URLs on the host port (after the credentials).
db_urls() {
  export DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export MIGRATOR_DATABASE_URL="postgres://migrator:${MIGRATOR_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export DATABASE_URL="postgres://app:${APP_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
}

start_stack() {
  log "Starting e2e stack $COMPOSE_PROJECT_NAME (areas: $(active_areas_text); app at $APP_ORIGIN, API at $API_URL)"
  compose_test up -d --build --remove-orphans --wait --wait-timeout 300
  note "Stack healthy after $(elapsed)"
}

local_stack() {
  stack_env shoestring-e2e-local "${LOCAL_E2E_POSTGRES_PORT:-56433}" \
    "${LOCAL_E2E_BACKEND_PORT:-56000}" "${LOCAL_E2E_FRONTEND_PORT:-56173}"
}

case "$MODE" in
  up)
    local_stack
    if [ -f "$STACK_FILE" ]; then
      # Reuse the credentials the running stack was created with. Only the
      # credential lines: the file's URLs are recomputed below.
      for v in $CREDENTIAL_VARS; do
        val="$(sed -n "s/^$v=//p" "$STACK_FILE" | sed "s/^'\(.*\)'\$/\1/")"
        [ -n "$val" ] || die "tests/.env.stack has no $v. Run make e2e-down, then make e2e-up."
        export "$v=$val"
      done
    else
      export_throwaway_credentials
    fi
    db_urls
    start_stack
    (
      umask 077
      {
        echo "# Throwaway credentials of the local e2e stack (make e2e-up). Never commit."
        for v in $DB_PASSWORD_VARS; do echo "$v=${!v}"; done
        echo "APP_KEYRING='$APP_KEYRING'"
        for v in APP_ORIGIN BASE_URL API_URL BACKEND_PORT DATABASE_URL MIGRATOR_DATABASE_URL DATABASE_ADMIN_URL E2E_SENTRY_DSN; do
          echo "$v=${!v}"
        done
      } >"$STACK_FILE.tmp.$$"
      mv "$STACK_FILE.tmp.$$" "$STACK_FILE"
    )
    note "Wrote tests/.env.stack (mode 600). The suites find the stack through it."
    note "One file: pnpm --filter ./tests run api integration/paging.test.ts   Stop: make e2e-down"
    exit 0
    ;;
  down)
    local_stack
    stub_missing_credentials
    log "Stopping e2e stack $COMPOSE_PROJECT_NAME"
    docker compose "${COMPOSE_FILES[@]}" --profile '*' down --remove-orphans >/dev/null 2>&1 || true
    rm -f "$STACK_FILE"
    note "Stopped; tests/.env.stack deleted."
    exit 0
    ;;
  run) ;;
  *) die "usage: e2e.sh [run|up|down]" ;;
esac

# --- make e2e -------------------------------------------------------------------
require_node
stack_env shoestring-e2e "${E2E_POSTGRES_PORT:-55433}" "${E2E_BACKEND_PORT:-53000}" \
  "${E2E_FRONTEND_PORT:-55173}"
# Fresh random passwords and keys for this run only; nothing is written to disk.
export_throwaway_credentials
db_urls

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

start_stack

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
  # The filter "{./tests}..." installs tests/ AND its workspace dependencies
  # (db/), so db/node_modules is populated; "./tests..." would select tests/
  # alone and leave db/node_modules empty.
  docker run --rm --network host --ipc host --init \
    -e CI="${CI:-}" -e BASE_URL -e APP_ORIGIN -e API_URL -e BACKEND_PORT \
    -e DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ADMIN_URL -e E2E_SENTRY_DSN -e HOST_UID -e HOST_GID \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_store_dir=/app/node_modules/.pnpm-store \
    -v "$ROOT:/app" \
    -v shoestring_pw_node_modules:/app/node_modules \
    -v shoestring_pw_node_modules_tests:/app/tests/node_modules \
    -v shoestring_pw_node_modules_db:/app/db/node_modules \
    -w /app "$img" \
    bash -c 'pm="$(node -p "require(\"./package.json\").packageManager.split(\"+\")[0]")";
             pnpm() { npm exec --yes --package="$pm" -- pnpm "$@"; };
             pnpm install --frozen-lockfile --filter "{./tests}..." &&
             { [ -n "$(ls -A db/node_modules 2>/dev/null)" ] ||
               { echo "error: db/node_modules is empty after the install" >&2; false; }; } &&
             pnpm --filter ./tests run visual; rc=$?;
             chown -R "$HOST_UID:$HOST_GID" /app/tests 2>/dev/null; exit $rc'
  ran=1
fi

if [ "$ran" -eq 0 ]; then
  log "make e2e: no suites yet (tests/package.json has no \"e2e\" or \"visual\" script)."
  exit 0
fi
log "make e2e: done in $(elapsed)"

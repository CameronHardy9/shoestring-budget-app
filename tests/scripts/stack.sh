#!/usr/bin/env bash
# A long-lived copy of the `make e2e` stack, for running one suite or one test
# while you work on it (tests/CLAUDE.md "How to run one test"). make e2e itself
# never uses this: it starts and tears down its own stack.
#
#   bash tests/scripts/stack.sh up     start (or reuse) the stack, write tests/.env.stack
#   bash tests/scripts/stack.sh down   stop it and delete tests/.env.stack
#
# Same compose files, profiles and settings as .github/scripts/e2e.sh (TEST_HOOKS=1,
# EMAIL_TRANSPORT=test, tmpfs Postgres, no seed), under its own project name and
# ports, so it never touches your dev stack or a running make e2e.
# tests/.env.stack holds this stack's throwaway credentials (mode 600, gitignored
# by the root `.env.*` rule); the suites read it when BASE_URL is not set.
source "$(dirname "$0")/../../.github/scripts/lib.sh"
require_node
require_docker

export COMPOSE_PROJECT_NAME=shoestring-e2e-local
export POSTGRES_DB=shoestring_test
export POSTGRES_PORT="${LOCAL_E2E_POSTGRES_PORT:-56433}"
export BACKEND_PORT="${LOCAL_E2E_BACKEND_PORT:-56000}"
export FRONTEND_PORT="${LOCAL_E2E_FRONTEND_PORT:-56173}"
ENV_FILE="$ROOT/tests/.env.stack"

case "${1:-}" in
  up)
    if [ -f "$ENV_FILE" ]; then
      # Reuse the credentials the running stack was created with.
      set -a
      # shellcheck disable=SC1090
      source "$ENV_FILE"
      set +a
    else
      export_throwaway_credentials
    fi
    export APP_ORIGIN="http://localhost:$FRONTEND_PORT"
    log "Starting local e2e stack ($COMPOSE_PROJECT_NAME, app at $APP_ORIGIN)"
    compose_test up -d --build --remove-orphans --wait --wait-timeout 300
    (
      umask 077
      {
        echo "# Throwaway credentials of the local e2e stack (tests/scripts/stack.sh). Never commit."
        for v in POSTGRES_PASSWORD APP_DB_PASSWORD MIGRATOR_DB_PASSWORD; do echo "$v=${!v}"; done
        echo "APP_KEYRING='$APP_KEYRING'"
        echo "APP_ORIGIN=$APP_ORIGIN"
        echo "BASE_URL=$APP_ORIGIN"
        echo "API_URL=http://127.0.0.1:$BACKEND_PORT"
        echo "DATABASE_URL=postgres://app:${APP_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
        echo "MIGRATOR_DATABASE_URL=postgres://migrator:${MIGRATOR_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
        echo "DATABASE_ADMIN_URL=postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
      } >"$ENV_FILE"
    )
    note "Stack healthy after $(elapsed). Suites now find it through tests/.env.stack."
    note "Run one file: pnpm --filter ./tests run api integration/money-and-months.test.ts"
    ;;
  down)
    stub_missing_credentials
    log "Stopping local e2e stack ($COMPOSE_PROJECT_NAME)"
    compose_test down --remove-orphans >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
    ;;
  *)
    die "usage: bash tests/scripts/stack.sh up|down"
    ;;
esac

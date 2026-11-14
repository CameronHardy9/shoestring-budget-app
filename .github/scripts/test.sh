#!/usr/bin/env bash
# make test: each package's `test` script (unit tests).
# Once db/ exists, a throwaway Postgres (tmpfs) is started for the run, db's
# `migrate` script is applied, and the connection URLs are exported, so data
# access tests run against real Postgres exactly as in CI.
source "$(dirname "$0")/lib.sh"
require_node

if has_pkg db; then
  require_docker
  # One compose project and host port per run, so parallel runs (several
  # agents, or a second terminal) never stop each other's Postgres. Port 0 lets
  # Docker pick a free port; TEST_POSTGRES_PORT pins one when you need it.
  export COMPOSE_PROJECT_NAME="shoestring-test-$$"
  export POSTGRES_DB=shoestring_test POSTGRES_PORT="${TEST_POSTGRES_PORT:-0}"
  # Fresh random passwords for this run only; nothing is written to disk.
  export_throwaway_credentials
  # Only Postgres: no profiles for this project.
  PROFILE_ARGS=()
  cleanup() { compose_test down --remove-orphans >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  log "Starting throwaway Postgres for unit tests (project $COMPOSE_PROJECT_NAME)"
  compose_test up -d --wait postgres
  mapped="$(compose_test port postgres 5432)"
  POSTGRES_PORT="${mapped##*:}"
  case "$POSTGRES_PORT" in '' | *[!0-9]*) die "could not read the test Postgres port (got '$mapped')" ;; esac
  note "Postgres on 127.0.0.1:$POSTGRES_PORT"
  export DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export MIGRATOR_DATABASE_URL="postgres://migrator:${MIGRATOR_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export DATABASE_URL="postgres://app:${APP_DB_PASSWORD}@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  if has_script db migrate; then
    log "Applying migrations (db: migrate)"
    pnpm --filter ./db run migrate
  fi
fi

log "Unit tests: workspace packages ($(workspace_pkgs_text))"
pnpm -r --if-present run test
log "make test: done in $(elapsed)"

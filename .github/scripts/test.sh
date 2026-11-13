#!/usr/bin/env bash
# make test: each package's `test` script (unit tests).
# Once db/ exists, a throwaway Postgres (tmpfs) is started for the run, db's
# `migrate` script is applied, and the connection URLs are exported, so data
# access tests run against real Postgres exactly as in CI.
source "$(dirname "$0")/lib.sh"
require_node

if has_pkg db; then
  require_docker
  export COMPOSE_PROJECT_NAME=shoestring-test
  export POSTGRES_PASSWORD=postgres POSTGRES_DB=shoestring_test POSTGRES_PORT="${TEST_POSTGRES_PORT:-55432}"
  # Only Postgres: no profiles for this project.
  PROFILE_ARGS=()
  cleanup() { compose_test down --remove-orphans >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  log "Starting throwaway Postgres for unit tests (127.0.0.1:$POSTGRES_PORT)"
  compose_test up -d --wait postgres
  export DATABASE_ADMIN_URL="postgres://postgres:postgres@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export MIGRATOR_DATABASE_URL="postgres://migrator:migrator@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  export DATABASE_URL="postgres://app:app@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"
  if has_script db migrate; then
    log "Applying migrations (db: migrate)"
    pnpm --filter ./db run migrate
  fi
fi

log "Unit tests: workspace packages ($(workspace_pkgs_text))"
pnpm -r --if-present run test
log "make test: done in $(elapsed)"

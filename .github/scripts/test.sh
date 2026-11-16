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

# CPU budget. Vitest defaults every package to about cpus-1 workers, so running
# db, backend and frontend at once used to start roughly 3x the cores and the
# axe-heavy frontend tests slowed down more than 10x (5 s timeouts). Each
# package gets an equal share of the cores instead.
#   TEST_PKG_CONCURRENCY  packages tested at once (default: all with a test script)
#   TEST_MAX_WORKERS      Vitest workers per package (default: cpus / packages,
#                         rounded up, at least 2; 2 on GitHub's 4-vCPU runners)
cpu_count() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || node -p 'require("os").availableParallelism()'
}
test_pkgs=0
for a in frontend backend db tests; do has_script "$a" test && test_pkgs=$((test_pkgs + 1)); done
cpus="$(cpu_count)"
pkg_conc="${TEST_PKG_CONCURRENCY:-$test_pkgs}"
case "$pkg_conc" in 0) pkg_conc=1 ;; '' | *[!0-9]*) die "TEST_PKG_CONCURRENCY must be a positive integer" ;; esac
workers=$(((cpus + pkg_conc - 1) / pkg_conc))
[ "$workers" -ge 2 ] || workers=2
workers="${TEST_MAX_WORKERS:-$workers}"
case "$workers" in '' | 0 | *[!0-9]*) die "TEST_MAX_WORKERS must be a positive integer" ;; esac

# Per-run coverage directory (relative, so one per package): Vitest keeps its
# raw coverage in <reportsDirectory>/.tmp and deletes reportsDirectory at the
# start of a run, so two concurrent runs sharing coverage/ corrupt each other.
# coverage/ is gitignored, so lint and prettier never see it. Removed on exit.
COVERAGE_DIR="coverage/make-test-$$"
remove_coverage_dirs() {
  local a
  for a in frontend backend db tests; do
    if [ -d "$ROOT/$a/$COVERAGE_DIR" ]; then rm -rf "${ROOT:?}/$a/$COVERAGE_DIR"; fi
    rmdir "$ROOT/$a/coverage" 2>/dev/null || true
  done
}
if has_pkg db; then
  trap 'remove_coverage_dirs; cleanup' EXIT
else
  trap remove_coverage_dirs EXIT
fi

log "Unit tests: workspace packages ($(workspace_pkgs_text))"
note "$cpus CPUs: $pkg_conc package(s) at a time, $workers Vitest worker(s) each"
# pnpm's topological order starts backend only after db has finished, which
# keeps fewer packages competing at once without lengthening the run (frontend
# is the longest). pnpm forwards arguments after the script name to it (no
# `--`, which Vitest would read as a file filter). --coverage.* only
# configures; it does not turn coverage on in packages whose test script
# leaves it off.
pnpm -r --if-present --workspace-concurrency="$pkg_conc" run test \
  --maxWorkers="$workers" --coverage.reportsDirectory="$COVERAGE_DIR"
log "make test: done in $(elapsed)"

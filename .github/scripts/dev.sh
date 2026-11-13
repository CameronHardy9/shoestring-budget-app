#!/usr/bin/env bash
# make dev: start the whole local stack in containers and wait until healthy.
#   make dev          the app on http://localhost:<port> only
#   make dev LAN=1    also reachable from a phone on the same Wi-Fi
source "$(dirname "$0")/lib.sh"
require_docker

# First run: create .env with random local passwords (never overwrites one).
ensure_local_env

export FRONTEND_PORT="${FRONTEND_PORT:-5173}" BACKEND_PORT="${BACKEND_PORT:-3000}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"

if has_pkg frontend; then app_port=$FRONTEND_PORT; else app_port=$BACKEND_PORT; fi
host=localhost
if [ "${LAN:-0}" = "1" ]; then
  host="$(lan_ip)"
  [ -n "$host" ] || die "LAN=1 but no LAN IP was found (are you on Wi-Fi?)"
  export FRONTEND_BIND=0.0.0.0
fi
# The backend's CSRF check requires Origin to equal APP_ORIGIN exactly, so it
# follows the address the browser uses.
export APP_ORIGIN="${APP_ORIGIN:-http://$host:$app_port}"

log "Starting dev stack (areas: $(active_areas_text))"
compose_dev up -d --build --remove-orphans --wait --wait-timeout 300

log "make dev: stack is up and healthy in $(elapsed)"
note "Postgres   postgres://postgres@localhost:$POSTGRES_PORT/${POSTGRES_DB:-shoestring}   (password: POSTGRES_PASSWORD in .env)"
has_pkg backend && note "API        http://localhost:$BACKEND_PORT/api/healthz"
has_pkg frontend && note "App        http://localhost:$FRONTEND_PORT"
if [ "${LAN:-0}" = "1" ]; then
  note "Phone      $APP_ORIGIN   (same Wi-Fi; see: make help)"
fi
if [ "${#ACTIVE_AREAS[@]}" -eq 0 ]; then
  note "Only Postgres runs for now: frontend/, backend/ and db/ have no package.json yet."
  note "Their services start automatically once those packages exist."
fi
note "Logs: make dev-logs    Stop: make dev-down    Wipe data: make dev-reset"

#!/usr/bin/env bash
# make dev-down | dev-logs | dev-reset: manage the dev stack started by make dev.
# docker-compose.yml requires the credential variables even for `down` and
# `logs`, so any that neither .env nor the shell sets get a random stand-in
# (unused by these commands). This keeps them working after .env is deleted.
source "$(dirname "$0")/lib.sh"
require_docker
stub_missing_credentials

all_profiles=(--profile '*')
case "${1:-}" in
  down)
    docker compose -f docker-compose.yml "${all_profiles[@]}" down --remove-orphans
    ;;
  logs)
    docker compose -f docker-compose.yml "${all_profiles[@]}" logs -f --tail=100
    ;;
  reset)
    docker compose -f docker-compose.yml "${all_profiles[@]}" down --remove-orphans
    docker volume rm -f shoestring_pgdata >/dev/null
    echo "dev database deleted (re-created with the passwords in .env on the next make dev)"
    ;;
  *) die "usage: dev-ctl.sh down|logs|reset" ;;
esac

#!/usr/bin/env bash
# make setup: install every workspace package from the lockfile, plus the
# Playwright browsers once tests/ depends on @playwright/test.
source "$(dirname "$0")/lib.sh"
require_node

log "Installing workspace dependencies (pnpm $(pnpm --version), frozen lockfile)"
pnpm install --frozen-lockfile

if has_dep tests @playwright/test; then
  log "Installing Playwright browsers (chromium, webkit)"
  deps=()
  # System libraries need root; only CI (ephemeral runners) installs them.
  if [ "$(uname -s)" = Linux ] && [ "${CI:-}" = "true" ]; then deps=(--with-deps); fi
  pnpm --filter ./tests exec playwright install ${deps[@]+"${deps[@]}"} chromium webkit
else
  note "tests/ does not use Playwright yet: skipping browser install"
fi

log "Local credentials (.env)"
ensure_local_env

log "make setup: done in $(elapsed)"

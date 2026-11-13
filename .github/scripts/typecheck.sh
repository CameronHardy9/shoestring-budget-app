#!/usr/bin/env bash
# make typecheck: each package's `typecheck` script (tsc --noEmit or similar).
source "$(dirname "$0")/lib.sh"
require_node
log "Typecheck: workspace packages ($(workspace_pkgs_text))"
pnpm -r --if-present run typecheck
log "make typecheck: done in $(elapsed)"

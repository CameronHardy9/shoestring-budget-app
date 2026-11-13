#!/usr/bin/env bash
# make lint: each package's `lint` script, plus the pipeline's own files
# (Prettier on CI config, actionlint on workflows, shellcheck on these scripts).
source "$(dirname "$0")/lib.sh"
require_node

log "Lint: workspace packages ($(workspace_pkgs_text))"
pnpm -r --if-present run lint

log "Lint: CI and workspace config (Prettier)"
pnpm exec prettier --check .github package.json pnpm-workspace.yaml docker-compose*.yml

require_docker
img="$(tool_image actionlint)"
pull_quiet "$img"
log "Lint: GitHub workflows (actionlint + shellcheck)"
docker run --rm -v "$ROOT:/repo:ro" -w /repo "$img" -color
log "Lint: pipeline scripts (shellcheck)"
docker run --rm -v "$ROOT:/repo:ro" -w /repo --entrypoint shellcheck "$img" \
  --severity=warning --external-sources --source-path=.github/scripts .github/scripts/*.sh

log "make lint: done in $(elapsed)"

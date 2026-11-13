#!/usr/bin/env bash
# make image: build the production image (./Dockerfile), tagged with the git SHA.
# Skips cleanly until both backend/ and frontend/ packages exist.
source "$(dirname "$0")/lib.sh"
require_docker

if ! has_pkg backend || ! has_pkg frontend; then
  log "make image: skipped (needs backend/package.json and frontend/package.json; found: $(workspace_pkgs_text))"
  exit 0
fi

sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=""
[ -z "$(git status --porcelain 2>/dev/null)" ] || dirty="-dirty"
release="${APP_RELEASE:-$sha$dirty}"
tag="${IMAGE_NAME:-shoestring}:${sha:0:12}$dirty"

log "Building production image $tag (APP_RELEASE=$release)"
docker build --pull --build-arg APP_RELEASE="$release" --tag "$tag" .
uid="$(docker image inspect --format '{{.Config.User}}' "$tag")"
case "$uid" in "" | 0 | root | 0:*) die "image runs as root (User='$uid')" ;; esac
log "make image: built $tag (user $uid) in $(elapsed)"

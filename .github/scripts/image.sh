#!/usr/bin/env bash
# make image: build the production image (./Dockerfile), tagged with the git SHA.
# VITE_SENTRY_DSN (optional, public) is baked into the SPA; CI sets it on main.
# Skips cleanly until backend/ exists. Without frontend/ it builds an API-only
# image (no SPA): enough for make image-smoke, not a releasable artifact.
source "$(dirname "$0")/lib.sh"
require_docker

if ! has_pkg backend; then
  log "make image: skipped (needs backend/package.json; found: $(workspace_pkgs_text))"
  exit 0
fi

release="$(image_release)"
tag="$(image_tag)"
image_build_args "$release"

log "Building production image $tag (APP_RELEASE=$release, SPA Sentry DSN: $(dsn_summary "${VITE_SENTRY_DSN:-}"))"
docker build --pull "${IMAGE_PLAIN[@]}" "${IMAGE_BUILD_ARGS[@]}" --target runtime --tag "$tag" .
uid="$(docker image inspect --format '{{.Config.User}}' "$tag")"
case "$uid" in "" | 0 | root | 0:*) die "image runs as root (User='$uid')" ;; esac
env_node="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$tag" | grep -x 'NODE_ENV=production' || true)"
[ -n "$env_node" ] || die "image does not set NODE_ENV=production (test-hooks.md, ADR-0009)"
size="$(docker image inspect --format '{{.Size}}' "$tag" | awk '{ printf "%.0f MB", $1 / 1000000 }')"
log "make image: built $tag (user $uid, $size) in $(elapsed)"
has_pkg frontend || note "API-only image: frontend/ has no package.json yet, so there is no SPA in it."

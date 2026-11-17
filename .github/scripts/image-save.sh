#!/usr/bin/env bash
# CI only (the image job on main, after make image-smoke): hand the three images
# the smoke just tested to the publish job, unchanged.
#   - Tags each tested image with its GHCR name (lowercase; the repo slug has
#     capitals): ghcr.io/<owner>/<repo>[-migrate|-backup]:sha-<full sha>
#   - Saves all three to one gzip archive (the job uploads it as a short-lived
#     artifact; the images are public anyway once pushed).
#   - Writes each image ID to $GITHUB_OUTPUT. The publish job refuses to push
#     anything whose ID differs, and after the push it pulls each digest back
#     anonymously and checks the ID again.
# Refuses a dirty tree, a checkout other than GITHUB_SHA, and an app or migrate
# image whose revision label is not GITHUB_SHA (APP_RELEASE build argument).
# usage: image-save.sh <archive.tar.gz>
source "$(dirname "$0")/lib.sh"
require_docker

out="${1:?usage: image-save.sh <archive.tar.gz>}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set (CI only)}"
: "${GITHUB_SHA:?GITHUB_SHA is not set (CI only)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set (CI only)}"
[ -z "$(_git_dirty)" ] || die "the working tree is dirty: refusing to hand on images for publishing"
[ "$(_git_sha)" = "$GITHUB_SHA" ] || die "HEAD is $(_git_sha), not GITHUB_SHA $GITHUB_SHA"

repo_lc="$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
refs=()
# save_one <output name> <local tag> <ghcr suffix>
save_one() {
  local name="$1" tag="$2" ref="ghcr.io/$repo_lc$3:sha-$GITHUB_SHA" id rev
  docker image inspect "$tag" >/dev/null 2>&1 || die "$tag was not built (make image, image-migrate, image-backup)"
  rev="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")"
  [ "$rev" = "$GITHUB_SHA" ] || die "$tag has revision label '$rev', want $GITHUB_SHA"
  id="$(docker image inspect --format '{{.Id}}' "$tag")"
  docker tag "$tag" "$ref"
  refs+=("$ref")
  echo "${name}_id=$id" >>"$GITHUB_OUTPUT"
  note "$ref  $id"
}

log "Handing on the tested images for publishing"
save_one app "$(image_tag)" ""
save_one migrate "$(migrate_image_tag)" -migrate
save_one backup "$(backup_image_tag)" -backup
docker save "${refs[@]}" | gzip -1 >"$out"
size="$(wc -c <"$out" | awk '{ printf "%.0f MB", $1 / 1000000 }')"
log "image-save: $out ($size) in $(elapsed)"

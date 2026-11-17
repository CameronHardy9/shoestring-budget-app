#!/usr/bin/env bash
# make image-migrate: build the migrate job image (Dockerfile target `migrate`),
# tagged like the app image (lib.sh migrate_image_tag). It holds only node, the
# compiled migrate CLI, pg, dbmate with this platform's binary, db/migrations
# and db/roles.sql, and runs the migration with no command or args (reads
# MIGRATOR_DATABASE_URL). make image-smoke runs it against a throwaway Postgres.
# Skips cleanly until db/ exists.
source "$(dirname "$0")/lib.sh"
require_docker

if ! has_pkg db; then
  log "make image-migrate: skipped (needs db/package.json; found: $(workspace_pkgs_text))"
  exit 0
fi

release="$(image_release)"
tag="$(migrate_image_tag)"

log "Building migrate image $tag (APP_RELEASE=$release)"
docker build --pull --build-arg "APP_RELEASE=$release" --target migrate --tag "$tag" .
uid="$(docker image inspect --format '{{.Config.User}}' "$tag")"
case "$uid" in "" | 0 | root | 0:*) die "migrate image runs as root (User='$uid')" ;; esac
# The Cloud Run job sets no --command or --args: the image's own entrypoint
# must be the migration.
entry="$(docker image inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' "$tag")"
want='["/nodejs/bin/node","/app/dist/cli/migrate.js"] null'
[ "$entry" = "$want" ] || die "migrate image entrypoint/cmd is $entry, want $want"
size="$(docker image inspect --format '{{.Size}}' "$tag" | awk '{ printf "%.0f MB", $1 / 1000000 }')"
log "make image-migrate: built $tag (user $uid, $size) in $(elapsed)"

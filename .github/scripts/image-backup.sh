#!/usr/bin/env bash
# make image-backup: build the backup job image (Dockerfile.backup), tagged like
# the app image (lib.sh backup_image_tag). A pinned alpine with bash,
# postgresql17-client, age, curl and ca-certificates, a non-root user, and
# deploy/backup/backup.sh (owned by sre) as the entrypoint. The build context is
# deploy/backup/ only. make image-smoke runs it against a throwaway Postgres.
source "$(dirname "$0")/lib.sh"
require_docker

[ -f "$ROOT/Dockerfile.backup" ] || die "Dockerfile.backup is missing"
[ -f "$ROOT/deploy/backup/backup.sh" ] || die "deploy/backup/backup.sh is missing (owned by sre)"

release="$(image_release)"
tag="$(backup_image_tag)"

log "Building backup image $tag (revision $release)"
docker build --pull "${IMAGE_PLAIN[@]}" --build-arg "APP_RELEASE=$release" \
  --file Dockerfile.backup --tag "$tag" deploy/backup
uid="$(docker image inspect --format '{{.Config.User}}' "$tag")"
case "$uid" in "" | 0 | root | 0:* | root:*) die "backup image runs as root (User='$uid')" ;; esac
# The Cloud Run job sets no --command or --args: the entrypoint is the backup.
entry="$(docker image inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' "$tag")"
want='["/usr/local/bin/backup.sh"] null'
[ "$entry" = "$want" ] || die "backup image entrypoint/cmd is $entry, want $want"
size="$(docker image inspect --format '{{.Size}}' "$tag" | awk '{ printf "%.0f MB", $1 / 1000000 }')"
log "make image-backup: built $tag (user $uid, $size) in $(elapsed)"

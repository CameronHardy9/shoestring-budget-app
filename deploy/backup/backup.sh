#!/usr/bin/env bash
# Nightly encrypted database backup for Shoestring.
# Runs as the Cloud Run job `shoestring-backup`, triggered by Cloud Scheduler (docs/runbooks/README.md "Backup design").
# Owner: sre. Image: the small pinned backup image built by ci-engineer (Dockerfile.backup), never the app image.
#
# Environment:
#   BACKUP_DATABASE_URL   secret (Secret Manager `shoestring-backup-database-url`): read-only `backup` role,
#                         Neon DIRECT endpoint, sslmode=verify-full&sslrootcert=system
#   BACKUP_BUCKET         private bucket in the separate backup project (job SA has objectCreator only)
#   BACKUP_AGE_RECIPIENT  age PUBLIC key (not secret); the private key never exists in GCP or GitHub
#   BACKUP_HEARTBEAT_URL  optional Better Stack heartbeat URL (plain env; see infra/CLAUDE.md)
#   BACKUP_MIN_BYTES      optional sanity floor for the encrypted size (default 1024)
#
# Guarantees: plaintext only ever flows through the pg_dump | age pipe in memory. The only file written is the
# age-encrypted dump in /tmp, which is in-memory on Cloud Run. Logs contain the object name and byte count only.
# Never add `set -x` or print the URL, token or dump.

set -Eeuo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
HEARTBEAT="${BACKUP_HEARTBEAT_URL:-}"
MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"

log() { printf '{"severity":"%s","message":"%s","component":"backup"}\n' "$1" "$2"; }

heartbeat() {  # $1 = "" for success or "/fail"
  if [ -n "$HEARTBEAT" ]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "${HEARTBEAT}$1" || log WARNING "heartbeat ping failed"
  fi
}

enc=""
on_error() {
  local line="$1"
  trap - ERR
  [ -n "$enc" ] && rm -f "$enc"
  log ERROR "backup failed at line ${line}"
  heartbeat "/fail"
  exit 1
}
trap 'on_error $LINENO' ERR

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
object="daily/shoestring-${stamp}.dump.age"
object_encoded="${object//\//%2F}"

# 1. Dump and encrypt in one pipe. Only ciphertext reaches the file.
enc="$(mktemp /tmp/backup.XXXXXX)"
pg_dump --format=custom --no-owner --no-privileges --compress=6 --dbname="$BACKUP_DATABASE_URL" \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" > "$enc"

bytes="$(wc -c < "$enc" | tr -d ' ')"
if [ "$bytes" -lt "$MIN_BYTES" ]; then
  log ERROR "encrypted dump smaller than ${MIN_BYTES} bytes"
  false
fi

# 2. Access token for the job's own service account from the metadata server (no keys anywhere).
token="$(curl -fsS -m 10 -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')"
if [ -z "$token" ]; then
  log ERROR "could not obtain an access token"
  false
fi

# 3. Upload. ifGenerationMatch=0 means "create only, never overwrite", which objectCreator allows.
curl -fsS -m 300 -o /dev/null -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$enc" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BACKUP_BUCKET}/o?uploadType=media&ifGenerationMatch=0&name=${object_encoded}"
unset token

rm -f "$enc"
enc=""
log INFO "backup uploaded object=${object} bytes=${bytes}"
heartbeat ""

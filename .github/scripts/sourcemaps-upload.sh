#!/usr/bin/env bash
# make sourcemaps-upload: upload the SPA's source maps privately to Sentry for
# release APP_RELEASE (ARCHITECTURE "Error tracking", observability/README.md).
#
# CI runs it on main only, in the `sourcemaps` job (GitHub environment `sentry`).
# It skips cleanly (exit 0) until the owner has created the Sentry project, i.e.
# while SENTRY_AUTH_TOKEN is unset.
#   SENTRY_AUTH_TOKEN   secret: a Sentry organization auth token (Org Settings >
#                       Developer Settings > Organization Tokens; its one fixed
#                       scope is org:ci, releases and source-map upload only).
#                       GitHub environment secret of `sentry` (main only); never
#                       in .env, Cloud Run or the repo (bootstrap-production.md S6)
#   SENTRY_ORG          the org slug (GitHub variable)
#   SENTRY_PROJECT_WEB  the browser project slug, e.g. shoestring-web
#   VITE_SENTRY_DSN     the same value make image used (a different one changes
#                       the bundle, and the maps would not match the image)
#
# The maps come from the Dockerfile's `sourcemaps` stage, built with the same
# arguments as make image (image_build_args): in the same checkout the build
# stage is a cache hit and the files are the image's own; in CI's separate job
# it is a rebuild of the same commit from the same lockfile. They are written
# to the gitignored, dockerignored
# .sourcemaps/ and sent only to Sentry: never to a GitHub artifact (public on
# this repository), never into the image.
# Backend maps are not uploaded: the server runs with --enable-source-maps, so
# its stack traces already point at the TypeScript sources.
source "$(dirname "$0")/lib.sh"
require_docker

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  log "make sourcemaps-upload: skipped (SENTRY_AUTH_TOKEN is not set; the Sentry project does not exist yet)"
  exit 0
fi
[ -n "${SENTRY_ORG:-}" ] || die "SENTRY_ORG is not set (GitHub variable, the Sentry org slug)"
[ -n "${SENTRY_PROJECT_WEB:-}" ] || die "SENTRY_PROJECT_WEB is not set (GitHub variable, the browser project slug)"
has_pkg frontend || die "frontend/ has no package.json: there is no SPA to upload maps for"

release="$(image_release)"
case "$release" in
  *-dirty* | dev | "") die "refusing to upload maps for release '$release': only a clean commit has a release Sentry events can match" ;;
esac
image_build_args "$release"

OUT="$ROOT/.sourcemaps"
log "Extracting the SPA's source maps for release $release (SPA Sentry DSN: $(dsn_summary "${VITE_SENTRY_DSN:-}"))"
# A fresh directory each time: stale maps from an older build must not upload.
rm -rf "$OUT"
docker build "${IMAGE_BUILD_ARGS[@]}" --target sourcemaps --output "type=local,dest=$OUT" .
n_maps="$(find "$OUT" -name '*.map' | wc -l | tr -d ' ')"
[ "$n_maps" -gt 0 ] || die "the sourcemaps stage holds no .map files (frontend build: sourcemap \"hidden\")"
note "$n_maps source maps"

img="$(tool_image sentry-cli)"
pull_quiet "$img"
log "Uploading to Sentry ($SENTRY_ORG/$SENTRY_PROJECT_WEB, release $release)"
# The token goes to the container by name (-e VAR), never in argv or logs.
# Files are named ~/assets/<file>, which matches https://<any host>/assets/<file>.
# The SPA's SDK must report `release` = VITE_APP_RELEASE (= APP_RELEASE).
sentry() {
  docker run --rm -e SENTRY_AUTH_TOKEN -e SENTRY_ORG \
    -e "SENTRY_PROJECT=$SENTRY_PROJECT_WEB" -v "$OUT:/maps:ro" -w /maps "$img" "$@"
}
sentry releases new "$release"
# '~/' is Sentry's literal "any scheme and host" prefix, not a home directory.
# shellcheck disable=SC2088
sentry sourcemaps upload --release "$release" --url-prefix '~/' --validate --wait /maps
sentry releases finalize "$release"
log "make sourcemaps-upload: uploaded $n_maps maps for $release in $(elapsed)"

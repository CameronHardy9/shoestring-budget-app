#!/usr/bin/env bash
# make setup: install every workspace package from the lockfile, plus the
# Playwright browsers once tests/ depends on @playwright/test.
#   SKIP_BROWSERS=1   skip the browsers (CI jobs that run no Playwright: check)
# On Linux CI it also installs the browsers' system packages (--with-deps)
# through a .deb cache that the e2e job keeps with actions/cache
# (PLAYWRIGHT_APT_CACHE), so a slow Ubuntu mirror costs only `apt-get update`.
# apt itself trusts a cached .deb whose SIZE matches the index (no hash check),
# so ci_apt_cache deletes every cached file whose SHA256 is not the one in the
# freshly updated, signed index before apt or dpkg sees it (F-69).
source "$(dirname "$0")/lib.sh"
require_node

log "Installing workspace dependencies (pnpm $(pnpm --version), frozen lockfile)"
pnpm install --frozen-lockfile

# ci_apt_cache <dir>: point apt's download cache at <dir>, add retries, and
# keep only cached .debs that match the signed index byte for byte: a regular
# file named <pkg>_<ver>_<arch>.deb (as apt names it, ":" as "%3a") whose
# SHA256 is the index's for that pkg:arch=ver. Everything else (no index
# entry, wrong hash, symlinks, directories, partial downloads) is deleted and
# downloaded again. playwright's own `apt-get update` afterwards is harmless:
# a published version never changes its contents.
ci_apt_cache() {
  local dir="$1" deb pkg ver arch sum idx kept=0 dropped=0
  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then rm -f -- "$dir"; fi
  mkdir -p "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 \( ! -type f -o ! -name '*.deb' \) -exec rm -rf -- {} +
  mkdir "$dir/partial"
  printf '%s\n' \
    "Dir::Cache::Archives \"$dir/\";" \
    'APT::Keep-Downloaded-Packages "true";' \
    'Acquire::Retries "3";' \
    'Acquire::http::Timeout "30";' |
    sudo tee /etc/apt/apt.conf.d/99-shoestring-ci >/dev/null
  sudo apt-get update -qq
  for deb in "$dir"/*.deb; do
    [ -f "$deb" ] || continue
    idx=""
    if IFS=' ' read -r pkg ver arch < <(dpkg-deb -W --showformat='${Package} ${Version} ${Architecture}\n' "$deb" 2>/dev/null) &&
      [ "${deb##*/}" = "${pkg}_${ver//:/%3a}_${arch}.deb" ]; then
      idx="$(apt-cache show "$pkg:$arch=$ver" 2>/dev/null || true)"
    fi
    sum="$(sha256sum "$deb" | cut -d' ' -f1)"
    if [ -n "$idx" ] && printf '%s\n' "$idx" | grep -qx "SHA256: $sum"; then
      kept=$((kept + 1))
    else
      rm -f -- "$deb"
      dropped=$((dropped + 1))
    fi
  done
  note "apt package cache: $dir ($kept .debs match the signed index, $dropped deleted)"
}

if [ "${SKIP_BROWSERS:-}" = 1 ]; then
  note "SKIP_BROWSERS=1: skipping the Playwright browser install"
elif has_dep tests @playwright/test; then
  log "Installing Playwright browsers (chromium, webkit)"
  deps=()
  apt_cache=""
  # System libraries need root; only CI (ephemeral runners) installs them.
  if [ "$(uname -s)" = Linux ] && [ "${CI:-}" = "true" ]; then
    deps=(--with-deps)
    apt_cache="${PLAYWRIGHT_APT_CACHE:-$HOME/.cache/playwright-apt}"
    ci_apt_cache "$apt_cache"
  fi
  pnpm --filter ./tests exec playwright install ${deps[@]+"${deps[@]}"} chromium webkit
  if [ -n "$apt_cache" ]; then
    # Drop .debs the mirror no longer serves, and make the rest (and apt's
    # root-owned lock file) readable for the cache save.
    sudo apt-get autoclean -qq
    sudo chown -R "$HOST_UID:$HOST_GID" "$apt_cache"
    note "apt package cache: $(du -sh "$apt_cache" | cut -f1) after the install"
  fi
else
  note "tests/ does not use Playwright yet: skipping browser install"
fi

log "Local credentials (.env)"
ensure_local_env

log "make setup: done in $(elapsed)"

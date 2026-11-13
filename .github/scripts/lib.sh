#!/usr/bin/env bash
# Shared helpers for the Makefile targets. Sourced by the other scripts.
# Everything here works with zero area packages and picks up frontend/, backend/,
# db/ and tests/ automatically once they have a package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_UID HOST_GID

TOOLS_FILE="$ROOT/.github/tools/Dockerfile"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.test.yml)

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

# Timing for the final line of each target.
_START_TS=$SECONDS
elapsed() { echo "$((SECONDS - _START_TS))s"; }

has_pkg() { [ -f "$ROOT/$1/package.json" ]; }

# has_script <area> <script-name>
has_script() {
  has_pkg "$1" && node -e '
    const p = require(process.argv[1]);
    process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1);
  ' "$ROOT/$1/package.json" "$2"
}

# has_dep <area> <package-name>  (dependencies or devDependencies)
has_dep() {
  has_pkg "$1" && node -e '
    const p = require(process.argv[1]);
    const all = { ...p.dependencies, ...p.devDependencies };
    process.exit(all[process.argv[2]] ? 0 : 1);
  ' "$ROOT/$1/package.json" "$2"
}

require_node() {
  command -v node >/dev/null || die "Node is not on PATH. Run: nvm install && nvm use   (reads .nvmrc)"
  local want have
  want="$(tr -d '[:space:]v' <"$ROOT/.nvmrc")"
  have="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$have" = "${want%%.*}" ] ||
    die "Node $want is required, found $(node -v). Run: nvm use   (or once: nvm alias default $want)"
  command -v pnpm >/dev/null || die "pnpm is not on PATH. Run: corepack enable"
}

require_docker() {
  command -v docker >/dev/null || die "Docker is not installed. Install OrbStack: https://orbstack.dev"
  docker info >/dev/null 2>&1 || die "Docker is not running. Start OrbStack and retry."
}

# tool_image <stage-name>: the pinned image for a tool in .github/tools/Dockerfile
tool_image() {
  local img
  img="$(awk -v n="$1" '$1 == "FROM" && $NF == n { print $2 }' "$TOOLS_FILE")"
  [ -n "$img" ] || die "no image named '$1' in $TOOLS_FILE"
  echo "$img"
}

# Pull quietly so CI logs stay readable; a no-op when the image is cached.
pull_quiet() {
  docker image inspect "$1" >/dev/null 2>&1 || docker pull --quiet "$1" >/dev/null
}

# Compose profiles for the areas that exist (see docker-compose.yml).
PROFILE_ARGS=()
ACTIVE_AREAS=()
for _area in db backend frontend; do
  if has_pkg "$_area"; then
    PROFILE_ARGS+=(--profile "$_area")
    ACTIVE_AREAS+=("$_area")
  fi
done
unset _area

active_areas_text() {
  if [ "${#ACTIVE_AREAS[@]}" -eq 0 ]; then echo "none yet"; else echo "${ACTIVE_AREAS[*]}"; fi
}

lan_ip() {
  local ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    for ifc in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$ifc" 2>/dev/null || true)"
      [ -n "$ip" ] && break
    done
  fi
  if [ -z "$ip" ] && [ "$(uname -s)" = Linux ]; then
    ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  fi
  echo "$ip"
}

# Compose wrappers. The ${arr[@]+...} form keeps bash 3.2 (macOS) happy with
# empty arrays under `set -u`.
compose_dev() {
  docker compose -f docker-compose.yml ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} "$@"
}
compose_test() {
  docker compose "${COMPOSE_FILES[@]}" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} "$@"
}

# Workspace packages that exist (for log messages).
workspace_pkgs_text() {
  local out="" a
  for a in frontend backend db tests; do has_pkg "$a" && out="$out $a"; done
  if [ -z "$out" ]; then echo "none yet"; else echo "${out# }"; fi
}

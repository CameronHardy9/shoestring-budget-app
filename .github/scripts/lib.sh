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

# --- Local credentials ---------------------------------------------------------
# No password or key is ever written in the repo. docker-compose.yml requires
# these variables (${VAR:?}) and gets them from one of two places:
#   make setup / make dev   a gitignored .env, generated once with random values
#   make test / make e2e    fresh throwaway values exported for that run only
# Passwords are hex (safe inside a postgres:// URL without escaping).
# APP_KEYRING follows docs/contracts/data-model.md ("Application keyring"): JSON
# with one key "k1" of 32 random bytes, base64.
DB_PASSWORD_VARS="POSTGRES_PASSWORD APP_DB_PASSWORD MIGRATOR_DB_PASSWORD"
CREDENTIAL_VARS="$DB_PASSWORD_VARS APP_KEYRING"
LOCAL_ENV_FILE="$ROOT/.env"

rand_hex() { # rand_hex <bytes>
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
  fi
}
rand_b64() { # rand_b64 <bytes>
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\n'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n'
  fi
}

rand_keyring() { printf '{"current":"k1","keys":{"k1":"%s"}}' "$(rand_b64 32)"; }

# Export fresh random values for every credential variable (make test, make e2e).
# Values exported here take precedence over a developer's .env.
export_throwaway_credentials() {
  local v val
  for v in $DB_PASSWORD_VARS; do
    val="$(rand_hex 24)"
    export "$v=$val"
  done
  APP_KEYRING="$(rand_keyring)"
  export APP_KEYRING
}

# Compose interpolates the whole file even for `down` and `logs`, which never
# use these values. Fill only the unset ones with random values so those
# commands work without a .env; anything in .env or the shell is left alone.
stub_missing_credentials() {
  local v val
  for v in $CREDENTIAL_VARS; do
    if [ -z "${!v:-}" ] && ! env_file_has "$v"; then
      val="$(rand_hex 16)"
      export "$v=$val"
    fi
  done
}

env_file_has() { [ -f "$LOCAL_ENV_FILE" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1=." "$LOCAL_ENV_FILE"; }

# Create .env with random local credentials if it does not exist. Never
# overwrites or edits an existing file; reports any variable it lacks instead.
ensure_local_env() {
  local v missing=""
  if [ -e "$LOCAL_ENV_FILE" ]; then
    for v in $CREDENTIAL_VARS; do
      [ -n "${!v:-}" ] || env_file_has "$v" || missing="$missing $v"
    done
    if [ -n "$missing" ]; then
      die ".env exists but does not set:$missing
       It is never edited automatically. Either add the missing lines, e.g.
         echo \"APP_DB_PASSWORD=\$(openssl rand -hex 24)\" >> .env
       (APP_KEYRING: see .env.example), or move .env aside and run make setup
       to generate a new one (then make dev-reset, since the dev database keeps
       the passwords it was created with)."
    fi
    note ".env exists: keeping your local credentials"
    return 0
  fi
  (
    umask 077
    {
      echo "# Local-only credentials for the dev stack, generated by make setup on $(date -u +%Y-%m-%d)."
      echo "# Gitignored. Never commit, share or reuse these. See .env.example for every variable."
      echo "# The dev database keeps the passwords it was first created with: if you change"
      echo "# or delete this file, run make dev-reset (wipes local dev data)."
      for v in $DB_PASSWORD_VARS; do echo "$v=$(rand_hex 24)"; done
      # Single quotes: compose reads the JSON literally.
      echo "APP_KEYRING='$(rand_keyring)'"
      # Optional (not in CREDENTIAL_VARS): sign-in password of the seed users,
      # read it here to sign in as them. Never printed.
      echo "SEED_USER_PASSWORD=$(rand_hex 16)"
    } >"$LOCAL_ENV_FILE.tmp.$$"
    mv "$LOCAL_ENV_FILE.tmp.$$" "$LOCAL_ENV_FILE"
  )
  note "Generated .env with random local passwords and keys (gitignored, mode 600)"
  if command -v docker >/dev/null 2>&1 && docker volume inspect shoestring_pgdata >/dev/null 2>&1; then
    note "warning: a dev database already exists and was created with other passwords."
    note "         Run make dev-reset once (wipes local dev data) so it uses the new ones."
  fi
}

# Workspace packages that exist (for log messages).
workspace_pkgs_text() {
  local out="" a
  for a in frontend backend db tests; do has_pkg "$a" && out="$out $a"; done
  if [ -z "$out" ]; then echo "none yet"; else echo "${out# }"; fi
}

#!/usr/bin/env bash
# make audit: secrets (gitleaks), static analysis (Semgrep CE), dependency
# vulnerabilities (osv-scanner) and workflow security (zizmor). Every tool runs
# from a pinned image in .github/tools/Dockerfile, so local runs match CI and
# nothing extra needs installing. All four always run; the target fails if any
# of them finds a high-severity (or worse) issue.
#
# Severity gates:
#   gitleaks     any finding fails (a leaked secret is always critical)
#   semgrep      ERROR / HIGH / CRITICAL fail; WARNING / MEDIUM and below are reported
#   osv-scanner  CVSS >= 7.0 fails, and so does a vulnerability with no score
#                (for example a malicious-package MAL- advisory)
#   zizmor       high fails; lower findings are reported
source "$(dirname "$0")/lib.sh"
require_docker
command -v jq >/dev/null || die "jq is required (brew install jq)"

OUT="$ROOT/.audit"
mkdir -p "$OUT"
declare -a SUMMARY=()
failed=0
record() { # record <tool> <PASS|FAIL> <detail>
  SUMMARY+=("$(printf '%-12s %-4s  %s' "$1" "$2" "$3")")
  [ "$2" = "FAIL" ] && failed=1
  return 0
}
as_user=(--user "$HOST_UID:$HOST_GID" -e HOME=/tmp)

for t in gitleaks semgrep osv-scanner zizmor; do pull_quiet "$(tool_image "$t")"; done

# --- gitleaks: full git history, then the working tree ------------------------
GL="$(tool_image gitleaks)"
log "gitleaks: git history"
git_safe=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
if [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then
  commits="$(git rev-list --all --count 2>/dev/null || echo 0)"
  if docker run --rm "${git_safe[@]}" -v "$ROOT:/repo:ro" "$GL" \
    git --redact --no-banner --log-level warn -v /repo; then
    record gitleaks PASS "history: $commits commits, no leaks"
  else
    record gitleaks FAIL "history: leaks found (output above, values redacted)"
  fi
else
  record gitleaks FAIL "not a git repository; history was not scanned"
fi

# Working tree: every file git would commit (tracked + untracked, minus
# .gitignore'd files such as .env and node_modules), including uncommitted edits.
log "gitleaks: working tree (files not ignored by .gitignore)"
nfiles=0
tree_list="$OUT/gitleaks-files.txt"
: >"$tree_list"
while IFS= read -r -d '' f; do
  if [ -f "$f" ]; then
    printf '%s\0' "$f" >>"$tree_list"
    nfiles=$((nfiles + 1))
  fi
done < <(git ls-files -z --cached --others --exclude-standard)
if tar --null -T "$tree_list" -cf - | docker run --rm -i --entrypoint sh "$GL" -c \
  'mkdir -p /scan && tar -xf - -C /scan && gitleaks dir --redact --no-banner --log-level warn -v /scan'; then
  record gitleaks PASS "working tree: $nfiles files, no leaks"
else
  record gitleaks FAIL "working tree: leaks found (output above, values redacted)"
fi
rm -f "$tree_list"

# --- Semgrep CE ---------------------------------------------------------------
# Registry rulesets (fetched at run time) plus project rules in .github/semgrep.
log "semgrep: static analysis"
semgrep_configs=(
  --config p/default --config p/typescript --config p/react --config p/nodejs
  --config p/dockerfile --config p/docker-compose --config p/github-actions
  --config .github/semgrep
)
# Semgrep's built-in .semgrepignore skips any tests/ directory, which would leave
# test-engineer's suites unscanned (and the project rules that apply to tests/,
# such as shoestring-db-internal-import, silent). Files named explicitly are
# always scanned, so pass every file under tests/ that git would commit.
declare -a semgrep_extra=()
while IFS= read -r -d '' f; do
  [ -f "$f" ] && semgrep_extra+=("$f")
done < <(git ls-files -z --cached --others --exclude-standard -- tests)
set +e
docker run --rm "${as_user[@]}" -e SEMGREP_SEND_METRICS=off \
  -v "$ROOT:/src:ro" -v "$OUT:/out" -w /src "$(tool_image semgrep)" \
  semgrep scan --metrics=off --disable-version-check --quiet \
  "${semgrep_configs[@]}" --text --json-output=/out/semgrep.json \
  . ${semgrep_extra[@]+"${semgrep_extra[@]}"}
sg_rc=$?
set -e
if [ "$sg_rc" -ne 0 ] || [ ! -s "$OUT/semgrep.json" ]; then
  record semgrep FAIL "scanner error (exit $sg_rc)"
else
  sg_errors="$(jq '[.errors[]? | select(.level == "error")] | length' "$OUT/semgrep.json")"
  sg_high="$(jq '[.results[] | select(.extra.severity | IN("ERROR","HIGH","CRITICAL"))] | length' "$OUT/semgrep.json")"
  sg_all="$(jq '.results | length' "$OUT/semgrep.json")"
  if [ "$sg_high" -gt 0 ]; then
    record semgrep FAIL "$sg_high high-severity of $sg_all findings"
  elif [ "$sg_errors" -gt 0 ]; then
    record semgrep FAIL "$sg_errors scan errors (see $OUT/semgrep.json)"
  else
    record semgrep PASS "$sg_all findings, none high-severity"
  fi
fi

# --- osv-scanner: pnpm-lock.yaml ----------------------------------------------
log "osv-scanner: dependencies in pnpm-lock.yaml"
set +e
docker run --rm "${as_user[@]}" -v "$ROOT:/src:ro" "$(tool_image osv-scanner)" \
  scan source --lockfile /src/pnpm-lock.yaml --format json >"$OUT/osv.json" 2>"$OUT/osv.log"
osv_rc=$?
set -e
# Exit 0 = no vulnerabilities, 1 = vulnerabilities found; anything else is an error.
if [ "$osv_rc" -gt 1 ] || ! jq -e . "$OUT/osv.json" >/dev/null 2>&1; then
  cat "$OUT/osv.log" >&2
  record osv-scanner FAIL "scanner error (exit $osv_rc)"
else
  groups='[.results[]?.packages[]? as $p | $p.groups[]? |
            {pkg: "\($p.package.name)@\($p.package.version)", ids: (.aliases // .ids),
             sev: (.max_severity // "")}]'
  jq -r "$groups | .[] | \"    \(.pkg)  severity \(if .sev == \"\" then \"unknown\" else .sev end)  \(.ids | join(\", \"))\"" "$OUT/osv.json"
  total="$(jq "$groups | length" "$OUT/osv.json")"
  high="$(jq "$groups | map(select(.sev == \"\" or (.sev | tonumber) >= 7)) | length" "$OUT/osv.json")"
  pkgs="$(grep -Eo 'found [0-9]+ packages?' "$OUT/osv.log" | head -1 || true)"
  if [ "$high" -gt 0 ]; then
    record osv-scanner FAIL "$high high/critical/unscored of $total vulnerabilities"
  else
    record osv-scanner PASS "${pkgs:-lockfile scanned}, $total vulnerabilities, none high"
  fi
fi

# --- zizmor: GitHub Actions workflows and Dependabot config --------------------
log "zizmor: workflow security"
ZZ="$(tool_image zizmor)"
zz_common=(--offline --no-progress --persona regular)
docker run --rm "${as_user[@]}" -v "$ROOT:/repo:ro" -w /repo "$ZZ" \
  "${zz_common[@]}" --no-exit-codes --color always . || true
set +e
docker run --rm "${as_user[@]}" -v "$ROOT:/repo:ro" -w /repo "$ZZ" \
  "${zz_common[@]}" --min-severity high --format json . >"$OUT/zizmor-high.json" 2>"$OUT/zizmor.log"
zz_rc=$?
set -e
zz_high="$(jq 'length' "$OUT/zizmor-high.json" 2>/dev/null || echo error)"
if [ "$zz_high" = "error" ]; then
  cat "$OUT/zizmor.log" >&2
  record zizmor FAIL "scanner error (exit $zz_rc)"
elif [ "$zz_high" -gt 0 ]; then
  record zizmor FAIL "$zz_high high-severity findings"
else
  record zizmor PASS "no high-severity findings"
fi

log "make audit summary ($(elapsed))"
for line in "${SUMMARY[@]}"; do note "$line"; done
note "Reports: .audit/ (gitignored)"
if [ "$failed" -ne 0 ]; then die "make audit failed: fix the findings above (never dismiss them to get green)."; fi
log "make audit: passed"

#!/usr/bin/env bash
# Sentry scrubber canary (owner-run; docs/runbooks/sentry-data-check.md "Canary").
#
# Sends ONE synthetic event, containing only made-up values, to a Sentry project.
# It proves that the org's Security & Privacy settings remove what they must
# (F-07), and that the DSN, project and network path work. It never touches
# Cloud Run, the database or any real user data.
#
#   SENTRY_CANARY_DSN="<project DSN>" deploy/scripts/sentry-canary.sh            # print only
#   SENTRY_CANARY_DSN="<project DSN>" APPLY=1 deploy/scripts/sentry-canary.sh    # send
#
# A DSN is not a secret (it ships in the SPA bundle), but keep it out of the repo.
# Environment "smoke" and level "info" keep the production alert rules quiet.
#
# Every value that the scrubber must remove starts with "SSCANARY". One control
# value "SSCONTROL-<id>" must survive, which proves the event was stored and that
# the check below can see it. Pass: in the stored event's JSON, SSCANARY appears
# 0 times, SSCONTROL appears at least once, and user.ip_address and user.geo are absent.
set -euo pipefail

dsn="${SENTRY_CANARY_DSN:-}"
if [[ -z "$dsn" ]]; then
  echo "error: set SENTRY_CANARY_DSN to the project's DSN (Sentry → project → Settings → Client Keys)" >&2
  exit 2
fi
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }
command -v openssl >/dev/null || { echo "error: openssl is required" >&2; exit 2; }

# DSN: https://<public_key>@<host>/<project_id>
re='^https://([0-9a-f]+)@([A-Za-z0-9.-]+)/([0-9]+)$'
if [[ ! "$dsn" =~ $re ]]; then
  echo "error: DSN does not look like https://<key>@<host>/<project id>" >&2
  exit 2
fi
key="${BASH_REMATCH[1]}" host="${BASH_REMATCH[2]}" project_id="${BASH_REMATCH[3]}"
case "$host" in
  *.ingest.us.sentry.io) ;;
  *) echo "error: host $host is not a US-region Sentry ingest host" >&2; exit 2 ;;
esac

id="$(openssl rand -hex 16)"
now="$(date -u +%s)"
sent_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
c="SSCANARY-$id"

event="$(jq -nc --arg id "$id" --arg c "$c" --argjson now "$now" --arg rel "${CANARY_RELEASE:-canary}" '{
  event_id: $id, timestamp: $now, platform: "other", level: "info",
  environment: "smoke", release: $rel, logger: "shoestring-canary",
  message: { formatted: ("Shoestring scrubber smoke test " + $id[0:8]) },
  tags: { canary_id: $id },
  user: { id: "canary-user", email: ($c + "@example.invalid"), ip_address: "{{auto}}" },
  request: {
    method: "POST", url: "https://shoestring.invalid/api/canary",
    query_string: ("token=" + $c + "-qs"),
    headers: { Cookie: ("__Host-ss_sid=" + $c + "-cookie"), Authorization: ("Bearer " + $c + "-auth"),
               "X-CSRF-Token": ($c + "-csrf") }
  },
  extra: {
    email: ($c + "-email"), payee: ($c + "-payee"), memo: ($c + "-memo"),
    amount: ($c + "-amount"), code: ($c + "-code"), password: ($c + "-password"),
    token: ($c + "-token"), session: ($c + "-session"),
    note: ("payee " + $c + "-value-match"),
    control: ("SSCONTROL-" + $id)
  },
  breadcrumbs: { values: [ { timestamp: $now, category: "fetch", type: "http",
                             message: ("token " + $c + "-crumb") } ] }
}')"
header="$(jq -nc --arg id "$id" --arg sent "$sent_at" --arg dsn "$dsn" '{event_id: $id, sent_at: $sent, dsn: $dsn}')"
item='{"type":"event","content_type":"application/json"}'
url="https://$host/api/$project_id/envelope/"

echo "canary event_id: $id"
echo "endpoint:        $url"
echo "event payload (synthetic values only):"
printf '%s\n' "$event" | jq .

if [[ "${APPLY:-0}" != "1" ]]; then
  echo
  echo "Dry run: nothing sent. Re-run with APPLY=1 to send this one event."
  exit 0
fi

printf '%s\n%s\n%s\n' "$header" "$item" "$event" \
  | curl -fsS -m 15 -X POST "$url" \
      -H "Content-Type: application/x-sentry-envelope" \
      -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=$key, sentry_client=shoestring-canary/1.0" \
      --data-binary @-
echo
echo "Sent. In Sentry: Issues → project → environment \"smoke\" → \"Shoestring scrubber smoke test ${id:0:8}\"."
echo "Open the event → ... → JSON, save it, then: grep -c SSCANARY <file> must print 0 (sentry-data-check.md)."

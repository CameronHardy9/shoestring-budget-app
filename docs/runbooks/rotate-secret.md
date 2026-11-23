# Rotate a secret
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy** (the keyring section depends on backend support for `APP_KEYRING` and `rewrap-mfa`)
- Secret names and consumers: infra/CLAUDE.md "Secrets". Values never go in the repo, chat, tickets, logs, job args or env overrides.

## When to use
- Suspected exposure (a log, screenshot, public commit or compromised device): **immediately**.
- Database passwords, the email API key and the application keyring: yearly, at a low-traffic hour. Avoid 08:00–09:30 UTC, when purge and backup run.
- After restoring into a new database (restore.md step 9).

## Free-tier note
We run **5 Secret Manager secrets with one active version each**. The free tier is 6 (V6), so a rotation's brief extra version is still free. Destroy the superseded version the same day once **Verify** passes, so the next rotation also stays free.

## Consumers (pin the new version on every one of them)
| Secret | Service `shoestring` | `shoestring-purge` | `shoestring-admin` | `shoestring-rewrap-mfa` | `shoestring-migrate` | `shoestring-backup` |
|---|---|---|---|---|---|---|
| `shoestring-database-url` | ✓ | ✓ | ✓ | ✓ | | |
| `shoestring-migrator-database-url` | | | | | ✓ | |
| `shoestring-app-keyring` | ✓ | | | ✓ | | |
| `shoestring-email-api-key` | ✓ | | ✓ | | | |
| `shoestring-backup-database-url` | | | | | | ✓ |

## Steps: generic
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
export NAME="shoestring-<secret>" ENVVAR="<ENV_VAR>"
export OLD_VERSION=$(gcloud secrets versions list "$NAME" --project "$PROJECT" --filter="state=ENABLED" \
  --sort-by=~createTime --limit=1 --format='value(name.basename())')

# 1. Add the new value (typed or pasted at the prompt; no trailing newline)
read -rs NEW_VALUE; printf '%s' "$NEW_VALUE" | gcloud secrets versions add "$NAME" --data-file=- --project "$PROJECT"; unset NEW_VALUE
export NEW_VERSION=$(gcloud secrets versions list "$NAME" --project "$PROJECT" --sort-by=~createTime --limit=1 \
  --format='value(name.basename())')

# 2. Service (if it is a consumer): new revision without traffic, readiness gate, then shift traffic
gcloud run services update shoestring --update-secrets "$ENVVAR=${NAME}:$NEW_VERSION" \
  --no-traffic --tag candidate --region "$REGION" --project "$PROJECT"
CANDIDATE_URL=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format=json \
  | jq -r '.status.traffic[] | select(.tag=="candidate") | .url')
curl -fsS -m 10 "$CANDIDATE_URL/api/readyz" && echo
gcloud run services update-traffic shoestring --to-latest --region "$REGION" --project "$PROJECT"
gcloud run services update-traffic shoestring --remove-tags candidate --region "$REGION" --project "$PROJECT"

# 3. Each job that is a consumer (see the table)
gcloud run jobs update "<job>" --update-secrets "$ENVVAR=${NAME}:$NEW_VERSION" --region "$REGION" --project "$PROJECT"

# 4. Verify (below), then revoke the old credential at its source (table below)

# 5. Same day: disable, then destroy the old version
gcloud secrets versions disable "$OLD_VERSION" --secret "$NAME" --project "$PROJECT"
gcloud secrets versions destroy "$OLD_VERSION" --secret "$NAME" --project "$PROJECT" --quiet
```
Then update the pinned version in deploy/cloudrun/*.yaml (once it exists), or the next deploy will revert it.

## Per-secret notes
| Secret | New value from | Old value revoked by | Notes |
|---|---|---|---|
| `shoestring-database-url` (`app`) | Neon: connect as `neondb_owner` with psql and run `\password app` (hashed locally; never `ALTER ROLE … PASSWORD` in the SQL editor). Build the **pooled** URL with `sslmode=verify-full`. | The password change itself (instant) | About 1–2 minutes of errors between the password change and step 2. Zero-downtime option: data-engineer adds a second login role with the same grants and you swap roles. |
| `shoestring-migrator-database-url` | Same, `\password migrator`, **direct** URL | The change | Only the migrate job uses it, so no user impact. |
| `shoestring-backup-database-url` (`backup`) | Same, `\password backup`, **direct** URL with `sslmode=verify-full&sslrootcert=system` | The change | Pin it on `shoestring-backup` only. Verify with `gcloud run jobs execute shoestring-backup --region "$REGION" --project "$PROJECT" --wait`. |
| `shoestring-email-api-key` | Resend → API keys → new key: "Sending access", domain `mail.<domain>` | Delete the old key in Resend after verifying | Verify by requesting a password reset for your own account. |
| `shoestring-app-keyring` | See "Application keyring" below | — | **Never replace it in place.** Add a key, rewrap, and remove the old key only when nothing uses it. |
| Backup heartbeat URL (plain env, not a secret) | Better Stack → heartbeat → regenerate | Regenerating | `gcloud run jobs update shoestring-backup --update-env-vars BACKUP_HEARTBEAT_URL=<new url> --region "$REGION" --project "$PROJECT"` |
| Backup `age` key pair | `age-keygen` on your Mac (bootstrap-production.md step 7), into vault A + offline copy | Keep the **old private key for 35 days** after the last dump made with it, then delete both copies | `gcloud run jobs update shoestring-backup --update-env-vars BACKUP_AGE_RECIPIENT=age1... --region "$REGION" --project "$PROJECT"`. Run a restore drill with the new key. |
| Sentry DSN (not secret) | Sentry → project → Client Keys → new key | Disable the old key after the new one is live | **SPA (`shoestring-web`):** `gh variable set SENTRY_DSN_WEB --repo "$GH_REPO" --body "<new>"`, then re-run CI on `main` (`gh workflow run ci.yml --ref main`), because the DSN is baked into the bundle. Then deploy that build (deploy.md). **API (`shoestring-api`):** `gcloud run services update shoestring --update-env-vars SENTRY_DSN=<new> --region "$REGION" --project "$PROJECT"`, and the same `gcloud run jobs update … --update-env-vars` on the purge, admin and rewrap-mfa jobs (not migrate: it has no Sentry SDK and no `SENTRY_DSN`). **Both DSNs must stay in the same Sentry org.** The backend derives the CSP `connect-src` host from `SENTRY_DSN`, so the SPA's ingest host must match it (bootstrap step 11b, S5 check). Verify with deploy.md smoke checks 1 and 4. |
| Sentry org auth token `SENTRY_AUTH_TOKEN` (GitHub environment secret; source-map upload only) | Sentry → Org Settings → Developer Settings → Organization Tokens → **Create New Token** `shoestring-ci-sourcemaps-<date>` | Revoke the old token on the same page after the next upload succeeds | `gh secret set SENTRY_AUTH_TOKEN --env sentry --repo "$GH_REPO"` (paste at the prompt; environment `sentry`, `main` only). Verify: the next main build's upload step passes, and the release shows an artifact bundle (deploy.md smoke check 6). Rotate at once if it ever appears in a log. |
| WIF identity (deployer) | No keys exist | On suspected abuse: `gcloud iam workload-identity-pools providers update-oidc github-oidc --workload-identity-pool github --location global --project "$PROJECT" --disabled` (verify flag) | Re-enable with `--no-disabled` once the cause is fixed. |

## Application keyring (`APP_KEYRING`, F-24) [needs backend support]
Format and rules: docs/contracts/data-model.md "Application keyring". In short:
- JSON `{"current":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}`, each key exactly 32 random bytes.
- New TOTP and recovery-code rows use `current`; existing rows record their key ID.
- Throttle keys and cursor MACs always use `current`. Changing `current` (stage 1 only; stages 2 and 3 don't) therefore **resets every persistent rate limit and lockout** and sends paging clients back to page 1. Details below.
- `GET /api/readyz` **fails if any row references a key ID missing from the keyring**. The candidate gate in step 2 therefore blocks a rotation that dropped a key still in use.

### Effect on rate limits and lockouts (read before stage 1)
The persistent counters in `auth_throttles` are keyed by `HMAC(throttle-v1 subkey of the current key, scope + IP, email or user ID)` (backend/src/http/rate-limit.ts `Throttles.key`), so no raw IP, email or user ID is stored. When stage 1's revision takes traffic, every new request computes a **different** key, so the old rows are never matched again (they expire and are purged). In effect, all of these **start from zero**:
- login limits per IP, per email and IP pair, and per email per day, so an account locked out after failed logins is **unlocked**
- the MFA failure budget (20 per user per 24 h) and the per-scope MFA throttles
- signup per IP, password-reset requests and completions per IP and per email, email-change requests, invitations per budget and per user, data exports per user
- the once-a-day "login throttled" and "MFA locked" notice emails, so a user under attack may get a **second** notice the same day

Not affected: the daily email budget (`EMAIL_DAILY_QUOTA`) and its 60%/100% alerts, which use a fixed unkeyed hash, and the in-memory per-IP and per-user write limits (they reset on every new revision anyway). Per-session and per-token MFA attempt slots are stored on the session or token itself, so they survive too.

What to do:
- **Rotate in a quiet window:** a low-traffic hour (late evening US time), outside 08:00–09:30 UTC. Say in your admin log when stage 1 went live.
- **Not during an active attack.** If Sentry or the logs show a burst of `RATE_LIMITED` (429) responses or lockouts in the last 24 h, wait until it has stopped, because rotating hands the attacker a fresh budget. Check with:
  ```sh
  gcloud logging read 'resource.labels.service_name="shoestring" AND jsonPayload.status=429' \
    --project "$PROJECT" --freshness 1d --limit 20 --format 'value(timestamp,jsonPayload.route,jsonPayload.code)'
  ```
- **Emergency rotation during an attack** (the keyring is suspected exposed): rotate anyway, because a leaked key is worse than reset counters. Then watch the same query for the next 24 h; the limits rebuild from the first new failure. Tell the tech lead, so security-reviewer knows the lockouts were reset.
- Users who were locked out can sign in again straight away. No action is needed for them.

The keyring is built and edited with `jq` straight from Secret Manager to Secret Manager. **Its value never appears on screen or in process arguments.** Before starting, turn off Handoff and pause clipboard managers (bootstrap-production.md "How to use", F-40), because the escrow update goes through the clipboard. The only copy outside GCP is the escrow in **vault B** (never vault A with the `age` key; never with backups).

**Stage 1: add a new key and make it current**
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1" NAME="shoestring-app-keyring"
export OLD_VERSION=$(gcloud secrets versions list "$NAME" --project "$PROJECT" --filter="state=ENABLED" \
  --sort-by=~createTime --limit=1 --format='value(name.basename())')
gcloud secrets versions access "$OLD_VERSION" --secret "$NAME" --project "$PROJECT" | jq -r '.current, (.keys | keys | join(" "))'   # prints key IDs only
export NEW_ID="k<N+1>"                                       # next unused ID, e.g. k2

# The new key reaches jq through --rawfile from a pipe (process substitution), never through argv (F-40)
gcloud secrets versions access "$OLD_VERSION" --secret "$NAME" --project "$PROJECT" \
  | jq -c --arg id "$NEW_ID" --rawfile k <(openssl rand -base64 32 | tr -d '\n') '.keys[$id] = $k | .current = $id' \
  | gcloud secrets versions add "$NAME" --project "$PROJECT" --data-file=-
export NEW_VERSION=$(gcloud secrets versions list "$NAME" --project "$PROJECT" --sort-by=~createTime --limit=1 \
  --format='value(name.basename())')

# Escrow: replace the vault B item "Shoestring APP_KEYRING" with the new version, then clear the clipboard
gcloud secrets versions access "$NEW_VERSION" --secret "$NAME" --project "$PROJECT" | pbcopy   # paste into vault B now
pbcopy < /dev/null
```
Then roll it out:
1. Service: generic step 2 with `ENVVAR=APP_KEYRING`. The candidate's `/api/readyz` must pass.
2. Rewrap job: `gcloud run jobs update shoestring-rewrap-mfa --update-secrets "APP_KEYRING=${NAME}:$NEW_VERSION" --region "$REGION" --project "$PROJECT"`

**Stage 2: re-encrypt TOTP secrets under the new key**
```sh
gcloud run jobs execute shoestring-rewrap-mfa --region "$REGION" --project "$PROJECT" --args="rewrap-mfa,--yes" --wait
gcloud run jobs execute shoestring-rewrap-mfa --region "$REGION" --project "$PROJECT" --args="rewrap-mfa,--dry-run" --wait
# Read the counts per key ID from the execution log (admin-commands.md: `job_output shoestring-rewrap-mfa`)
```
Expected: 0 `totp_credentials` rows on old key IDs. Recovery-code hashes **cannot** be rewrapped; they move to the new key only when users regenerate their codes.
- If the rotation is because of a **suspected compromise**, ask every MFA user to regenerate their recovery codes now (owner message).
- Then destroy `$OLD_VERSION` (generic step 5): it still holds the old key, but the new version does too.

**Stage 3: remove the old key** (only when the dry run shows **0 rows of any kind** on it)
```sh
export OLD_ID="k<N>"
export PREV_VERSION="$NEW_VERSION"
gcloud secrets versions access "$PREV_VERSION" --secret "$NAME" --project "$PROJECT" \
  | jq -c --arg id "$OLD_ID" 'del(.keys[$id])' \
  | gcloud secrets versions add "$NAME" --project "$PROJECT" --data-file=-
export NEW_VERSION=$(gcloud secrets versions list "$NAME" --project "$PROJECT" --sort-by=~createTime --limit=1 \
  --format='value(name.basename())')
```
Roll it out exactly as in stage 1. **If the candidate's `/api/readyz` fails, a row still uses `$OLD_ID`:** don't shift traffic; remove the candidate tag and destroy `$NEW_VERSION`. Then update the escrow in vault B, and destroy `$PREV_VERSION` the same day.

## Verify
- `curl -fsS https://shoestring.<domain>/api/readyz` returns 200 after any database or keyring rotation.
- Sign in with TOTP on your phone (keyring); request a password reset to yourself (email key).
- Sentry shows no new auth or DB errors for 15 minutes.
- The billing-protection.md §8 count is back to 5.
- The keyring escrow in vault B matches the pinned version: `gcloud secrets versions access <pinned> --secret shoestring-app-keyring --project "$PROJECT" | shasum -a 256` equals `pbpaste | shasum -a 256` after copying the vault item. Clear the clipboard afterwards.

## Back out
Before the old credential is revoked or its version destroyed: re-pin `$OLD_VERSION` (`--update-secrets "$ENVVAR=${NAME}:$OLD_VERSION"`) on every consumer.
- **Keyring exception:** once the new key is `current`, rows may already be written or rewrapped under it, and the old version can't read them. So after stage 1, never re-pin an older keyring version. Roll **forward** with a version that contains every key still in use. readyz enforces this.
- After a revocation there is no going back: generate another new value and repeat.

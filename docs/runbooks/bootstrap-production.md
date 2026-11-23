# Bootstrap production (one time, owner runs it)
- Owner: sre · Runs: **owner only** · Status: **DRAFT.** Steps 1–11 can run now. Steps marked **[needs app]** wait for the first image and the backend features they name.
- Decisions applied: Cloud Run us-east1 + Neon aws-us-east-1, spend cap, DNS on Cloudflare, admin commands as Cloud Run jobs, backups by a Cloud Run job to a private GCS bucket in a separate project (docs/mvp-planning/10-contract-review-decisions.md).
- Conventions: infra/CLAUDE.md. Cost controls: billing-protection.md. Alerts: observability/README.md.

**How to use this runbook**
- Run each block in order, in one terminal session, from the repo root. Tick the checkbox when its **Verify** passes.
- If a command fails because a flag or role has changed (items marked "verify"), stop and send the error to the tech lead. Don't improvise against production.
- **Before any step that handles key material** (steps 7, 9 and 11, rotations, restores; F-40): turn **off Handoff** (System Settings → General → AirDrop & Handoff → "Allow Handoff between this Mac and your iCloud devices"), so Universal Clipboard doesn't copy keys to your other devices. Quit or pause any **clipboard manager or history tool**. Turn Handoff back on afterwards. Better still, pipe secrets straight into your password manager's CLI instead of the clipboard, if it has one.
- **Never paste a secret** into a command line, chat, ticket or file. Every secret is entered at a `read -rs` prompt or moved through the clipboard straight into a store.
- **Clipboard order** (commands that read a secret with `pbpaste`): copying the command from this runbook overwrites the clipboard. Paste the command first **without pressing Return**, then copy the secret, then press Return.
- **The commands work in zsh (macOS default) and bash.** zsh reads `$VAR:x` as a modifier (`$VAR:s…` fails with "bad substitution"; `$VAR:e…` silently becomes a different value), so a variable directly followed by `:` is always written `${VAR}:`. Keep it that way in any command you adapt.
- **New terminal?** `source ~/shoestring-prod.env` first. An unset variable expands to nothing without an error, and several commands below would then create resources with empty settings. Steps that depend on earlier values check them with `: "${VAR:?…}"`.

## 0. Tools and variables
```sh
brew install --cask google-cloud-sdk
brew install gh jq age crane postgresql@17      # psql/pg_dump/pg_restore 17 (local Postgres is 17.12)
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
gcloud auth login && gh auth login

export DOMAIN="<your domain>"                   # e.g. example.com (not secret)
export GH_REPO="<owner>/<repo>"                 # exact case, as GitHub shows it (WIF subject, gh commands)
GH_REPO_LC=$(printf '%s' "$GH_REPO" | tr '[:upper:]' '[:lower:]'); export GH_REPO_LC   # GHCR image paths must be lowercase
export BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"   # gcloud billing accounts list
export SUFFIX="<4-6 random lowercase chars>"    # record it in infra/CLAUDE.md
export PROJECT="shoestring-prod-$SUFFIX" BACKUP_PROJECT="shoestring-backup-$SUFFIX"
export BACKUP_BUCKET="shoestring-backups-$SUFFIX" REGION="us-east1"
export GH_REPO_ID=$(gh api "repos/$GH_REPO" --jq .id) GH_OWNER_ID=$(gh api "repos/$GH_REPO" --jq .owner.id)
SA() { echo "shoestring-$1@$PROJECT.iam.gserviceaccount.com"; }
```
Put these `export` lines (no secrets in them) into a file **outside** the repo, such as `~/shoestring-prod.env`, so you can `source` it in later sessions.

## 1. Operator account security (F-03), before anything else
Each of these accounts is equivalent to full control of the app or its data. Use **phishing-resistant MFA** (a passkey or a hardware security key) wherever it's offered. Store recovery codes **offline** (printed, or in a separate password-manager vault). Where a service offers only TOTP, sign in through Google or GitHub instead if it allows that, so the passkey protects it. Otherwise use TOTP and note it in the table (verify each service's options, V32).

| ☐ | Account | Required setup | Factor used | Date done |
|---|---|---|---|---|
| ☐ | Your primary mailbox (it receives every other account's recovery mail) | Passkey or security key; remove SMS fallback; recovery codes offline | | |
| ☐ | Passkey sync account (Apple ID / iCloud Keychain, or the password manager if it stores passkeys) | Security keys or Advanced Data Protection with a recovery key; no SMS-only recovery; trusted phone numbers reviewed; recovery key offline | | |
| ☐ | Google account that owns the GCP projects | Passkey + 2-Step Verification (consider Advanced Protection); no other principals on the projects | | |
| ☐ | GitHub | Passkey as 2FA; recovery codes offline; no classic PATs; secret scanning + push protection on (ci-engineer checklist) | | |
| ☐ | Cloudflare (DNS) | Security key / passkey 2FA; no API tokens unless needed; registrar or transfer lock on | | |
| ☐ | Domain registrar (if not Cloudflare) | Strongest MFA available; transfer lock on | | |
| ☐ | Neon | Sign in **with Google or GitHub only** | | |
| ☐ | Sentry | Passkey or security key as 2FA (Sentry calls it "U2F"); recovery codes offline; org setting "Require Two-Factor Authentication" on. Done in step 11b, S1 (V37) | | |
| ☐ | Resend | Google/GitHub sign-in, or its 2FA | | |
| ☐ | Better Stack | Google sign-in, or its 2FA | | |
| ☐ | Password manager | Strong master password + 2FA; it holds the `age` key, DB passwords and the MFA-key escrow | | |
| ☐ | Phone | Passcode + biometrics; it holds passkeys and receives alerts | | |
Passkeys are free. Hardware keys are optional one-time hardware, not a service cost.

## 2. GCP projects, billing guard, quotas
Run **docs/runbooks/billing-protection.md sections 0, 1, 2A, 3 and 4 now**: projects, budgets, spend cap, quotas and the API allow-list.
- **V0 gate:** in §2A, if the spend-cap option cannot cover Cloud Run, **stop** and tell the tech lead. The owner then chooses between the kill switch (§2B) and alerts only.

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudscheduler.googleapis.com \
  logging.googleapis.com monitoring.googleapis.com cloudresourcemanager.googleapis.com --project "$PROJECT"
gcloud services enable storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project "$BACKUP_PROJECT"
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
```
**Verify:** `gcloud services list --enabled --project "$PROJECT"` matches the allow-list in billing-protection.md §4.

## 3. Artifact Registry
Run **billing-protection.md §5a** (create the `shoestring` repository and set the cleanup policy to dry-run). The switch to live deletion comes later, after the second deploy: billing-protection.md §5b (Record row 3b).

## 4. Logging limits
Run **billing-protection.md §6**: 30-day retention, exclude Cloud Run request logs (they contain IPs and user agents), exclude DEBUG.

## 5. Service accounts and IAM
```sh
for sa in run purge admin rewrap migrate backup deployer scheduler; do
  gcloud iam service-accounts create "shoestring-$sa" --project "$PROJECT" --display-name "Shoestring $sa"
done

# Deployer: act as the runtime SAs it deploys, push to the one AR repo.
# Its Cloud Run rights are granted per resource in step 12h, NEVER project-wide (F-39), so it can't run,
# override, update or delete shoestring-backup. Project level gets only a minimal custom role:
gcloud iam roles create shoestringDeployerProject --project "$PROJECT" \
  --title "Shoestring deployer (project-level minimum)" --stage GA \
  --permissions run.operations.get,run.revisions.get,run.revisions.list,run.locations.list   # verify sufficiency (V36)
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(SA deployer)" \
  --role "projects/$PROJECT/roles/shoestringDeployerProject"
for sa in run purge admin rewrap migrate; do
  gcloud iam service-accounts add-iam-policy-binding "$(SA $sa)" --project "$PROJECT" \
    --member "serviceAccount:$(SA deployer)" --role roles/iam.serviceAccountUser
done
gcloud artifacts repositories add-iam-policy-binding shoestring --location "$REGION" --project "$PROJECT" \
  --member "serviceAccount:$(SA deployer)" --role roles/artifactregistry.writer
```
Secret access is granted per secret in step 9. The scheduler's job grant happens in step 12.
The deployer gets **no** `serviceAccountUser` on `shoestring-backup@` and **no** role on the backup job (F-39).
**Verify:** `gcloud iam service-accounts list --project "$PROJECT"` lists 8 accounts. `gcloud projects get-iam-policy "$PROJECT" --format=json | jq '.bindings[] | select(.members[] | contains("shoestring-deployer"))'` shows only the custom `shoestringDeployerProject` role, with **no** `roles/run.*` at project level.

## 6. Workload Identity Federation for GitHub Actions (F-16)
```sh
gcloud iam workload-identity-pools create github --project "$PROJECT" --location global \
  --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-oidc --project "$PROJECT" --location global \
  --workload-identity-pool github \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition "assertion.repository_id=='$GH_REPO_ID' && assertion.repository_owner_id=='$GH_OWNER_ID' && assertion.ref=='refs/heads/main' && assertion.environment=='production'"

# The repo issues IMMUTABLE OIDC subjects (F-66): sub = repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:production
gh api "repos/$GH_REPO/actions/oidc/customization/sub" --jq '{use_immutable_subject, sub_claim_prefix}'   # expect true + the prefix
SUB_PREFIX=$(gh api "repos/$GH_REPO/actions/oidc/customization/sub" --jq '.sub_claim_prefix // empty')
case "$SUB_PREFIX" in
  "repo:"*"@$GH_OWNER_ID/"*"@$GH_REPO_ID") echo "subject prefix OK: $SUB_PREFIX" ;;
  *) echo "STOP: unexpected subject prefix '$SUB_PREFIX'; do not bind, tell the tech lead" ;;
esac
POOL="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github"
gcloud iam service-accounts add-iam-policy-binding "$(SA deployer)" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/$POOL/subject/${SUB_PREFIX}:environment:production"
```
This is the **only** WIF binding: there is no GitHub backup identity. If `use_immutable_subject` ever prints `false`, the subject is `repo:${GH_REPO}:environment:production` instead: stop and tell the tech lead before binding.
- **Never widen the binding to a `principalSet`** (`…/attribute.repository_id/…`, `…/attribute.ref/…` or any other attribute). That would hand the deployer to CI's `publish` job and every future main-branch job with `id-token: write`. If deploy authentication fails, stop and tell the tech lead.
- **First deploy-job token:** `.github/workflows/deploy.yml` doesn't exist yet; the owner deploys by the manual path for now. When it does, its first run confirms the subject: auth succeeds only if the token's `sub` is exactly `${SUB_PREFIX}:environment:production`. If it fails, compare the subject in the auth error with that value; never "fix" it by widening.

**Verify:** `gcloud iam workload-identity-pools providers describe github-oidc --workload-identity-pool github --location global --project "$PROJECT" --format="yaml(attributeCondition,state)"` shows the condition (including `environment=='production'`) and `ACTIVE`. `gcloud iam service-accounts get-iam-policy "$(SA deployer)" --project "$PROJECT"` shows exactly one `workloadIdentityUser` member, the `principal://…/subject/${SUB_PREFIX}:environment:production` above, and no `principalSet`. **Back out:** `gcloud iam workload-identity-pools providers update-oidc github-oidc ... --disabled` (verify flag).

## 7. Backup project: bucket, write-only grant, `age` key (OD-4, F-17)
Run **billing-protection.md §7** (create the bucket: us-east1, soft delete off, 34-day lifecycle). Then give the prod project's backup job identity **create-only** access to that one bucket:
```sh
gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
  --member "serviceAccount:$(SA backup)" --role roles/storage.objectCreator
```
**`age` key pair** (on your Mac; the private key never touches the repo, GitHub or GCP):
```sh
age-keygen 2>/dev/null | pbcopy
# 1. Paste into a NEW password-manager item "Shoestring backup age key" (vault A).
# 2. Make the second offline copy now (print it, or write it to an encrypted USB stick kept at home).
pbpaste | age-keygen -y        # prints the PUBLIC key (age1...), which is not secret; note it for step 12g
pbcopy < /dev/null
```
**Verify:** `gcloud storage buckets get-iam-policy "gs://$BACKUP_BUCKET" --format=json | jq '.bindings'` shows `objectCreator` for `shoestring-backup@` and nothing granting `allUsers` or `allAuthenticatedUsers`. The backup script uploads with a create-only JSON API call that needs nothing more. If the first run fails with 403, **don't widen the role**; tell the tech lead.

## 8. Neon (Postgres 17, aws-us-east-1)
1. Sign in to Neon **with Google or GitHub** (step 1). Don't add a payment method.
2. **Create project** `shoestring`: Postgres **17**, region **AWS US East 1 (N. Virginia)**, database `shoestring`.
3. **Settings → Compute:** min **0.25**, max **0.25** CU. Leave scale to zero on. Leave the Data API and Neon Auth **off**.
4. **SQL Editor:** `select version();` → record the 17.x minor in infra/CLAUDE.md (V30). Local is 17.12; the major must match and the minor may differ.
5. **Roles (least privilege, F-28) [needs db/]:** connect as the database owner role from your Mac, run data-engineer's role script `db/roles.sql`, and set each password. **Neon accepts only plaintext passwords** (psql's `\password` sends a hash and Neon answers `400 … only supports being given plaintext passwords`), so the password goes in as a psql variable from a here-document: it never appears on screen, in shell history or in psql history. Neon's server receives it in plaintext and may log it where we can't see it; that is accepted (security-reviewer 2026-11-23), since Neon already holds the data these roles protect.
   - Run it from a checkout of current `main` (`git switch main && git pull`), which is the commit you deploy in step 12 or older. The app image no longer contains `db/`, so the repo checkout is the only source.
   - It must run as the **owner** (`neondb_owner`): only the owner can revoke `TEMPORARY` from PUBLIC (F-44). The migrate job re-runs it as `migrator` and **fails closed** if the owner's part is missing.
   ```sh
   git fetch origin main && git status --porcelain db/roles.sql    # must print NOTHING: no local edits (F-64)
   git diff --quiet origin/main -- db/roles.sql && echo "roles.sql matches origin/main"   # must print that line
   read -rs OWNER_URL                          # not exported (F-64 nit); Neon → Connect → role neondb_owner, DIRECT, append ?sslmode=verify-full&sslrootcert=system
   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f db/roles.sql     # creates app, migrator, backup; database grants; F-44 revokes
   set_pw() {   # $1 = role; generates a password, sets it, and copies it to the clipboard for your password manager
     local pw; pw=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-40)
     psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v role="$1" -v pw="$pw" <<'SQL'
   ALTER ROLE :"role" PASSWORD :'pw';
   SQL
     [ $? -eq 0 ] || { echo "STOP: password for $1 NOT set; nothing copied" >&2; return 1; }
     printf '%s' "$pw" | pbcopy; echo "$1: password set and copied (Handoff off, F-40); save it in the password manager, then press Return"; read -r; pbcopy < /dev/null
   }
   set_pw app && set_pw migrator && set_pw backup
   ```
   Then `unset OWNER_URL`. The app never uses `neondb_owner`.
6. **Build the three URLs** in your password manager (never in a file). Host names come from Neon → Connect.
   - `app`, **pooled**: `postgresql://app:<pw>@<endpoint>-pooler.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full`
   - `migrator`, **direct**: `postgresql://migrator:<pw>@<endpoint>.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full`
   - `backup`, **direct**: `postgresql://backup:<pw>@<endpoint>.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full&sslrootcert=system`
   - The `app` and `migrator` URLs end in exactly `?sslmode=verify-full`. **Never add `sslrootcert=system` to them:** they are read by node-postgres, which treats it as a file path and fails with ENOENT. Only the `backup` URL (read by libpq's `pg_dump`) and the URLs you use with `psql` take it.

**Verify:** `read -rs U; psql "$U" -Atc "select current_user, current_setting('server_version')"; unset U` for each URL prints the right role. For the `app` and `migrator` URLs, use `psql "$U&sslrootcert=system"` (psql is libpq and needs it; the stored URL stays without it). With the backup URL, `create table x(i int)` must fail (read-only).

## 9. Secrets (Secret Manager, us-east1 only, 5 in total)
```sh
for s in database-url migrator-database-url app-keyring email-api-key backup-database-url; do
  gcloud secrets create "shoestring-$s" --project "$PROJECT" --replication-policy user-managed --locations "$REGION"
done
add_secret() { read -rs -p "$1: " V; echo; printf '%s' "$V" | gcloud secrets versions add "$1" --project "$PROJECT" --data-file=-; unset V; }

add_secret shoestring-database-url             # app, pooled URL from step 8
add_secret shoestring-migrator-database-url    # migrator, direct URL
add_secret shoestring-backup-database-url      # backup (read-only), direct URL with sslrootcert=system

# Application keyring (replaces MFA_ENCRYPTION_KEY and THROTTLE_KEY; data-model.md "Application keyring"):
# one 32-byte key "k1", built straight into the clipboard, never shown on screen.
openssl rand -base64 32 | tr -d '\n' | jq -Rc '{current: "k1", keys: {k1: .}}' | pbcopy
# Paste it NOW into a new vault B item "Shoestring APP_KEYRING" (offline escrow, owner ruling 2026-11-13;
# a different vault from the age key in vault A, F-17). Then:
pbpaste | gcloud secrets versions add shoestring-app-keyring --project "$PROJECT" --data-file=-
pbcopy < /dev/null

# shoestring-email-api-key gets its value in step 11

grant() { gcloud secrets add-iam-policy-binding "shoestring-$1" --project "$PROJECT" \
  --member "serviceAccount:$(SA "$2")" --role roles/secretmanager.secretAccessor >/dev/null && echo "granted $1 → $2"; }
grant database-url run; grant database-url purge; grant database-url admin; grant database-url rewrap
grant app-keyring run;  grant app-keyring rewrap         # service and rewrap-mfa only; never admin or purge
grant email-api-key run; grant email-api-key admin
grant backup-database-url backup
grant migrator-database-url migrate
```
**Verify:**
- billing-protection.md §8 count shows **4** now, and **5** after step 11 (one under the free tier of 6).
- `gcloud secrets get-iam-policy shoestring-app-keyring --project "$PROJECT"` lists only the run and rewrap SAs.
- `shoestring-migrator-database-url` lists only migrate; `shoestring-backup-database-url` lists only backup.
- `gcloud secrets versions access 1 --secret shoestring-app-keyring --project "$PROJECT" | jq -r '.current, (.keys | keys | join(" "))'` prints `k1` twice (key IDs only, never the key).

## 10. GitHub environment and variables (deploy only; no secrets)
**Click path:** repo → Settings → Environments → **New environment**:
- `production`: Required reviewers = you. Prevent self-review **off** (you are the only reviewer). Deployment branches = **Selected branches → `main`**. "Allow administrators to bypass" **off**.

There is **no** `backup` environment, and GitHub holds no database credential (owner ruling 2026-11-13).
```sh
WIF="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc"
gh variable set GCP_WIF_PROVIDER --env production --repo "$GH_REPO" --body "$WIF"
gh variable set GCP_DEPLOY_SA    --env production --repo "$GH_REPO" --body "$(SA deployer)"
gh variable set GCP_PROJECT      --env production --repo "$GH_REPO" --body "$PROJECT"
```
**Verify:** `gh api "repos/$GH_REPO/environments" --jq '.environments[] | {name, protection_rules}'` shows only `production` (and, after step 11b, `sentry`). `gh secret list --repo "$GH_REPO"` and `gh secret list --env production --repo "$GH_REPO"` show no database or backup secret.

## 11. Email: Resend on `mail.<domain>`, DNS on Cloudflare
1. Resend → **Domains → Add domain** `mail.<domain>`, region **us-east-1**.
2. Cloudflare → `<domain>` → **DNS → Records**: add the DKIM TXT, the `send.mail` MX and the SPF TXT that Resend shows, plus DMARC. All **DNS only**. Templates are in infra/hosting-evaluation.md §5. DMARC:
   - Type `TXT`, Name `_dmarc.mail`, Content **`v=DMARC1; p=none; adkim=s; aspf=r`** for now. This starts the ramp to `p=reject` (F-29); see step 11.8.
3. Resend → Verify. Wait until the status is **Verified**.
4. Resend → domain → **Configuration: Click tracking OFF, Open tracking OFF** (F-06; verify V33 for the labels and defaults).
5. Resend → **API Keys → Create**: name `shoestring-prod`, permission **Sending access**, domain `mail.<domain>`. Copy it once and run `add_secret shoestring-email-api-key`. Don't keep another copy; if it's lost, create a new key.
6. **Test alignment:**
   ```sh
   read -rs KEY; curl -fsS https://api.resend.com/emails -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d "{\"from\":\"Shoestring <no-reply@mail.$DOMAIN>\",\"to\":[\"<your own address>\"],\"subject\":\"Shoestring DMARC test\",\"text\":\"Plain-text test. No links.\"}"; unset KEY
   ```
   In Gmail → the message → **Show original**: SPF **PASS**, DKIM **PASS**, DMARC **PASS**. The message has no tracking pixel and no rewritten links.
7. If Resend offers usage or quota notification emails, turn them on (backstop for alert A6).
8. **DMARC ramp** (infra/hosting-evaluation.md §5). Edit the `_dmarc.mail` TXT in Cloudflare at each stage:
   - After the step 6 test passes and ≥ 3 clean days: `v=DMARC1; p=quarantine; adkim=s; aspf=r`
   - After ≥ 7 more clean days, **before launch**: `v=DMARC1; p=reject; adkim=s; aspf=r; pct=100` (end state)
   Check each stage with `dig +short TXT "_dmarc.mail.$DOMAIN"` and a fresh test send (step 6).

## 11b. Sentry: account, projects, privacy settings and keys (F-03, F-06, F-07)
Do this **before step 12**. The first deploy needs the API DSN, and CI needs the web DSN to build a releasable image. Alert rules and the cron monitor come later, in step 13.

**Done 2026-11-17** (S1–S9, canary passed on both projects; see the Record table). The notes dated 2026-11-17 below record what that run taught; follow them if you ever redo any part of this step (for example, after recreating a project in sentry-data-check.md step 3).

Plan facts (sentry.io/pricing and docs.sentry.io/pricing, checked 2026-11-16, V18):
- The free **Developer** plan has 1 user, 5,000 errors a month, 1 cron monitor, a 30-day lookback, and alerts **by email only**.
- It has **no pay-as-you-go budget**, so it can't bill. Data over the quota is dropped.
- **New organizations start on a 14-day Business trial** and become Developer automatically at the end. **Don't add a card. Don't upgrade.** During the trial, Spike Protection is inactive and Business-only settings are visible: per-key rate limits, release and error-message inbound filters, Delete & Discard. **Don't set any of them**, because they stop applying once the trial ends.

**S1. Account and MFA**
1. Open `https://sentry.io/signup/`. Sign up with your email and a new password from your password manager, saved there first.
2. Create the organization:
   - **Data Storage Location: United States.** This can't be changed later.
   - Name: your choice. Note the org **slug** that Sentry shows. (2026-11-17: the owner named it "Cameron Hardy", slug `cameron-hardy`.)
   - Skip "invite your team".
3. Avatar (bottom left) → **User Settings → Security → Two-Factor Authentication** → **U2F (Universal 2nd Factor)** → **Add** → register your passkey or security key, named for example `mac passkey`.
   - Then **Recovery Codes** → **Download** → store them offline (printed, or in the password manager vault, not the Downloads folder).
   - If Sentry requires an authenticator app before it accepts a key, add TOTP first, then the key, and note "TOTP + key" in the step 1 table (V37).
4. **Org Settings → General Settings** → "Security & Privacy" section:
   - **Require Two-Factor Authentication**: on → Confirm.
   - **Enhanced Privacy**: on. Alert emails then leave out event details and source code.
   - **Allow Shared Issues**: off. Shared issue links are public.
   - **Allow JavaScript source fetching**: off (if shown here; otherwise per project in S4). Source maps come only from CI's private upload.
   - **Allow join requests**: off.
5. Write the trial end date in the Record table at the bottom of this runbook. After that date, **Org Settings → Subscription** must show **Developer** (V41).

**S2. Organization privacy settings (F-07).** Org Settings → **Security & Privacy**:
| Setting | Value |
|---|---|
| Require Data Scrubber | **on** |
| Require Using Default Scrubbers | **on** |
| Prevent Storing of IP Addresses | **on** |
| Global Sensitive Fields (one per line) | `token`, `password`, `code`, `email`, `payee`, `memo`, `amount`, `cookie`, `authorization`, `x-csrf-token`, `session` |
| Global Safe Fields | *(empty)* |

- **What the sensitive fields do.** Each word removes any field whose **key** contains it, and also any **value** that contains it, in Sentry's PII fields: extra, user, request query, headers and cookies, breadcrumbs, frame variables. For example, a breadcrumb for `/api/auth/sessions` shows as `[Filtered]`. That is intended: it fails closed.
- **Advanced Data Scrubbing** (same page) → **Add Rule**, four times. Use the Source box's autocomplete, and if the syntax is rejected, send the error to the tech lead.
  | Method | Data type | Source | Why |
  |---|---|---|---|
  | Remove | Anything | `$user.geo.**` | Sentry derives a city and region from the IP **even when IP storage is off** (docs.sentry.io "Server-Side Data Scrubbing" → Geographic Information) |
  | Replace | Email Addresses | `**` | Backstop for every default PII field |
  | Replace | Email Addresses | `$error.value \|\| $message` | Exception and log messages are not default PII fields |
  | Replace | IP Addresses | `$error.value \|\| $message` | Same |

  - Every **Replace** rule asks for replacement text: enter `[Filtered]`, the same marker the default scrubbers use, so sentry-data-check.md treats every scrubbed value the same way (done this way 2026-11-17).

**S3. Projects.** **Projects → Create Project**, twice. In both, choose "I'll create my own alerts later", and skip the SDK setup wizard: backend and frontend already contain the SDK.
| Platform | Project name | Used by |
|---|---|---|
| **Node.js** | `shoestring-api` | the service and the purge, admin and rewrap-mfa jobs (not migrate: its CLI has no Sentry SDK); also receives the browser's CSP reports (backend derives `Reporting-Endpoints` from this DSN) |
| **Browser JavaScript** | `shoestring-web` | the SPA |

**S4. Per-project settings** (do each one in both projects unless marked):
- **Settings → Security & Privacy:** the S2 values show as set by the organization (greyed out or "enforced").
  - **Also set these two explicitly on both projects**, so they don't depend on org enforcement alone: **Prevent Storing of IP Addresses** on (API field `scrubIPAddresses: true`), and **JavaScript source fetching** off (`scrapeJavaScript: false`; on `shoestring-web` it's under General → Client Security). The 2026-11-17 run set both on each project. If the UI doesn't show one of them for `shoestring-api`, use the API through the Sentry CLI ("Sentry CLI", after S10):
    ```sh
    sentry api "projects/$SENTRY_ORG/shoestring-api/" -X PUT -F scrubIPAddresses=true -F scrapeJavaScript=false --dry-run   # then without --dry-run
    sentry api "projects/$SENTRY_ORG/shoestring-api/" | jq '{scrubIPAddresses, scrapeJavaScript}'                        # true, false
    ```
- **Settings → Inbound Filters:**
  - on: "Filter out events coming from localhost"
  - on: "Filter out known errors from browser extensions"
  - on: "Filter out known errors from legacy browsers" (all listed browsers)
  - on: "Filter out known web crawlers"
  - Leave the IP field empty. "Releases" and "Error Message" filters are Business-only; leave them empty.
- **Settings → General → Client Security** (`shoestring-web`):
  - "Enable JavaScript source fetching": **off**.
  - Leave "Allowed Domains" at `*` until the canary in S9 has passed, then do S10.
- **Settings → Security Headers** (`shoestring-api`, which receives the CSP reports): "Use default ignored sources" **on**. It drops browser-extension noise, which would otherwise use up the error quota (V43).
- **Settings → Client Keys (DSN):** keep the single default key and copy its **DSN** (it isn't secret). **Per-key rate limits are Business-only** (docs.sentry.io "Manage Your Error Quota" → Rate Limiting, checked 2026-11-16), so there is nothing to set. The backstops are below and in observability/README.md.
- **Org Settings → Spike Protection** → **Enable All**. Then expand each project → **Add Action** → **Sentry Notification**. It is inactive during the trial. Check that it is still on after the trial (V38).
  - **One notification action per project.** Sentry rejects a single action that covers both projects (2026-11-17), so add one under `shoestring-api` and another under `shoestring-web`.

**S5. Check the DSNs** (they aren't secret; they ship in the SPA bundle):
```sh
export SENTRY_DSN_API="<shoestring-api DSN>"     # also used in step 12
export SENTRY_DSN_WEB="<shoestring-web DSN>"
for d in "$SENTRY_DSN_API" "$SENTRY_DSN_WEB"; do printf '%s\n' "$d" | sed -E 's#^https://[^@]+@([^/]+)/([0-9]+)$#host=\1 project=\2#'; done
```
**Pass:** both lines show the **same** host, `o<digits>.ingest.us.sentry.io`. The backend derives the CSP `connect-src` from the API DSN, so the SPA's events go to an allowed host only if both hosts match. Add both `export` lines to `~/shoestring-prod.env`.

**S6. Auth token for the private source-map upload.** **Org Settings → Developer Settings → Organization Tokens** → **Create New Token**, name `shoestring-ci-sourcemaps` → **Create**.
- **Create it in the browser, never through the API or a CLI.** Sentry refuses API-created organization auth tokens, **even for an OAuth session with `org:admin`** (2026-11-17). Anyone automating this step must stop here and hand it to the owner in the UI.
- **Re-run: create the GitHub environment first.** If CI runs a workflow that declares `environment: sentry` before the environment exists, GitHub **auto-creates it with no branch policy**, so any branch's workflow could read its secrets. That happened on 2026-11-17 when PR #19's workflow first referenced it. Run the two `gh api` environment commands below **before the first CI run that references `sentry`** (before pushing such a workflow). If the environment already exists, the `PUT` adds the main-only policy to it; S9 checks it.
- Organization tokens have one fixed, CI-only scope (`org:ci`: releases and source-map upload). That is the **minimum Sentry offers**: it can't read events, change settings or manage members (docs.sentry.io "Auth Tokens", checked 2026-11-16).
- **Don't** use a personal token or an internal integration.
- The token is shown **once**. Store it straight in GitHub (the paste goes into a hidden prompt, never a command line), and don't keep another copy. If you lose it, revoke it and create a new one.
- **Where it lives:** an **environment secret** on the GitHub environment **`sentry`**, which only `main` can use. **Never a repository-wide secret.** ci-engineer's CI job declares `environment: sentry` and runs `make sourcemaps-upload` on `main` only. The environment adds a server-side guarantee that no other branch's workflow can read the token. While the secret doesn't exist, the upload skips cleanly.
```sh
gh api -X PUT "repos/$GH_REPO/environments/sentry"   -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST "repos/$GH_REPO/environments/sentry/deployment-branch-policies" -f name=main -f type=branch
gh secret set SENTRY_AUTH_TOKEN --env sentry --repo "$GH_REPO"     # paste at the prompt
pbcopy < /dev/null
```
Sentry emails you that a token was created; that is expected. The environment has no required reviewers: it gates by branch, not by approval, so every main build can upload its maps.

**S7. GitHub repository variables (not secret).** These are exactly the three CI reads (`.github/workflows/ci.yml`): `SENTRY_DSN_WEB`, `SENTRY_ORG` and `SENTRY_PROJECT_WEB`.
```sh
gh variable set SENTRY_DSN_WEB --repo "$GH_REPO" --body "$SENTRY_DSN_WEB"            # build arg VITE_SENTRY_DSN (Dockerfile)
gh variable set SENTRY_ORG     --repo "$GH_REPO" --body "<org slug from S1>"          # sentry-cli upload
gh variable set SENTRY_PROJECT_WEB --repo "$GH_REPO" --body "shoestring-web"          # sentry-cli upload
```

**S8. Where each value goes**
| Value | Secret? | Goes to | Set in |
|---|---|---|---|
| `shoestring-api` DSN | no | Cloud Run plain env `SENTRY_DSN` on the service and on the purge, admin and rewrap-mfa jobs (`COMMON_ENV` in step 12). **Not** on `shoestring-migrate` or `shoestring-backup`, which have no Sentry SDK: migrate failures show only as a failed job execution (`--wait` exits non-zero) and in its logs; backup reports through its heartbeat. | step 12 (from `$SENTRY_DSN_API`) |
| `shoestring-web` DSN | no (public in the bundle) | GitHub repository variable `SENTRY_DSN_WEB` → Docker build arg `VITE_SENTRY_DSN` → baked into the SPA | S7 |
| Release | no | The full git SHA. CI passes it as the build arg `APP_RELEASE`, so the image has `APP_RELEASE` and `VITE_APP_RELEASE`. Cloud Run gets `APP_RELEASE=$SHA` (step 12 and deploy.md step 4). The source-map upload uses the same SHA (ci-engineer). | automatic |
| Org auth token | **yes** | GitHub environment secret `SENTRY_AUTH_TOKEN` on environment `sentry` (`main` only) (S6). It is never in Cloud Run, Secret Manager, the image or the repo. | S6 |
| Org slug, project names | no | GitHub variables `SENTRY_ORG`, `SENTRY_PROJECT_WEB` | S7 |
| Environment | no | The SDKs report `production` in production (backend and frontend). The alert rules in step 13 filter on it. | code |
Secret Manager still holds 5 secrets: neither DSN is a secret.

**S9. Verify**
```sh
gh variable list --repo "$GH_REPO" | grep -E '^SENTRY_'
gh secret list --env sentry --repo "$GH_REPO"         # SENTRY_AUTH_TOKEN only
gh secret list --env production --repo "$GH_REPO"            # nothing Sentry-related, no database or backup secret
gh secret list --repo "$GH_REPO" | grep -c SENTRY || true     # must print 0: no repository-wide Sentry secret
gh api "repos/$GH_REPO/environments/sentry" --jq '.deployment_branch_policy'               # {"custom_branch_policies":true,"protected_branches":false}; null = no policy: re-run the S6 PUT
gh api "repos/$GH_REPO/environments/sentry/deployment-branch-policies" --jq '[.branch_policies[].name]'   # ["main"]
```
- Run the **canary** in docs/runbooks/sentry-data-check.md step 2 for **both** DSNs. It must pass before step 12. It proves the S2 settings remove every synthetic sensitive value, plus the IP and geo data. (The stored event can be checked through the API instead of a JSON download; see that step.)
- Org Settings → **Audit Log** shows the token creation and the settings changes, and no other member.

**S10. Lock the web DSN to the site** (after S9 passes). `shoestring-web` → Settings → General → Client Security → **Allowed Domains**: replace `*` with `shoestring.<domain>`. Sentry then rejects browser events from other origins (for example, someone reusing the public DSN).
- Leave `shoestring-api` at `*`: server events and CSP reports carry no page origin.
- If a later canary run against the web DSN returns 403, that's this setting working. Re-run the canary with `*` set temporarily, then set it back (V42).
- Optional CLI route (see "Sentry CLI" below):
  ```sh
  sentry api "projects/$SENTRY_ORG/shoestring-web/" -X PUT -d "{\"allowedDomains\":[\"shoestring.$DOMAIN\"]}" --dry-run   # check the body, then run without --dry-run
  sentry api "projects/$SENTRY_ORG/shoestring-web/" | jq '.allowedDomains'                                              # ["shoestring.<domain>"]
  sentry api "projects/$SENTRY_ORG/shoestring-api/" | jq '.allowedDomains'                                              # ["*"]
  ```

**Sentry CLI (optional route for S10 and step 13).** The owner's Mac has the Sentry CLI (`sentry`, v0.49) at `~/.local/bin/sentry`, signed in by OAuth on 2026-11-17. Its scopes are narrowed to `org:read`, `project:read`, `project:write`, `team:read`, `event:read`, `member:read`, `alerts:read` and `alerts:write`, and the login expires about 4 weeks later (around 2026-12-15).
- `export SENTRY_ORG=cameron-hardy` before using the commands in this runbook. Check the session with `sentry auth status`.
- **What it can't do:** create organization auth tokens (S6, browser only, even with `org:admin`), delete issues (needs `event:admin`; delete canary issues in the UI), or change org-level Security & Privacy settings (needs `org:write`). Don't widen its scopes for those; use the UI.
- Use `--dry-run` (`-n`) on every write and read the printed body before running it for real.
- **When step 13 is done** (or by the expiry date, whichever is first): `sentry auth logout`, then Avatar → **User Settings → Authorized Applications** and revoke the Sentry CLI entry if it is still listed (verify: `logout` may only remove the local copy). Note the date in the Record table.

**Back out:** the projects can be removed and recreated (Project → Settings → General → Remove Project). Revoke the token on the Organization Tokens page, and delete the secret with `gh secret delete SENTRY_AUTH_TOKEN --env sentry --repo "$GH_REPO"`.

## 12. First deploy [needs app: both images published to GHCR, `/api/healthz`, `/api/readyz`, per-command config]
Replaced by deploy/cloudrun/*.yaml once that exists. The flags here are the spec.

Two images per commit, both built by CI (linux/amd64 only; never push a build from your Mac, which is arm64), both deployed by digest, **always from the same SHA**: the app's `/api/readyz` requires the newest migration that its build ships with.
- **App** `ghcr.io/${GH_REPO_LC}:sha-<sha>` → AR `…/shoestring/app`: the service and the purge, admin and rewrap-mfa jobs.
- **Migrate** `ghcr.io/$GH_REPO_LC-migrate:sha-<sha>` → AR `…/shoestring/migrate`: the `shoestring-migrate` job only. It holds the compiled migrate CLI, dbmate, `db/migrations` and `db/roles.sql`; the app image holds nothing of `db/`.
- GHCR paths are lowercase (`$GH_REPO_LC`, step 0); the GitHub repo slug has capitals.
- CI's `publish` job pushes all three images on every push to `main`, after check, e2e, audit and the image smoke pass, so an image exists only for a green main commit. It also attests each digest. **Verifying the attestation is mandatory** before every copy (F-67): copy by `@$DIGEST`, never by tag, and STOP if `gh attestation verify` fails (the `&&` below skips the copy).
- The three GHCR packages (app, migrate, backup) are **public** (owner ruling 2026-11-17; GHCR's free private storage is only 500 MB), so `crane digest` and `crane copy` read them **without any GitHub credential**: no `crane auth login ghcr.io`, no `read:packages` token. Only the AR side needs `gcloud auth configure-docker`. If GHCR answers `UNAUTHORIZED` or `DENIED`, a package has gone private: don't log crane in with a token; make it public again (owner only: `https://github.com/users/<owner>/packages/container/<package>/settings` → Danger Zone → Change visibility → Public) and tell the tech lead.
```sh
export SHA="<full git sha of a green main build>"
export AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/app"
export MIGRATE_AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/migrate"
gcloud auth configure-docker "$REGION-docker.pkg.dev"
ATTEST_FLAGS=(--repo "$GH_REPO" --signer-workflow "$GH_REPO/.github/workflows/ci.yml" --source-ref refs/heads/main --source-digest "$SHA" --deny-self-hosted-runners)   # --source-digest: built from exactly $SHA (F-67 re-check)
DIGEST=$(crane digest "ghcr.io/${GH_REPO_LC}:sha-$SHA")
gh attestation verify "oci://ghcr.io/$GH_REPO_LC@$DIGEST" "${ATTEST_FLAGS[@]}" \
  && crane copy "ghcr.io/$GH_REPO_LC@$DIGEST" "${AR_REPO}:sha-$SHA"
export IMAGE="$AR_REPO@$DIGEST"
MIGRATE_DIGEST=$(crane digest "ghcr.io/$GH_REPO_LC-migrate:sha-$SHA")
gh attestation verify "oci://ghcr.io/$GH_REPO_LC-migrate@$MIGRATE_DIGEST" "${ATTEST_FLAGS[@]}" \
  && crane copy "ghcr.io/$GH_REPO_LC-migrate@$MIGRATE_DIGEST" "${MIGRATE_AR_REPO}:sha-$SHA"
export MIGRATE_IMAGE="$MIGRATE_AR_REPO@$MIGRATE_DIGEST"
crane config "$IMAGE" | jq -r '.architecture'; crane config "$MIGRATE_IMAGE" | jq -r '.architecture'   # both: amd64
: "${SENTRY_DSN_API:?run step 11b S5 first}"     # shoestring-api DSN (not secret); purge needs it for the cron check-in
COMMON_ENV="NODE_ENV=production;APP_ORIGIN=https://shoestring.$DOMAIN;LOG_LEVEL=info;APP_RELEASE=$SHA;SENTRY_DSN=$SENTRY_DSN_API"
EMAIL_ENV="EMAIL_TRANSPORT=provider;EMAIL_FROM=Shoestring <no-reply@mail.$DOMAIN>;EMAIL_DAILY_QUOTA=100"
# The distroless images have no `node` on PATH: job commands use the absolute /nodejs/bin/node.
ADMIN_CMD="/nodejs/bin/node,/app/dist/admin.js"

# 12a. Migrate job: the migrate image's own entrypoint runs the migration (no --command, no --args).
#      Only MIGRATOR_DATABASE_URL (migrator role, Neon DIRECT endpoint, exactly ?sslmode=verify-full).
#      No Sentry: a failure shows only as a failed execution and in the job's logs. Never retried automatically.
#      Never set DATABASE_ADMIN_URL here (local/test only).
gcloud run jobs create shoestring-migrate --project "$PROJECT" --region "$REGION" --image "$MIGRATE_IMAGE" \
  --service-account "$(SA migrate)" \
  --set-secrets "MIGRATOR_DATABASE_URL=shoestring-migrator-database-url:1" \
  --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 10m --cpu 1 --memory 512Mi
gcloud run jobs execute shoestring-migrate --project "$PROJECT" --region "$REGION" --wait
#   Must succeed; its log ends with "migrate: done". A failure here (for example roles.sql's grant check,
#   if step 8 item 5 wasn't run as neondb_owner) stops the bootstrap: send the job log to the tech lead.

# 12b. Service (F-15: max 2 instances, concurrency 20)
gcloud run deploy shoestring --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA run)" --allow-unauthenticated --ingress all --port 8080 \
  --cpu 1 --memory 512Mi --concurrency 20 --min-instances 0 --max-instances 2 --timeout 30s \
  --cpu-boost --execution-environment gen1 \
  --startup-probe "httpGet.path=/api/healthz,httpGet.port=8080,periodSeconds=1,timeoutSeconds=1,failureThreshold=10" \
  --set-env-vars "^;^$COMMON_ENV;$EMAIL_ENV;WEBAUTHN_RP_ID=shoestring.$DOMAIN;WEBAUTHN_RP_NAME=Shoestring;COOKIE_SECURE=true;HIBP_ENABLED=true;TRUST_PROXY_HOPS=1" \
  --set-secrets "DATABASE_URL=shoestring-database-url:1,APP_KEYRING=shoestring-app-keyring:1,EMAIL_API_KEY=shoestring-email-api-key:1"
# If --startup-probe is rejected, use `gcloud beta run deploy` or drop the flag (default TCP probe) until service.yaml exists (verify).
# TRUST_PROXY_HOPS is required in production (config.ts refuses to start without it, or below 1; F-08). 1 is the
# expected Cloud Run value; step 14 measures it, and changes it there if the measurement differs. The jobs don't need it.

# 12c. Purge job (DATABASE_URL only, counts-only output; F-02)
gcloud run jobs create shoestring-purge --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA purge)" --command "$ADMIN_CMD" --args "purge,--yes" \
  --set-env-vars "^;^$COMMON_ENV" --set-secrets "DATABASE_URL=shoestring-database-url:1" \
  --tasks 1 --parallelism 1 --max-retries 1 --task-timeout 10m --cpu 1 --memory 512Mi

# 12d. Admin job (target email in --args, R-12 accepted; never retried, so no duplicate emails).
#      The CLI has no --help (it exits 2, "unknown command"), so the stored default args are a read-only
#      purge dry run: counts only, no writes, no email, no cron check-in, exit 0. Every real command
#      replaces them with --args at execution (admin-commands.md).
gcloud run jobs create shoestring-admin --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA admin)" --command "$ADMIN_CMD" --args "purge,--dry-run" \
  --set-env-vars "^;^$COMMON_ENV;$EMAIL_ENV" \
  --set-secrets "DATABASE_URL=shoestring-database-url:1,EMAIL_API_KEY=shoestring-email-api-key:1" \
  --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 5m --cpu 1 --memory 512Mi

# 12d2. Keyring rewrap job (DATABASE_URL + APP_KEYRING only; the default args are a harmless dry run)
gcloud run jobs create shoestring-rewrap-mfa --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA rewrap)" --command "$ADMIN_CMD" --args "rewrap-mfa,--dry-run" \
  --set-env-vars "^;^$COMMON_ENV" \
  --set-secrets "DATABASE_URL=shoestring-database-url:1,APP_KEYRING=shoestring-app-keyring:1" \
  --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 15m --cpu 1 --memory 512Mi

# 12e. Daily purge schedule (08:00 UTC, before the 09:15 backup; scheduler job 1 of 3 free)
gcloud run jobs add-iam-policy-binding shoestring-purge --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$(SA scheduler)" --role roles/run.invoker            # verify role (V25)
gcloud scheduler jobs create http shoestring-purge-daily --project "$PROJECT" --location "$REGION" \
  --schedule "0 8 * * *" --time-zone "Etc/UTC" --http-method POST \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/shoestring-purge:run" \
  --oauth-service-account-email "$(SA scheduler)"

# 12f. Registry tags for the rollback guard and the cleanup policy (each package has its own prod-current)
gcloud artifacts docker tags add "$IMAGE" "${AR_REPO}:prod-current"
gcloud artifacts docker tags add "$MIGRATE_IMAGE" "${MIGRATE_AR_REPO}:prod-current"

# 12h. Deployer rights on exactly the resources it manages (F-39). Never on shoestring-backup.
gcloud run services add-iam-policy-binding shoestring --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$(SA deployer)" --role roles/run.developer
for job in shoestring-migrate shoestring-purge shoestring-admin shoestring-rewrap-mfa; do
  gcloud run jobs add-iam-policy-binding "$job" --project "$PROJECT" --region "$REGION" \
    --member "serviceAccount:$(SA deployer)" --role roles/run.developer
done
gcloud run jobs get-iam-policy shoestring-backup --project "$PROJECT" --region "$REGION"   # must NOT list the deployer
```
The first GitHub deploy proves the scoping: if it fails with a permission error, add **only** the missing permission to `shoestring-deployer`'s custom project role (V36), never a `roles/run.*` project grant.

**Verify (steps 12a–12h):** the service takes 100% of traffic on its public `run.app` URL, so the probes below hit exactly what users will reach.
- **F-10 on `run.app` returns 400, not 404, and that is expected.** The app rejects any request whose `Host` isn't `shoestring.<domain>` before it looks up a route (backend/src/http/pipeline.ts `checkHost`), so on `run.app` the probe can only show the Host check working. `healthz`/`readyz` are exempt from that check. The real F-10 probe (expect **404**) runs on the custom domain after step 15 (step 15 Verify).
```sh
URL=$(gcloud run services describe shoestring --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
curl -fsS "$URL/api/healthz"; echo; curl -fsS "$URL/api/readyz"; echo
curl -s -X POST "$URL/api/_test/reset"; echo      # expect 400 VALIDATION_FAILED naming header Host (see above); 404 only after step 15
gcloud run jobs execute shoestring-admin --project "$PROJECT" --region "$REGION" --wait        # default args: read-only purge dry run; must succeed
gcloud run jobs execute shoestring-rewrap-mfa --project "$PROJECT" --region "$REGION" --wait   # default args: rewrap dry run; must succeed
gcloud scheduler jobs run shoestring-purge-daily --project "$PROJECT" --location "$REGION"   # one manual trigger; check the execution succeeds
```
- The two job runs prove the job command (`/nodejs/bin/node`) and each job's least config. Their logs show counts only.
- **`/api/_test/reset` on the custom domain (step 15) is not 404, or the `run.app` probe answers anything but the Host 400:** test hooks may be live in production. Close ingress at once (`gcloud run services update shoestring --ingress internal --region "$REGION" --project "$PROJECT"`) and tell the tech lead (security incident, F-10).
- **The service crashes at startup** (healthz never answers; the revision log names the variable): check the env list in 12b against infra/CLAUDE.md "Non-secret runtime config". config.ts refuses to start without `TRUST_PROXY_HOPS`, `EMAIL_DAILY_QUOTA` and the rest of the production settings.

Then run the **Sentry smoke check** in deploy.md "Verify → Sentry" (the purge check-in, the release in the bundle, and the CSP host). Do it after step 13, so the `purge` monitor exists to receive the check-in, **and after step 15**: it fetches the SPA from `https://shoestring.<domain>`, which doesn't resolve until then (`curl: (6) Could not resolve host`).

**After the second deploy** (done 2026-11-23), switch the AR cleanup policy from dry-run to live: billing-protection.md **§5b**, blocks A–F in order. Blocks A–C are read-only gates (the policy matches the file, every image production uses has a `prod-` tag, nothing referenced would be deleted). Block D is the one change, and E–F verify it. Record the date in row 3b of the Record table below.

### 12g. Nightly backup job [needs only the backup image, not the app]
This can run as soon as ci-engineer publishes the backup image (`Dockerfile.backup`) and step 13's heartbeat exists. Run it before any real user data exists, so the restore drill has something to restore.
```sh
export BACKUP_SHA="<full git sha of any green main build; publish pushes the backup image on every main commit>"
export BK_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/backup"
BK_DIGEST=$(crane digest "ghcr.io/$GH_REPO_LC-backup:sha-$BACKUP_SHA")
gh attestation verify "oci://ghcr.io/$GH_REPO_LC-backup@$BK_DIGEST" --repo "$GH_REPO" \
  --signer-workflow "$GH_REPO/.github/workflows/ci.yml" --source-ref refs/heads/main --source-digest "$BACKUP_SHA" --deny-self-hosted-runners \
  && crane copy "ghcr.io/$GH_REPO_LC-backup@$BK_DIGEST" "${BK_REPO}:sha-$BACKUP_SHA"   # mandatory (F-67); STOP on failure
gcloud artifacts docker tags add "$BK_REPO@$BK_DIGEST" "${BK_REPO}:prod-backup"     # protected by the prod- keep rule
export AGE_PUBLIC_KEY="<age1... public key from step 7>"      # not secret; the bare age1… value, no "# public key:" prefix
export HEARTBEAT_URL="<Better Stack heartbeat URL from step 13>"  # plain config, see infra/CLAUDE.md
# Add both lines to ~/shoestring-prod.env. Guards (they print STOP but do not halt a pasted block): an empty or malformed value would create a job that fails every night.
# Run these three guard lines ON THEIR OWN first. Continue only if they print "age recipient OK", no error, and 1.
case "$AGE_PUBLIC_KEY" in age1?*) [ ${#AGE_PUBLIC_KEY} -eq 62 ] && echo "age recipient OK" || echo "STOP: age recipient is not 62 characters" ;; *) echo "STOP: AGE_PUBLIC_KEY must start with age1" ;; esac
: "${HEARTBEAT_URL:?set HEARTBEAT_URL first}"
# The backup URL is read by pg_dump (libpq), so it MUST carry sslrootcert=system (step 8 item 6). Prints 1, never the URL.
# The job below pins secret version 1, so check that version (if the job pins another, check that one):
gcloud secrets versions access 1 --secret shoestring-backup-database-url --project "$PROJECT" | grep -c 'sslmode=verify-full&sslrootcert=system'

gcloud run jobs create shoestring-backup --project "$PROJECT" --region "$REGION" --image "$BK_REPO@$BK_DIGEST" \
  --service-account "$(SA backup)" \
  --set-env-vars "^;^BACKUP_BUCKET=$BACKUP_BUCKET;BACKUP_AGE_RECIPIENT=$AGE_PUBLIC_KEY;BACKUP_HEARTBEAT_URL=$HEARTBEAT_URL" \
  --set-secrets "BACKUP_DATABASE_URL=shoestring-backup-database-url:1" \
  --tasks 1 --parallelism 1 --max-retries 1 --task-timeout 15m --cpu 1 --memory 512Mi

gcloud run jobs add-iam-policy-binding shoestring-backup --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$(SA scheduler)" --role roles/run.invoker            # verify role (V25)
gcloud scheduler jobs create http shoestring-backup-nightly --project "$PROJECT" --location "$REGION" \
  --schedule "15 9 * * *" --time-zone "Etc/UTC" --http-method POST \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/shoestring-backup:run" \
  --oauth-service-account-email "$(SA scheduler)"                              # scheduler job 2 of 3 free

gcloud run jobs execute shoestring-backup --project "$PROJECT" --region "$REGION" --wait   # first run now
gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/"
```
**Verify:** one `daily/shoestring-<timestamp>.dump.age` object exists, and the heartbeat turns green. The job log shows only the object name and byte count. `gcloud scheduler jobs list --location "$REGION" --project "$PROJECT"` shows exactly 2 jobs. Then run the **restore drill** (restore.md path C) against this dump.
**Back out:** `gcloud scheduler jobs pause shoestring-backup-nightly ...` (a missed backup alerts within 26 h).

**Rolling the backup image (F-68).** The backup job is **not** redeployed with app releases, so its digest only changes here. Roll it when the image scan or Dependabot flags the backup image's base (`Dockerfile.backup`) or its apk packages (openssl, libpq, curl, musl), once a green main build contains the fix; also roll it whenever `deploy/backup/` changes. Use the same `BACKUP_SHA`, `BK_DIGEST`, verify and copy lines as above, then:
```sh
PREV_BK_IMAGE=$(gcloud run jobs describe shoestring-backup --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.template.spec.containers[0].image)'); echo "previous: $PREV_BK_IMAGE"   # record it
gcloud artifacts docker tags add "$BK_REPO@$BK_DIGEST" "${BK_REPO}:prod-backup"
gcloud run jobs update shoestring-backup --project "$PROJECT" --region "$REGION" --image "$BK_REPO@$BK_DIGEST"
gcloud run jobs execute shoestring-backup --project "$PROJECT" --region "$REGION" --wait
```
**Verify:** a new `daily/` object and a green heartbeat, as above. **Back out:** `gcloud run jobs update shoestring-backup --project "$PROJECT" --region "$REGION" --image "$PREV_BK_IMAGE"`, and move `prod-backup` back with `gcloud artifacts docker tags add "$PREV_BK_IMAGE" "${BK_REPO}:prod-backup"`.

## 13. Monitoring [needs app for A3 and A6]
Better Stack: follow **observability/README.md** "Better Stack Uptime":
- the `shoestring-healthz` monitor (after step 15)
- the `shoestring-backup` heartbeat (its URL becomes `BACKUP_HEARTBEAT_URL` on the backup job, step 12g)
- mobile app push

Sentry: the steps below. They need step 11b. The UI paths follow Sentry's current "Monitors and Alerts" layout (docs.sentry.io, checked 2026-11-16). If a label differs, keep the values and tell the tech lead, so this runbook can be corrected.

**13A. How alerts reach your phone.** The Developer plan sends alerts **by email only**. Slack, Discord and webhooks are Team-plan features, and Sentry's own mobile app is unmaintained and not in the US App Store (checked 2026-11-16). Phone push therefore comes from your mail app, the same way the GCP budget alerts do:
1. Avatar → **User Settings → Notifications**: **Issue Alerts** = on, delivery **Email**. **Spike Protection** = on (email).
2. After the first test notification in 13C arrives, open it in Gmail on the web → ⋮ → **Filter messages like this**. The "From" box is prefilled with Sentry's sender (`noreply@md.getsentry.com`, recorded 2026-11-23, V40) → **Create filter**, then tick:
   - **Apply the label** `Shoestring alerts` (new label)
   - **Never send it to Spam**
   - **Always mark it as important**
3. Gmail app on the phone → Settings → your account → **Notifications** → **All** (or **High priority only**, which includes "important"). Allow notifications for Gmail in the phone's settings.

**13B. Cron monitor `purge` (alert A3).** **Monitors → Crons** (older menus: **Crons** in the sidebar) → **Add Monitor** (or **Create Monitor**). Choose the manual setup, not an SDK snippet:
| Field | Value |
|---|---|
| Project | `shoestring-api` |
| Name / Slug | `purge` / `purge` (the slug must match the backend's check-in exactly) |
| Schedule | Crontab `0 8 * * *`, timezone **UTC** |
| Grace period (check-in margin) | **60** minutes |
| Max runtime | **15** minutes (the job's task timeout is 10 min) |
| Failure tolerance (consecutive failed or missed check-ins before an issue) | **1** |
| Recovery tolerance | **1** |
| Owner | you |
| Environment | the backend sends `production`; leave the monitor's environment selection at its default |
- The Developer plan includes **exactly 1** cron monitor. Never create a second one. A typo in the backend's slug would make it auto-create another monitor, which can't be activated after the trial: check that **Monitors → Crons lists exactly one monitor**.
- If the form has a "Notify" or "Alerts" section, use it for the alert below instead of creating a separate one.

**13C. Alert rules.** **Monitors → Alerts → Create Alert** (older menus: **Alerts → Create Alert → Issues**). After each one, open its If/Then block and click **Send Test Notification**, and check that the email and phone push arrive.
| Name | Alert | Source | Environment | When (any) | If (**all**) | Then | Throttle |
|---|---|---|---|---|---|---|---|
| `error-new` | A2 | All issues in selected projects: `shoestring-api`, `shoestring-web` | `production` | A new issue is created · A resolved issue regresses · An issue escalates | Issue category **equal to** `error` | Notify on preferred channel → **Member: you** | **30 minutes** |
| `error-spike` | A2 | same | `production` | An event or issue activity is captured | Issue category **equal to** `error` · Number of events **more than 10 in 15 minutes** · Event attribute `message` **does not contain** `email_quota_threshold` | Member: you | **30 minutes** |
| `purge-cron` | A3 | Alert on specific monitors → **Connect Monitors** → `purge` | `production` | A new issue is created · A resolved issue regresses | *(none)* | Member: you | Get notified on every trigger |
| `email-quota-warning` | A6 | `shoestring-api` | `production` | An event or issue activity is captured | Event attribute `message` **contains** `email_quota_threshold` · Event level **equal to** `warning` | Member: you | **12 hours** |
| `email-quota-exhausted` | A6 | `shoestring-api` | `production` | An event or issue activity is captured | Event attribute `message` **contains** `email_quota_threshold` · Event level **greater than or equal to** `error` | Member: you | **12 hours** |
- **Why this shape (Sentry's alert builder):**
  - Frequency windows are 5 min, 15 min, 1 h and so on; there is no 10-minute window, so A2 uses 15 minutes.
  - Throttle options don't include 6 hours.
  - Fingerprints can't be filtered, so A6 matches the fixed message prefix `email_quota_threshold:` (underscores; backend `ALERTS` in backend/src/observability/error-tracker.ts). The fingerprint `email-quota-threshold` (hyphens) only groups the events into one issue.
  - Throttling applies per alert and per issue, so the 60% warning and the 100% error are separate alerts. That way the error isn't silenced by the warning sent earlier the same day.
  - The warning is at **60%**, the point where non-priority mail (password resets, budget invitations) stops (F-60, owner ruling 2026-11-17). The rules match only the `email_quota_threshold` prefix and the level, never the percentage, so they don't change when the threshold does.
  - `error-spike` excludes the quota events. `error-new` can't: Sentry applies event-attribute filters only to the "new issue" and "event captured" triggers.
    - So the **first** quota event of each kind, and any later one after you resolve its issue, also sends an `error-new` email.
    - That is expected, and rare. email-quota.md says to leave those issues unresolved.
- **If the "Number of events" filter isn't offered** (the pricing table lists "Additional Alert Types" for Team and above, V39): skip `error-spike`. `error-new` with "An issue escalates" (Sentry's own spike detection) then covers A2. Record that in observability/README.md.

**13D. Optional CLI route for 13B and 13C** (see "Sentry CLI" in step 11b). The tables above stay the spec; the CLI only saves clicking. Do the 13A Gmail filter, the **Send Test Notification** checks and the Verify list below in the UI either way.
- Alert rules: `sentry alert issues create "$SENTRY_ORG/<project>" --name <name> --condition … --filter … --filter-match all --action … --environment production --frequency <minutes> --dry-run`. Conditions, filters and actions are Sentry's workflow JSON (`sentry alert issues create --help`). Check every printed `body` against its 13C row (triggers, filters, "all", member = you, throttle 30 or 720 minutes), then run it without `--dry-run`. `sentry alert issues list "$SENTRY_ORG/shoestring-api"` lists the result. `error-new` and `error-spike` cover both projects: create each one per project, or in the UI if a rule covering both is needed.
- Cron monitor (only if none exists yet; never a second one):
  ```sh
  sentry api "organizations/$SENTRY_ORG/monitors/" -X POST --dry-run -d '{"project":"shoestring-api","name":"purge","slug":"purge","type":"cron_job",
    "config":{"schedule_type":"crontab","schedule":"0 8 * * *","timezone":"UTC","checkin_margin":60,"max_runtime":15,"failure_issue_threshold":1,"recovery_threshold":1}}'
  # check the printed body, then run the same command without --dry-run
  sentry api "organizations/$SENTRY_ORG/monitors/" | jq '[.[].slug]'      # exactly ["purge"]
  ```
  Set the owner to you in the UI afterwards if the API left it empty.
- If Sentry rejects a body, stop and send the error to the tech lead rather than adjusting values by trial and error.
- Then `sentry auth logout` (step 11b, "Sentry CLI").

**Verify:**
- Better Stack "Send test alert" and every Sentry "Send Test Notification" arrive as email **and** as a phone notification.
- Monitors → Alerts lists the 5 rules above.
- Monitors → Crons lists exactly 1 monitor (`purge`).
- After step 12's manual purge trigger, `purge` shows a green check-in.

## 14. Measure the proxy hop count on BOTH public paths (F-08, F-65, V26)
The service answers on two public URLs, its `run.app` URL and the custom domain, and the one `TRUST_PROXY_HOPS` value applies to both. So the hop count is measured on **both paths, and both measurements are mandatory** (launch blocker).

A throwaway echo service shows exactly what the app will see in `X-Forwarded-For`. It's a third-party Docker Hub image, so replace `:latest` with the digest you see on Docker Hub (`@sha256:…`) before running. It runs as a service account with no permissions, is private (you call it with your identity token), and is deleted straight after.

**14a. The `run.app` path**
```sh
gcloud iam service-accounts create shoestring-probe --project "$PROJECT" --display-name "XFF probe (temporary)"
gcloud run deploy xff-probe --project "$PROJECT" --region "$REGION" \
  --image docker.io/mendhak/http-https-echo:latest --port 8080 \
  --service-account "$(SA probe)" --no-allow-unauthenticated --max-instances 1
P=$(gcloud run services describe xff-probe --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "X-Forwarded-For: 203.0.113.7" "$P/" \
  | jq '{xff: .headers["x-forwarded-for"], forwarded: .headers["forwarded"]}'
```

**14b. The domain-mapping path (mandatory).** Do it after step 15 item 1 (domain verified with Google). Map a temporary `xff-probe.<domain>` exactly like step 15 items 2–5: the Cloudflare CNAME `xff-probe` → `ghs.googlehosted.com`, **DNS only (grey cloud)**, then wait for `CertificateProvisioned: True`.
- Create the mapping **after** the CNAME resolves (`dig +short CNAME "xff-probe.${DOMAIN}"` prints `ghs.googlehosted.com.`). A mapping created first reports "challenge data was not visible" and then retries only every 24 h. If that happened, delete and recreate the mapping.
```sh
gcloud beta run domain-mappings create --service xff-probe --domain "xff-probe.$DOMAIN" --region "$REGION" --project "$PROJECT"
gcloud beta run domain-mappings describe --domain "xff-probe.$DOMAIN" --region "$REGION" --project "$PROJECT" \
  --format "yaml(status.conditions)"                                   # repeat until CertificateProvisioned: True
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "X-Forwarded-For: 203.0.113.7" "https://xff-probe.$DOMAIN/" \
  | jq '{xff: .headers["x-forwarded-for"], forwarded: .headers["forwarded"]}'
```
If the custom-domain call is refused with 401/403 (the identity token's audience; verify), tell the tech lead rather than making the probe public.

**Reading the results**
- **Expected on both paths:** `"203.0.113.7, <your public IP>"`. The platform appends **one** entry, so the hop count is **1**, and the forged value is ignored.
- The hop count is the service's `TRUST_PROXY_HOPS` env var (backend reads it into Fastify `trustProxy`; config.ts refuses to start in production without it or below 1). Step 12b set it to `1`.
- **Both paths 1:** nothing to change. Confirm what the service runs with:
  ```sh
  gcloud run services describe shoestring --project "$PROJECT" --region "$REGION" --format=json \
    | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="TRUST_PROXY_HOPS") | .value'    # 1
  ```
- **The two paths differ: STOP. Don't change `TRUST_PROXY_HOPS`, and don't launch.** No single value is safe while both URLs are public. Too low on the domain path puts every user behind the proxy's one address, so one attacker can fill the shared per-IP limits and lock everyone out. Too high on `run.app` lets a client forge its IP (F-08). Tell the tech lead, who escalates to **security-reviewer** (options include closing the `run.app` path or a backend change; that's their call, not a runbook step).
- **Both paths agree on 2 or more:** the hop count is that number. **Stop and tell the tech lead first** (security-reviewer checks it, ADR-0007 records it). Then, once agreed, set it through a gated revision (deploy.md steps 4–6 shape): `gcloud run services update shoestring --update-env-vars TRUST_PROXY_HOPS=<n> --no-traffic --tag candidate --region "$REGION" --project "$PROJECT"`, check the candidate's `/api/readyz`, shift traffic, and remove the tag.
- Record **both** results, with the date, in infra/CLAUDE.md "Client IP".

Clean up (after 14b):
```sh
gcloud beta run domain-mappings delete --domain "xff-probe.$DOMAIN" --region "$REGION" --project "$PROJECT" --quiet
#   then delete the xff-probe CNAME in Cloudflare
gcloud run services delete xff-probe --project "$PROJECT" --region "$REGION" --quiet
gcloud iam service-accounts delete "$(SA probe)" --project "$PROJECT" --quiet
```

## 15. Custom domain: Cloud Run domain mapping with Cloudflare DNS
1. **Verify domain ownership with Google** (one-time):
   ```sh
   gcloud domains verify "$DOMAIN"        # opens Search Console; choose the TXT record method
   ```
   Cloudflare → DNS → Add record: Type `TXT`, Name `@`, Content `google-site-verification=…`. Back in Search Console, click **Verify**. Check with `gcloud domains list-user-verified`.
2. **Create the mapping:**
   ```sh
   gcloud beta run domain-mappings create --service shoestring --domain "shoestring.$DOMAIN" --region "$REGION" --project "$PROJECT"
   gcloud beta run domain-mappings describe --domain "shoestring.$DOMAIN" --region "$REGION" --project "$PROJECT" \
     --format "yaml(status.resourceRecords,status.conditions)"
   ```
3. **Cloudflare record:** Type `CNAME`, Name `shoestring`, Target `ghs.googlehosted.com`, Proxy status **DNS only (grey cloud)**, TTL Auto. It must not be proxied: Google has to see its own front end to issue the certificate, and the hop count from step 14 assumes no proxy.
4. **CAA:** `dig +short CAA "$DOMAIN"`. If anything comes back, add CAA records on `shoestring`: `0 issue "pki.goog"` and `0 issue "letsencrypt.org"`.
5. Wait for `CertificateProvisioned: True` in the describe output (15 minutes to 24 hours).

**Verify:**
```sh
dig +short "shoestring.$DOMAIN"        # Google addresses via ghs.googlehosted.com, NOT Cloudflare 104.x/172.x ranges
curl -sSI "https://shoestring.$DOMAIN/" | grep -iE 'strict-transport-security|content-security-policy|x-content-type-options'
curl -sSI "https://shoestring.$DOMAIN/api/healthz" | grep -i 'cache-control'     # no-store
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://shoestring.$DOMAIN/api/_test/reset"   # must be 404 (F-10); else step 12 Verify's incident line
```
**Back out:** delete the CNAME in Cloudflare and run `gcloud beta run domain-mappings delete --domain "shoestring.$DOMAIN" --region "$REGION" --project "$PROJECT"`.
**Fallback** (mapping unavailable or failing): the Cloudflare proxy, infra/hosting-evaluation.md §3a. **Switch it on only after a security-reviewer review and sign-off** (owner ruling 2026-11-13), plus the backend change it needs. Until then the record stays DNS only.

## 16. Launch measurements [needs app]
| ☐ | Check | How | Pass |
|---|---|---|---|
| ☑ | **Cold start (V9)** | **Waived by owner 2026-11-23** (not measured): two beta users in daily use, no slow first loads noticed. Measure if anyone reports one: Cloud Monitoring `run.googleapis.com/request_latencies` (free) or the original 20-sample method | Not measured; accepted on real use |
| ☑ | **Neon sleeps (V23)** | Neon Console → Usage, 2026-11-23: **1.25 CU-hrs** since 2026-11-18 (≈ 7–8 CU-hrs/month; never sleeping would be ≈ 186), storage 32.69 MB | Pass: compute suspends when idle |
| ☑ | Test hooks absent (F-10) | Step 15 Verify (custom domain) | 404 (2026-11-23) |
| ☑ | Phone journeys | Owner + one invited beta user using the app daily since 2026-11-20, no issues seen (owner, 2026-11-23) | Pass (real use) |
| ☑ | **Hop count measured on both paths (V26, F-65)**: 1 and 1, 2026-11-23 | Step 14a (`run.app`) **and** 14b (domain mapping), both recorded in infra/CLAUDE.md "Client IP"; they agree, and the service's `TRUST_PROXY_HOPS` matches | **Launch blocker** (security-reviewer) |
| ☐ | **DMARC at `p=reject`** | `dig +short TXT "_dmarc.mail.$DOMAIN"` | **Launch blocker** (F-29) |
| ☑ | Admin args retention (V34) | Measured 2026-11-23 from existing runs (infra/hosting-evaluation.md V34) | System Event audit log 400 days + execution record (no limit); privacy wording in admin-commands.md (R-12) |
| ☑ | Backups (first dump and green heartbeat 2026-11-23) | `gcloud run jobs execute shoestring-backup --project "$PROJECT" --region "$REGION" --wait`, then `gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/"`; next morning, confirm the 09:15 scheduled run | Objects present; heartbeat green |
| ☑ | **Restore drill** (passed 2026-11-23, 18 min) | restore.md path C | Passes; recorded in README.md |
| ☐ | Billing | After 7 days, billing-protection.md §11 check 1 | $0.00 net |

## Record
| Step | Done (date) | Notes (no secrets) |
|---|---|---|
| 1 Operator MFA | | |
| 2 Billing, spend cap (V0 result) | | |
| 3–7 GCP setup | 2026-11-19 | Suffix `ssba`. WIF member first bound to a zsh-mangled subject (`…/subject/nvironment:production`); rebound correctly 2026-11-19 |
| 3b AR cleanup policy live (billing-protection.md §5b; dry-run since 2026-11-18) | ____ (not yet) | Blocks A–C read-only result 2026-11-23 (sre): policy matches the file; 7 of 7 references `prod-` tagged; nothing would be deleted. Owner fills in: date/time D ran, block E result, next-day block F result |
| 8 Neon (`version()` result) | 2026-11-19 | 17.12 |
| 9–11 Secrets, GitHub, email | | |
| 11b Sentry (org slug; trial end date; plan shown after the trial; canary result) | 2026-11-17 (S1–S9, run by the tech lead through the Sentry CLI with the owner's authorisation; S6 token in the browser UI) | Org "Cameron Hardy", slug `cameron-hardy`, region US. Trial ends **2026-12-01**: check Subscription shows Developer after that (V41). Projects `shoestring-api` (node, id 4512447711019008) and `shoestring-web` (javascript, id 4512447711084545); both DSNs on host `o4512447486558208.ingest.us.sentry.io` (S5 pass). Replace rules use `[Filtered]`; `scrubIPAddresses` and `scrapeJavaScript` set per project. Spike protection: one action per project. Org token created in the UI (API refused it). GitHub environment `sentry` had been auto-created by CI with no branch policy; main-only policy added and checked. **Canary passed on both projects** (checked through the API), including the value-only match `note: "payee …-value-match"`. The owner deletes the two canary issues in the UI (needs `event:admin`, which the CLI lacks). S10 and step 13 pending. Sentry CLI login expires ~2026-12-15; logged out: ____ |
| 12–13 First deploy, monitoring | 2026-11-19 (deploy), 2026-11-23 (backup job fixed, Sentry 13C) | Release `30577e54226e96551c3382ee6c3ec02b116338e4`, revision `shoestring-00001-sg9`. Backup failed 2026-11-20→22 (empty age recipient, then the backup URL lacked `sslrootcert=system`); fixed 2026-11-23, secret v2. Sentry: 5 rules, sender V40 above |
| 14 Hop count (`run.app` = 1, domain mapping = 1) | 2026-11-23 | Both `"203.0.113.7,<client IP>"`; `TRUST_PROXY_HOPS=1` unchanged. Probe service, mapping, SA and CNAME deleted. Security-reviewer sign-off: see PR |
| 15 Domain | by 2026-11-23 | `shoestring.cameronhardy.work`, CNAME DNS only, certificate provisioned; F-10 404 |
| 16 Launch checks | | |

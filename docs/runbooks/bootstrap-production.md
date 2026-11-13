# Bootstrap production (one time, owner runs it)
- Owner: sre · Runs: **owner only** · Status: **DRAFT.** Steps 1–11 can run now. Steps marked **[needs app]** wait for the first image and the backend features they name.
- Decisions applied: Cloud Run us-east1 + Neon aws-us-east-1, spend cap, DNS on Cloudflare, admin commands as Cloud Run jobs, backups by a Cloud Run job to a private GCS bucket in a separate project (docs/mvp-planning/10-contract-review-decisions.md).
- Conventions: infra/CLAUDE.md. Cost controls: billing-protection.md. Alerts: observability/README.md.

**How to use this runbook**
- Run each block in order, in one terminal session, from the repo root. Tick the checkbox when its **Verify** passes.
- If a command fails because a flag or role has changed (items marked "verify"), stop and send the error to the tech lead. Don't improvise against production.
- **Before any step that handles key material** (steps 7, 9 and 11, rotations, restores; F-40): turn **off Handoff** (System Settings → General → AirDrop & Handoff → "Allow Handoff between this Mac and your iCloud devices"), so Universal Clipboard doesn't copy keys to your other devices. Quit or pause any **clipboard manager or history tool**. Turn Handoff back on afterwards. Better still, pipe secrets straight into your password manager's CLI instead of the clipboard, if it has one.
- **Never paste a secret** into a command line, chat, ticket or file. Every secret is entered at a `read -rs` prompt or moved through the clipboard straight into a store.

## 0. Tools and variables
```sh
brew install --cask google-cloud-sdk
brew install gh jq age crane postgresql@17      # psql/pg_dump/pg_restore 17 (local Postgres is 17.12)
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
gcloud auth login && gh auth login

export DOMAIN="<your domain>"                   # e.g. example.com (not secret)
export GH_REPO="<owner>/<repo>"
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
| ☐ | Sentry | Google/GitHub sign-in or WebAuthn 2FA; org setting "Require Two-Factor Authentication" on | | |
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
Run **billing-protection.md §5** (create the `shoestring` repository and set the cleanup policy to dry-run).

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
  --attribute-condition "assertion.repository_id=='$GH_REPO_ID' && assertion.repository_owner_id=='$GH_OWNER_ID' && assertion.ref=='refs/heads/main'"

POOL="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github"
gcloud iam service-accounts add-iam-policy-binding "$(SA deployer)" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/$POOL/subject/repo:$GH_REPO:environment:production"
```
This is the **only** WIF binding: there is no GitHub backup identity. **Verify:** `gcloud iam workload-identity-pools providers describe github-oidc --workload-identity-pool github --location global --project "$PROJECT" --format="yaml(attributeCondition,state)"` shows the condition and `ACTIVE`. **Back out:** `gcloud iam workload-identity-pools providers update-oidc github-oidc ... --disabled` (verify flag).

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
5. **Roles (least privilege, F-28) [needs db/]:** connect as the default owner role from your Mac, run data-engineer's role script, and set each password with `\password`. psql hashes it locally, so the password never appears in SQL history or Neon's query log.
   ```sh
   read -rs OWNER_URL; export OWNER_URL      # Neon → Connect → role neondb_owner, DIRECT, append ?sslmode=verify-full&sslrootcert=system
   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f db/roles.sql     # creates app, migrator, backup (data-engineer; path to confirm)
   psql "$OWNER_URL"
   ```
   Inside psql, for each role, paste a fresh 40-character random password from your password manager (generate with `openssl rand -base64 48 | tr -d '/+=' | cut -c1-40`, saved there first):
   ```
   \password app
   \password migrator
   \password backup
   \q
   ```
   Then `unset OWNER_URL`. The app never uses `neondb_owner`.
6. **Build the three URLs** in your password manager (never in a file). Host names come from Neon → Connect.
   - `app`, **pooled**: `postgresql://app:<pw>@<endpoint>-pooler.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full`
   - `migrator`, **direct**: `postgresql://migrator:<pw>@<endpoint>.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full`
   - `backup`, **direct**: `postgresql://backup:<pw>@<endpoint>.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full&sslrootcert=system`

**Verify:** `read -rs U; psql "$U" -Atc "select current_user, current_setting('server_version')"; unset U` for each URL prints the right role. With the backup URL, `create table x(i int)` must fail (read-only).

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
  --member "serviceAccount:$(SA $2)" --role roles/secretmanager.secretAccessor >/dev/null && echo "granted $1 → $2"; }
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
**Verify:** `gh api "repos/$GH_REPO/environments" --jq '.environments[] | {name, protection_rules}'` shows only `production`. `gh secret list --repo "$GH_REPO"` and `gh secret list --env production --repo "$GH_REPO"` show no database or backup secret.

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

## 12. First deploy [needs app: image, `/api/healthz`, `/api/readyz`, migrate entrypoint, per-command config]
Replaced by deploy/cloudrun/*.yaml once that exists. The flags here are the spec.
```sh
export SHA="<full git sha of a green main build>"
export AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/app"
gcloud auth configure-docker "$REGION-docker.pkg.dev"
DIGEST=$(crane digest "ghcr.io/$GH_REPO:sha-$SHA"); crane copy "ghcr.io/$GH_REPO:sha-$SHA" "$AR_REPO:sha-$SHA"
export IMAGE="$AR_REPO@$DIGEST"
export SENTRY_DSN_API="<DSN of the shoestring-api Sentry project (not secret)>"
COMMON_ENV="NODE_ENV=production;APP_ORIGIN=https://shoestring.$DOMAIN;LOG_LEVEL=info;APP_RELEASE=$SHA;SENTRY_DSN=$SENTRY_DSN_API"
EMAIL_ENV="EMAIL_TRANSPORT=provider;EMAIL_FROM=Shoestring <no-reply@mail.$DOMAIN>;EMAIL_DAILY_QUOTA=100"

# 12a. Migrate job (migrator secret only; never retried automatically)
gcloud run jobs create shoestring-migrate --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA migrate)" --command "<migrate entrypoint, from ci/data-engineer>" \
  --set-env-vars "^;^$COMMON_ENV" \
  --set-secrets "MIGRATOR_DATABASE_URL=shoestring-migrator-database-url:1" \
  --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 10m --cpu 1 --memory 512Mi
gcloud run jobs execute shoestring-migrate --project "$PROJECT" --region "$REGION" --wait

# 12b. Service (F-15: max 2 instances, concurrency 20)
gcloud run deploy shoestring --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA run)" --allow-unauthenticated --ingress all --port 8080 \
  --cpu 1 --memory 512Mi --concurrency 20 --min-instances 0 --max-instances 2 --timeout 30s \
  --cpu-boost --execution-environment gen1 \
  --startup-probe "httpGet.path=/api/healthz,httpGet.port=8080,periodSeconds=1,timeoutSeconds=1,failureThreshold=10" \
  --set-env-vars "^;^$COMMON_ENV;$EMAIL_ENV;WEBAUTHN_RP_ID=shoestring.$DOMAIN;WEBAUTHN_RP_NAME=Shoestring;COOKIE_SECURE=true;HIBP_ENABLED=true" \
  --set-secrets "DATABASE_URL=shoestring-database-url:1,APP_KEYRING=shoestring-app-keyring:1,EMAIL_API_KEY=shoestring-email-api-key:1"
# If --startup-probe is rejected, use `gcloud beta run deploy` or drop the flag (default TCP probe) until service.yaml exists (verify).

# 12c. Purge job (DATABASE_URL only, counts-only output; F-02)
gcloud run jobs create shoestring-purge --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA purge)" --command "node,dist/admin.js" --args "purge,--yes" \
  --set-env-vars "^;^$COMMON_ENV" --set-secrets "DATABASE_URL=shoestring-database-url:1" \
  --tasks 1 --parallelism 1 --max-retries 1 --task-timeout 10m --cpu 1 --memory 512Mi

# 12d. Admin job (target email in --args, R-12 accepted; never retried, so no duplicate emails)
gcloud run jobs create shoestring-admin --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA admin)" --command "node,dist/admin.js" --args "--help" \
  --set-env-vars "^;^$COMMON_ENV;$EMAIL_ENV" \
  --set-secrets "DATABASE_URL=shoestring-database-url:1,EMAIL_API_KEY=shoestring-email-api-key:1" \
  --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 5m --cpu 1 --memory 512Mi

# 12d2. Keyring rewrap job (DATABASE_URL + APP_KEYRING only; the default args are a harmless dry run)
gcloud run jobs create shoestring-rewrap-mfa --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$(SA rewrap)" --command "node,dist/admin.js" --args "rewrap-mfa,--dry-run" \
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

# 12f. Registry tags for the rollback guard
gcloud artifacts docker tags add "$IMAGE" "$AR_REPO:prod-current"

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

### 12g. Nightly backup job [needs only the backup image, not the app]
This can run as soon as ci-engineer publishes the backup image (`Dockerfile.backup`) and step 13's heartbeat exists. Run it before any real user data exists, so the restore drill has something to restore.
```sh
export BACKUP_SHA="<full git sha of the backup image build>"
export BK_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/backup"
BK_DIGEST=$(crane digest "ghcr.io/$GH_REPO-backup:sha-$BACKUP_SHA")
crane copy "ghcr.io/$GH_REPO-backup:sha-$BACKUP_SHA" "$BK_REPO:sha-$BACKUP_SHA"
gcloud artifacts docker tags add "$BK_REPO@$BK_DIGEST" "$BK_REPO:prod-backup"     # protected by the prod- keep rule
export AGE_PUBLIC_KEY="<age1... public key from step 7>"      # not secret
export HEARTBEAT_URL="<Better Stack heartbeat URL from step 13>"  # plain config, see infra/CLAUDE.md

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
**Verify:**
```sh
URL=$(gcloud run services describe shoestring --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
curl -fsS "$URL/api/healthz"; echo; curl -fsS "$URL/api/readyz"; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/_test/reset"      # must be 404 (F-10)
gcloud scheduler jobs run shoestring-purge-daily --project "$PROJECT" --location "$REGION"   # one manual trigger; check the execution succeeds
```
After two deploys, switch the AR cleanup policy from dry-run to live (billing-protection.md §5).

## 13. Monitoring [needs app for A3 and A6]
Follow **observability/README.md**:
- Sentry: two projects, the Security & Privacy settings (F-07), `error-spike` and `email-quota` alert rules, `purge` cron monitor, mobile app push.
- Better Stack: `shoestring-healthz` monitor (after step 15), `shoestring-backup` heartbeat (its URL becomes `BACKUP_HEARTBEAT_URL` on the backup job, step 12g), mobile app push.

**Verify:** Better Stack "Send test alert" and a Sentry test notification both reach your phone as push **and** email.

## 14. Measure the proxy hop count (F-08, V26)
A throwaway echo service shows exactly what the app will see in `X-Forwarded-For`. It's a third-party Docker Hub image, so replace `:latest` with the digest you see on Docker Hub (`@sha256:…`) before running. It runs as a service account with no permissions, is private (you call it with your identity token), and is deleted straight after.
```sh
gcloud iam service-accounts create shoestring-probe --project "$PROJECT" --display-name "XFF probe (temporary)"
gcloud run deploy xff-probe --project "$PROJECT" --region "$REGION" \
  --image docker.io/mendhak/http-https-echo:latest --port 8080 \
  --service-account "$(SA probe)" --no-allow-unauthenticated --max-instances 1
P=$(gcloud run services describe xff-probe --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "X-Forwarded-For: 203.0.113.7" "$P/" \
  | jq '{xff: .headers["x-forwarded-for"], forwarded: .headers["forwarded"]}'
```
- **Expected:** `"203.0.113.7, <your public IP>"`. The platform appends **one** entry, so the hop count is **1**, and the forged value is ignored.
- If two or more entries are appended, the hop count is that number. Tell the tech lead, so backend sets `trustProxy` to it and ADR-0007 records it.
- Record the result in infra/CLAUDE.md "Client IP".
- To check the domain-mapping path as well, map a temporary `xff-probe.<domain>` the same way as step 15, then remove the mapping and its CNAME.

Clean up:
```sh
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
```
**Back out:** delete the CNAME in Cloudflare and run `gcloud beta run domain-mappings delete --domain "shoestring.$DOMAIN" --region "$REGION" --project "$PROJECT"`.
**Fallback** (mapping unavailable or failing): the Cloudflare proxy, infra/hosting-evaluation.md §3a. **Switch it on only after a security-reviewer review and sign-off** (owner ruling 2026-11-13), plus the backend change it needs. Until then the record stays DNS only.

## 16. Launch measurements [needs app]
| ☐ | Check | How | Pass |
|---|---|---|---|
| ☐ | **Cold start (V9)** | Pause the Better Stack monitor. Then, 20 times over a few days, each after ≥ 30 min idle: `curl -s -o /dev/null -w '%{time_total}\n' "https://shoestring.$DOMAIN/api/readyz"` | p95 ≤ 3 s. Record the numbers in infra/hosting-evaluation.md. |
| ☐ | **Neon sleeps (V23)** | Resume the monitor; make one app request; wait 10 min with only `/healthz` pings; Neon Console → compute state | Idle / suspended |
| ☐ | Test hooks absent (F-10) | Step 12 verify, on the custom domain | 404 |
| ☐ | Phone journeys | Sign up with an invite (admin-commands.md), add a transaction, see the month | Works on your phone |
| ☐ | **Hop count measured (V26)** | Step 14, recorded in infra/CLAUDE.md "Client IP"; backend `trustProxy` matches | **Launch blocker** (security-reviewer) |
| ☐ | **DMARC at `p=reject`** | `dig +short TXT "_dmarc.mail.$DOMAIN"` | **Launch blocker** (F-29) |
| ☐ | Admin args retention (V34) | Run `shoestring-admin` once with `--help`, then read the audit entry (hosting-evaluation.md V34) | Retention known; privacy notice states it (R-12) |
| ☐ | Backups | `gcloud run jobs execute shoestring-backup --project "$PROJECT" --region "$REGION" --wait`, then `gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/"`; next morning, confirm the 09:15 scheduled run | Objects present; heartbeat green |
| ☐ | **Restore drill** | restore.md path C | Passes; recorded in README.md |
| ☐ | Billing | After 7 days, billing-protection.md §11 check 1 | $0.00 net |

## Record
| Step | Done (date) | Notes (no secrets) |
|---|---|---|
| 1 Operator MFA | | |
| 2 Billing, spend cap (V0 result) | | |
| 3–7 GCP setup | | |
| 8 Neon (`version()` result) | | |
| 9–11 Secrets, GitHub, email | | |
| 12–13 First deploy, monitoring | | |
| 14 Hop count | | |
| 15 Domain | | |
| 16 Launch checks | | |

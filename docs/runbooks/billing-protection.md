# Billing protection (owner runs this)
- Owner: sre · Status: **DRAFT, not yet run** · Last reviewed: 2026-11-12
- Platform: Google Cloud Run + Neon free (**accepted 2026-11-12**, infra/hosting-evaluation.md, ADR-0007). Run inside the overall order in bootstrap-production.md.

## When to use
- **Once, before any other cloud resource exists:** sections 0 to 9, in order. Caps go on before the app does.
- **Monthly** (first weekend of the month): section 11.
- Whenever a billing alert arrives: billing-alert.md (planned), then section 11.

Items marked **(verify)** depend on the verify list in infra/hosting-evaluation.md. If a command fails because a flag or role name has changed, stop and tell sre (through the tech lead). Do not improvise a different command against production.

## 0. Variables and prerequisites
Run in a terminal on your Mac, from the repo root. None of these values is secret.
```sh
# Install the CLI if needed: brew install --cask google-cloud-sdk
gcloud auth login
gcloud billing accounts list                     # note the ACCOUNT_ID you will use
export BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"    # from the list above
export SUFFIX="<4-6 random lowercase chars>"     # project IDs are global; pick once and record it in infra/CLAUDE.md
export PROJECT="shoestring-prod-$SUFFIX"
export BACKUP_PROJECT="shoestring-backup-$SUFFIX"
export BACKUP_BUCKET="shoestring-backups-$SUFFIX"
export REGION="us-east1"
```
**Check that the free tier is not shared.** Free tiers are per billing account (verify V1). This should list nothing, or only projects that use no Cloud Run, Artifact Registry or Cloud Storage:
```sh
gcloud billing projects list --billing-account="$BILLING_ACCOUNT"
```
**Create the two projects and link billing:**
```sh
gcloud projects create "$PROJECT" --name="Shoestring prod"
gcloud projects create "$BACKUP_PROJECT" --name="Shoestring backups"
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
gcloud billing projects link "$BACKUP_PROJECT" --billing-account="$BILLING_ACCOUNT"
gcloud services enable billingbudgets.googleapis.com cloudbilling.googleapis.com --project="$PROJECT"
gcloud config set billing/quota_project "$PROJECT"
```
> **Free Trial accounts:** if the billing account is on the $300 Free Trial, the trial credit hides real charges. Keep `--credit-types-treatment=include-all-credits` below, and in section 11 also look at the **gross** cost column. When the trial ends, Google asks you to activate a paid account; the caps below must already be in place.

## 1. Budgets and alerts (both projects)
A $1 monthly budget per project, alerting at $0.01 actual spend, $0.50, $1.00, and $1.00 forecast. Alerts go by email to billing account admins (you).
```sh
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="shoestring-prod-1usd" \
  --budget-amount=1.00USD \
  --calendar-period=month \
  --filter-projects="projects/$PROJECT" \
  --credit-types-treatment=include-all-credits \
  --threshold-rule=percent=0.01 \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted-spend

gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="shoestring-backup-1usd" \
  --budget-amount=1.00USD \
  --calendar-period=month \
  --filter-projects="projects/$BACKUP_PROJECT" \
  --credit-types-treatment=include-all-credits \
  --threshold-rule=percent=0.01 \
  --threshold-rule=percent=1.0
```
**Phone push:** budget emails arrive in your Gmail. Add a Gmail filter `from:(billing-noreply@google.com OR CloudPlatform-noreply@google.com) subject:budget` → "Mark as important", and turn on Gmail notifications for important mail on your phone (verify sender addresses from the first alert). The Google Cloud mobile app can also show billing alerts.

**Verify:** `gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --format="table(displayName,amount.specifiedAmount.units,budgetFilter.projects)"` shows both budgets.

**Back out:** `gcloud billing budgets delete <BUDGET_ID> --billing-account="$BILLING_ACCOUNT"` (ID from the list command). Not recommended.

> Budgets **alert**; they do not stop spending by themselves, and cost data arrives hours late. Section 2 is the hard stop.

## 2. Hard cap: choose 2A (preferred) or 2B (fallback)
**Owner decision (2026-11-12): 2A, the spend cap.** 2B is a documented fallback, used only if V0 shows the cap cannot cover Cloud Run; in that case stop and ask the owner. Record: **2A applied on ____ (date); services covered: ____.**

### 2A. Spend cap on the budget (preferred, verify V0)
A spend cap pauses capped services when spend reaches the budget, and they resume next month or when you lift the cap. It was reported as Preview, with Cloud Run support possibly GA in October 2026. The UI labels below are expected but unconfirmed.
1. Console → **Billing** → select `$BILLING_ACCOUNT` → **Budgets & alerts**.
2. Open `shoestring-prod-1usd`.
3. Find the spend-cap section (labelled "Spend cap" or "Cap spending" under actions). Enable it at **$1.00**.
4. Scope: project `shoestring-prod-<suffix>`. Services: select **all** that are offered, at minimum Cloud Run, Artifact Registry, Secret Manager, Cloud Logging and Cloud Scheduler.
5. Save. Note here which services the cap covers: ________.
6. **Do not put a spend cap on the backup project or bucket.** `shoestring-backup-1usd` stays **alert only** (§1), so backups remain readable exactly when a restore is needed (security review, 2026-11-13). Its cost exposure is tiny: only `shoestring-backup@` can write, create-only.

**Verify:** the budget page shows the cap as active. **What happens when hit:** the site goes down (Better Stack alerts) until you lift the cap or the month rolls over. **Back out:** disable the cap on the same page.

### 2B. Kill switch (fallback if 2A is not available for Cloud Run)
**Destructive:** when spend exceeds $1 it detaches billing from the prod project. Every service there stops, and resources in a project without billing may eventually be deleted. Neon (the database) and the backup project are unaffected by design. The function code is in infra/billing-kill-switch/ (reviewed, DRY_RUN by default).
```sh
gcloud services enable pubsub.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  eventarc.googleapis.com run.googleapis.com artifactregistry.googleapis.com --project="$PROJECT"

gcloud pubsub topics create billing-cap --project="$PROJECT"

BUDGET_ID=$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
  --filter='displayName="shoestring-prod-1usd"' --format='value(name.basename())')
gcloud billing budgets update "$BUDGET_ID" --billing-account="$BILLING_ACCOUNT" \
  --notifications-rule-pubsub-topic="projects/$PROJECT/topics/billing-cap"

gcloud iam service-accounts create shoestring-kill-switch --project="$PROJECT" \
  --display-name="Billing kill switch"
# Project Billing Manager lets it unlink billing from this project only (verify role is sufficient)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:shoestring-kill-switch@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/billing.projectManager"

gcloud functions deploy shoestring-kill-switch --gen2 --project="$PROJECT" --region="$REGION" \
  --runtime=python312 --source=infra/billing-kill-switch --entry-point=stop_billing \
  --trigger-topic=billing-cap \
  --service-account="shoestring-kill-switch@$PROJECT.iam.gserviceaccount.com" \
  --set-env-vars="TARGET_PROJECT_ID=$PROJECT,DRY_RUN=true" \
  --memory=256Mi --max-instances=1
# If this fails asking for a build service account, add:
#   --build-service-account="projects/$PROJECT/serviceAccounts/shoestring-kill-switch@$PROJECT.iam.gserviceaccount.com"
# and grant that SA roles/cloudbuild.builds.builder, roles/logging.logWriter and roles/artifactregistry.writer (verify).

# The function's image is stored in the gcf-artifacts repository; keep only the latest one.
gcloud artifacts repositories set-cleanup-policies gcf-artifacts --project="$PROJECT" \
  --location="$REGION" --policy=infra/artifact-registry/gcf-cleanup-policy.json --no-dry-run
```
**Test (safe, DRY_RUN is on):**
```sh
gcloud pubsub topics publish billing-cap --project="$PROJECT" \
  --message='{"costAmount": 2.00, "budgetAmount": 1.00}'
gcloud functions logs read shoestring-kill-switch --gen2 --region="$REGION" --project="$PROJECT" --limit=20
```
Expect `DRY_RUN: would disable billing`. **Arm it** by re-running the same `gcloud functions deploy` command with `DRY_RUN=false`, then never publish a test message again.

**Recover after it fires:** fix the cause first (billing-alert.md), then `gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"`, then redeploy the current image (deploy.md) and confirm `/api/healthz` (verify whether services resume without a redeploy).

**Back out:** `gcloud functions delete shoestring-kill-switch --gen2 --region="$REGION" --project="$PROJECT"`.

## 3. Quotas and service caps (bound the burn rate)
These bound the worst case while the cap reacts. The service and job limits are written into deploy/cloudrun/*.yaml when that exists. Until then, this is the required spec:

| Resource | Setting |
|---|---|
| Service `shoestring` | `--min-instances=0 --max-instances=2 --concurrency=20 --cpu=1 --memory=512Mi --timeout=30s --cpu-boost`, request-based billing (never `--no-cpu-throttling`) |
| Jobs `shoestring-migrate`, `-purge`, `-admin` | `--tasks=1 --parallelism=1 --max-retries=1 --task-timeout=10m --cpu=1 --memory=512Mi` |

**Project quota (console, verify the quota names):**
1. Console → **IAM & Admin → Quotas & System Limits**, project `shoestring-prod-<suffix>`.
2. Filter: Service = **Cloud Run Admin API**, Dimension region = **us-east1**.
3. Quota "**Total CPU allocation, in milli vCPU, per project per region**" → Edit → **3000** (2 service instances + 1 job).
4. Quota "**Total memory allocation, in MiB, per project per region**" → Edit → **1536**.
5. Submit. Decreases are normally applied immediately.

**Verify:** after the first deploy:
```sh
gcloud run services describe shoestring --region="$REGION" --project="$PROJECT" \
  --format="value(spec.template.metadata.annotations.'autoscaling.knative.dev/maxScale')"   # expect 2
```
**Back out:** raise the quota in the same console page.

## 4. Only the APIs we need
```sh
gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" | sort
```
Allowed in prod: `run`, `artifactregistry`, `secretmanager`, `iam`, `iamcredentials`, `sts`, `cloudscheduler`, `logging`, `monitoring`, `billingbudgets`, `cloudbilling`, `cloudresourcemanager`, plus Google's default set (e.g. `storage-api`, `servicemanagement`). With option 2B also: `pubsub`, `cloudfunctions`, `cloudbuild`, `eventarc`.
Allowed in backup: `storage`, `iam`, `iamcredentials`, plus defaults.

**Never enable** `containerscanning.googleapis.com` ($0.26 per scanned image, verify V21), `compute.googleapis.com`, `sqladmin.googleapis.com`. If one appears: `gcloud services disable <name> --project="$PROJECT"`.

## 5. Artifact Registry cleanup (0.5 GB free)
```sh
gcloud services enable artifactregistry.googleapis.com --project="$PROJECT"
gcloud artifacts repositories create shoestring --project="$PROJECT" --location="$REGION" \
  --repository-format=docker --description="Deployed Shoestring images only (copied from GHCR)"

# Dry run first: the policy only logs what it would delete
gcloud artifacts repositories set-cleanup-policies shoestring --project="$PROJECT" \
  --location="$REGION" --policy=infra/artifact-registry/cleanup-policy.json --dry-run
# After the first two deploys, switch it on
gcloud artifacts repositories set-cleanup-policies shoestring --project="$PROJECT" \
  --location="$REGION" --policy=infra/artifact-registry/cleanup-policy.json --no-dry-run
```
The policy keeps anything tagged `prod-*` (the deploy moves `prod-current` and `prod-previous`), keeps the 3 newest, and deletes untagged images after 1 day and everything else after 7 days. Policies run about once a day, and storage is billed per GB-month, so short peaks are fine.

**Verify:**
```sh
gcloud artifacts repositories describe shoestring --project="$PROJECT" --location="$REGION" \
  --format="yaml(sizeBytes,cleanupPolicyDryRun,cleanupPolicies)"
```
`sizeBytes` should stay under ~350,000,000 (70% of 0.5 GB). **Back out:** `gcloud artifacts repositories delete-cleanup-policies shoestring --location="$REGION" --project="$PROJECT" --policynames=<name>`.

## 6. Log retention and volume (50 GiB ingestion, 30 days retention free)
```sh
gcloud logging buckets describe _Default --location=global --project="$PROJECT" --format="value(retentionDays)"
gcloud logging buckets update _Default --location=global --retention-days=30 --project="$PROJECT"

# Cloud Run's own request logs hold client IP, user agent and full URL, which our logging policy forbids.
# The app logs every request itself (route template, status, latency). Exclusions are free.
gcloud logging sinks update _Default --project="$PROJECT" \
  --add-exclusion='name=exclude-run-request-logs,filter=LOG_ID("run.googleapis.com/requests")'
# Drop DEBUG lines if LOG_LEVEL is ever lowered. Do NOT use severity<INFO: unparsed lines are DEFAULT.
gcloud logging sinks update _Default --project="$PROJECT" \
  --add-exclusion='name=exclude-debug,filter=severity<INFO AND severity>DEFAULT'
```
Console fallback if the flag parsing fails: **Logging → Log Router → `_Default` → Edit sink → Choose logs to filter out of sink → Add exclusion**, with the same names and filters.

Data Access audit logs must stay off: `gcloud projects get-iam-policy "$PROJECT" --format="yaml(auditConfigs)"` should print nothing.

**Verify:** `gcloud logging sinks describe _Default --project="$PROJECT" --format="yaml(exclusions)"`. **Back out:** `gcloud logging sinks update _Default --project="$PROJECT" --remove-exclusions=exclude-run-request-logs`.

> The request-log exclusion is pending security-reviewer agreement. The alternative is routing those logs to a 1-day bucket.

## 7. Backup bucket cost settings (5 GB-month free in us-east1)
```sh
gcloud services enable storage.googleapis.com --project="$BACKUP_PROJECT"
gcloud storage buckets create "gs://$BACKUP_BUCKET" --project="$BACKUP_PROJECT" \
  --location=us-east1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=0 \
  --lifecycle-file=infra/gcs/backup-lifecycle.json
```
- `us-east1` and `STANDARD` are required for the free tier (verify V24).
- `--soft-delete-duration=0`: otherwise deleted dumps are kept (and billed) 7 more days, which would break "expire within 35 days".
- Lifecycle deletes at **34 days** because lifecycle actions can lag up to 24 h.

**Verify:** `gcloud storage buckets describe "gs://$BACKUP_BUCKET" --format=yaml` shows location `US-EAST1`, soft delete 0, a Delete rule at age 34, and public access prevention `enforced`. **Back out:** settings can be changed with `gcloud storage buckets update`.

## 8. Secret Manager: 6 active versions, 10,000 accesses per month free
We use **5 secrets, one active version each**, one under the free tier of 6 (`database-url`, `migrator-database-url`, `app-keyring`, `email-api-key`, `backup-database-url`; infra/CLAUDE.md). After every rotation, destroy the superseded version the same day (rotate-secret.md). Count active versions:
```sh
for s in $(gcloud secrets list --project="$PROJECT" --format="value(name)"); do
  gcloud secrets versions list "$s" --project="$PROJECT" --filter="state=ENABLED OR state=DISABLED" --format="value(name)"
done | wc -l        # expect 5; must never exceed 6
```

## 9. Neon free plan limits (no card)
Neon's free plan has no billing attached, so it cannot charge you. Its limits cause **outages**, not bills.
1. **Never add a payment method** to the Neon account. If you ever do, set a spending limit first.
2. Project `shoestring` in **AWS us-east-1**. Settings → Compute: **min 0.25 CU, max 0.25 CU** (verify a fixed size is allowed on free). Scale to zero stays on (5 minutes, fixed on free).
3. **No extra branches** except during a restore drill. Delete drill branches and projects the same day.
4. Keep Neon's other features (Data API, Neon Auth) **off**.
5. Watch Console → **Usage** (or Billing): CU-hours (limit 100, warn at 70), storage (limit 0.5 GB per project, verify V7; warn at 70%), egress (limit 5 GB, warn at 3.5 GB).
6. When a limit is hit: CU-hours → the compute is suspended until the next month (the API returns 503, the SPA still loads); storage → writes fail. Both show up as a Sentry error spike.

## 10. Other free services: make sure none can bill
| Service | Check |
|---|---|
| GitHub | Settings → Billing → Actions and Packages spending limit **$0** (ci-engineer checklist). GHCR packages for the public repo are free. |
| Sentry | Developer (free) plan; Settings → Subscription: pay-as-you-go / on-demand budget **$0**. `tracesSampleRate: 0`. |
| Better Stack, Resend | Free plans, no card on file. Resend: click and open tracking **off** (F-06). |
| Cloudflare | Free plan. No paid add-ons (Argo, Load Balancing, paid Workers, Advanced Certificate Manager). The `shoestring` CNAME stays **DNS only** unless the §3a fallback is active, which happens **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13). |
| DNS and domain | Your existing provider; no new paid add-ons (DNSSEC or proxying are free on most providers). |

## 11. Monthly free-tier check (about 15 minutes)
Do this in the first week of each month for the **previous** month. Record a row in the log below. Anything in the "Warn" column: tell the tech lead.

| # | Check | How | OK | Warn |
|---|---|---|---|---|
| 1 | GCP net cost, both projects | Console → Billing → **Reports**, last month, group by **SKU**, filter each project. Look at both gross cost and credits. | $0.00 net | Any non-zero net |
| 2 | Billing still linked as expected | `gcloud billing projects describe "$PROJECT"` | `billingEnabled: true` (false = the kill switch fired) | false |
| 3 | Cloud Run requests, CPU, memory | Console → Cloud Run → `shoestring` → Metrics (30 days). Compare against infra/cost-sheet.md. | < 50% of free | > 70% |
| 4 | Instance count never above 2 | Same page, "Container instance count" | ≤ 2 | — |
| 5 | Artifact Registry size | Section 5 verify command | < 350 MB | ≥ 350 MB |
| 6 | Log ingestion | Console → Logging → **Log storage** → `_Default` "Volume ingested" for the month | < 1 GiB | > 10 GiB |
| 7 | Secret versions | Section 8 command | 5 | > 5 (a rotation left an old version) |
| 8 | Enabled APIs | Section 4 command | allow-list only | anything else |
| 9 | Backup bucket size and age | `gcloud storage du --summarize "gs://$BACKUP_BUCKET"`; `gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/" \| head -3` | < 1 GB; oldest ≤ 35 days | oldest > 35 days |
| 10 | Neon usage | Neon Console → Usage: CU-hours, storage, egress | < 70% | ≥ 70% |
| 11 | Backups ran every night | `gcloud run jobs executions list --job shoestring-backup --region us-east1 --project "$PROJECT" --limit 31`; `gcloud scheduler jobs list --location us-east1 --project "$PROJECT"` | ~30 succeeded; 2 scheduler jobs, both `ENABLED` | failures, gaps or a paused scheduler |
| 12 | Sentry quota | Sentry → Settings → Subscription → Usage | < 50% of errors | > 70% |
| 13 | Resend usage | Resend dashboard | < 1,000/month | > 2,000 |
| 14 | Free-tier terms unchanged | Skim the pricing pages in infra/hosting-evaluation.md "What to verify" (quarterly is enough) | unchanged | changed: tell sre |
| 15 | Cloudflare records | Cloudflare → DNS: `shoestring` CNAME is **DNS only**; `_dmarc.mail` at the current ramp stage (`p=reject` once launched) | as configured | proxied without a security-reviewer sign-off; DMARC weaker than the ramp stage |
| 16 | Admin job access | `gcloud secrets get-iam-policy shoestring-app-keyring --project "$PROJECT"`: only the run and rewrap SAs | as configured | any other member |
| 17 | Operator MFA (quarterly) | bootstrap-production.md step 1 table still true; no new sign-in methods or tokens on any account | unchanged | anything new |

### Monthly check log
| Month checked | Date | By | Net cost | Notes |
|---|---|---|---|---|
| | | | | |

## Verify (whole runbook)
- Two budgets listed (section 1), cap or kill switch recorded (section 2), quota values visible in the console (section 3), cleanup policy and log exclusions described (sections 5 and 6), bucket settings correct (section 7).
- After one full month: check 1 shows $0.00 net.

## Back out
Each section has its own back-out step. Removing protections is never needed to deploy; if a protection blocks a deploy (for example the CPU quota), raise that one limit and tell sre.

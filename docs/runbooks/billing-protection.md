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
| Jobs `shoestring-migrate`, `-purge`, `-admin`, `-rewrap-mfa`, `-backup` | `--tasks=1 --parallelism=1 --cpu=1 --memory=512Mi`. Retries and timeouts per job (bootstrap-production.md step 12): migrate 0 retries / 10 min, purge 1 / 10 min, admin 0 / 5 min, rewrap-mfa 0 / 15 min, backup 1 / 15 min |

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
Two stages: **5a** at bootstrap (repository plus the policy in dry-run; done 2026-11-18), then **5b** after the second deploy (dry-run off).

### 5a. Create the repository, policy in dry-run (bootstrap step 3)
```sh
gcloud services enable artifactregistry.googleapis.com --project="$PROJECT"
gcloud artifacts repositories create shoestring --project="$PROJECT" --location="$REGION" \
  --repository-format=docker --description="Deployed Shoestring images only (copied from GHCR)"

# Writes the policy AND sets the repository to dry-run mode. This is a production change, not a preview.
gcloud artifacts repositories set-cleanup-policies shoestring --project="$PROJECT" \
  --location="$REGION" --policy=infra/artifact-registry/cleanup-policy.json --dry-run
```
**`--dry-run` / `--no-dry-run` on `set-cleanup-policies` is the repository's setting, not a gcloud preview flag.** Running the command with `--dry-run` switches deletion **off**; with `--no-dry-run` it switches deletion **on**. Neither one previews anything. The read-only preview is 5b block C.

**What the policy does** (infra/artifact-registry/cleanup-policy.json):
- **Keep** rules: anything with a tag starting `prod-` in any package (`app:prod-current`, `app:prod-previous`, `migrate:prod-current`, `backup:prod-backup`); the 3 newest versions of `app` and of `backup` (per package, V44); the 2 newest of `migrate`.
- **Delete** rules: untagged versions older than 1 day; any version older than 7 days.
- A version is deleted only if a delete rule matches it and **no** keep rule does. Keep always wins.
- Policies run about once a day. Storage is billed per GB-month, so short peaks are fine.
- Size after the first two deploys (2 app, 2 migrate, 1 backup version): **115,554,690 bytes** (2026-11-23). The five images list ~287 MB between them, but they share the pinned distroless base layers, which are stored once.

**What protects production.** The service, the five jobs and the rollback target all pin images **by digest**, and every one of those digests carries a `prod-` tag:

| Referenced by | Image | Tag that keeps it | Moved by |
|---|---|---|---|
| Serving revision | `app@<digest>` | `prod-current` | deploy.md step 7; rollback.md step 4 |
| Rollback target (the previous revision) | `app@<digest>` | `prod-previous` | deploy.md step 7 |
| `shoestring-purge`, `-admin`, `-rewrap-mfa` | same digest as the serving revision | `prod-current` | deploy.md steps 6–7; rollback.md steps 3–4 |
| `shoestring-migrate` | `migrate@<digest>` | `migrate:prod-current` | deploy.md steps 3 and 7 (rollback leaves it) |
| `shoestring-backup` | `backup@<digest>` | `prod-backup` | bootstrap-production.md 12g "Rolling the backup image" (F-68), never by deploys |

The keep-newest rules are a second net. They cover the gap inside a deploy between moving a job's or the service's image (steps 3 and 6) and moving the tags (step 7), and an aborted deploy that never reached step 7. Block B below checks the whole table in one go.
- Revisions **older** than the rollback target lose their images once they are neither `prod-` tagged nor among the newest versions. Those revisions can no longer start. rollback.md step 1b checks this before any traffic shift.
- The backup project (`shoestring-backup-<suffix>`) has **no** Artifact Registry. The API is not enabled there (checked 2026-11-23), and the backup image lives in this repository as `backup`.
- There is no `gcf-artifacts` repository (§2B, the kill switch, was not deployed; checked 2026-11-23). If §2B is ever used, its own policy is set there directly.

### 5b. Switch the policy from dry-run to live (after the second deploy)
- **When:** once, after the second deploy (2026-11-23, release `01dbb059`). Run blocks A to F in order, at a time outside the 08:00–09:30 UTC purge and backup window.
- **Where to record:** the line at the end of this section, plus the bootstrap-production.md Record table row "3b".
- Each block sets its own variables, so it works on its own in a new shell or through Claude Code's `!` prefix. Run them from the repo root (blocks A and C read infra/artifact-registry/cleanup-policy.json).
- Blocks A, B, C, E and F are read-only. **Block D is the only change.** Block G (recovery) is only for when block B finds a pinned image missing.
- If you also do the rollback rehearsal (rollback.md status line) around now, either order is safe. Re-run block B after its roll-forward.

**A. Pre-check: the live policy is the reviewed file, and dry-run is on** (read-only)
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
cd "$(git rev-parse --show-toplevel)"
gcloud artifacts repositories describe shoestring --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '{dryRun: (.cleanupPolicyDryRun // false), policies: (.cleanupPolicies | length)}'
gcloud artifacts repositories list --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '.[] | select(.name | endswith("/repositories/shoestring")) | {sizeBytes}'
NORM='def secs: if type=="string" and endswith("d") then (.[:-1] | tonumber * 86400 | tostring + "s") else . end;
  map({name, action: (.action.type | ascii_upcase), mostRecentVersions,
       condition: (.condition // null | if . then (.olderThan |= (if . then secs else . end)) | with_entries(select(.value != null)) else . end)})
  | sort_by(.name)'
diff <(jq -S "${NORM}" infra/artifact-registry/cleanup-policy.json) \
     <(gcloud artifacts repositories list-cleanup-policies shoestring --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null | jq -S "${NORM}") \
  && echo "POLICY OK: live policy matches infra/artifact-registry/cleanup-policy.json" \
  || echo "STOP: the live policy differs from the file (diff above). Do not continue; tell the tech lead"
```
**Pass:** `"dryRun": true`, `"policies": 5`, `sizeBytes` under 350,000,000, and `POLICY OK`.

**B. Reference check: every image production uses carries a `prod-` tag** (read-only)
This is the safety gate. Re-run it after every deploy, rollback or backup-image roll.
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
R="${REGION}-docker.pkg.dev/${PROJECT}/shoestring"
VERSIONS=$(for PKG in app migrate backup; do gcloud artifacts docker images list "${R}/${PKG}" --include-tags --format=json 2>/dev/null; done | jq -s 'add')
{
  gcloud run services describe shoestring --region="${REGION}" --project="${PROJECT}" --format=json \
    | jq -r '.status.traffic[] | select(.percent > 0) | .revisionName' \
    | while read -r REV; do
        printf 'service %s\t%s\n' "${REV}" "$(gcloud run revisions describe "${REV}" --region="${REGION}" --project="${PROJECT}" --format='value(spec.containers[0].image)')"
      done
  for JOB in shoestring-migrate shoestring-purge shoestring-admin shoestring-rewrap-mfa shoestring-backup; do
    printf 'job %s\t%s\n' "${JOB}" "$(gcloud run jobs describe "${JOB}" --region="${REGION}" --project="${PROJECT}" --format='value(spec.template.spec.template.spec.containers[0].image)')"
  done
  printf 'rollback app:prod-previous\t%s\n' "$(gcloud artifacts docker images describe "${R}/app:prod-previous" --format='value(image_summary.fully_qualified_digest)' 2>/dev/null)"
} | jq -R -r --argjson v "${VERSIONS}" '
  split("\t") as [$who, $img]
  | ([$img | capture("^(?<pkg>.+)@(?<dig>sha256:[0-9a-f]{64})$")] | first) as $m
  | if $m == null then "STOP  \($who): not pinned by digest: \($img)"
    else ([$v[] | select(.package == $m.pkg and .version == $m.dig)] | first) as $e
    | if $e == null then "STOP  \($who): digest is NOT in the registry: \($img)"
      elif ([$e.tags[]? | select(startswith("prod-"))] | length) == 0 then "STOP  \($who): no prod- tag (tags: \($e.tags // [] | join(","))) \($m.dig)"
      elif ($e.metadata.mediaType | test("index|list")) then "STOP  \($who): image index; its child manifests are untagged (tell sre)"
      else "OK    \($who): \($m.pkg | split("/") | last)@\($m.dig[7:19]) [\($e.tags | join(","))]" end end'
```
**Pass:** exactly 7 lines (1 service revision, 5 jobs, the rollback target), all `OK`. Result on 2026-11-23 (sre, read-only): all 7 `OK`. The service and the purge, admin and rewrap-mfa jobs on `app@d118648fb1c2` (`prod-current`); migrate on `migrate@8edda3863022` (`prod-current`); backup on `backup@1c20afbceeca` (`prod-backup`); rollback `app@09d34dd381fd` (`prod-previous`, revision `shoestring-00001-sg9`). All five versions are single-platform Docker v2 manifests, not image indexes.
**Any `STOP`:** don't run block D. Fix the tag with the deploy.md step 7 or bootstrap 12g command for that image, then re-run B. If the line says "image index", tell the tech lead (sre and ci-engineer): an index's per-platform manifests are untagged versions, and the 1-day rule could delete them (V44).

**C. Preview: what the policy would delete right now** (read-only)
Five days of dry-run left nothing readable: on 2026-11-23 the project's Artifact Registry audit entries were only your own create and tag calls. AR may write dry-run results only as Data Access audit logs, which are off here on purpose (§3; verify V44). Nothing would have been deleted yet anyway. So this block works the policy's rules out from the live version list. It models AR's evaluation rather than reading it, so treat a surprise as a reason to stop, not as proof.
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
R="${REGION}-docker.pkg.dev/${PROJECT}/shoestring"
NOW=$(date -u +%s)
for PKG in app migrate backup; do
  case "${PKG}" in migrate) KEEP=2 ;; *) KEEP=3 ;; esac
  gcloud artifacts docker images list "${R}/${PKG}" --include-tags --format=json 2>/dev/null \
  | jq -r --arg pkg "${PKG}" --argjson keep "${KEEP}" --argjson now "${NOW}" '
      sort_by(.createTime) | reverse | to_entries[]
      | .key as $i | .value as $e | ($e.tags // []) as $t
      | (($now - ($e.createTime | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) / 86400) as $age
      | (if any($t[]; startswith("prod-")) then "keep (prod- tag)"
         elif $i < $keep then "keep (\($keep) newest)"
         elif ($t | length) == 0 and $age > 1 then "WOULD DELETE (untagged, older than 1d)"
         elif $age > 7 then "WOULD DELETE (older than 7d)"
         else "keep for now (no delete rule matches yet)" end) as $verdict
      | "\($pkg)\t\($e.version[7:19])\t\($age * 10 | floor / 10)d\t\($t | join(","))\t\($verdict)"'
done | column -t -s "$(printf '\t')"
```
**Pass:** no `WOULD DELETE` on any digest that block B listed. Result on 2026-11-23 (sre): 5 versions, all `keep`, so the live policy deletes nothing yet. The first real deletion is expected after the **next** deploy, once 2026-11-26 has passed (7 days after the first copy). Then `migrate@b7eaaa030963` (release `30577e54`, referenced by nothing) falls out of the 2 newest. `app@09d34dd381fd` (revision `shoestring-00001-sg9`) loses `prod-previous` at the next deploy but stays among the 3 newest. It goes at the deploy after that.
To see whether AR wrote anything itself (expect nothing):
```sh
PROJECT="shoestring-prod-ssba"
gcloud logging read 'protoPayload.serviceName="artifactregistry.googleapis.com" AND NOT protoPayload.authenticationInfo.principalEmail:"@gmail.com"' \
  --project="${PROJECT}" --freshness=7d --limit=20 --format="table(timestamp,logName.basename(),protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)"
```
Don't switch on Data Access audit logs to get dry-run output. That is a production change, it adds log volume (image pulls are data reads), and §3 requires them off.

**D. Switch dry-run off (the only change)**
This changes only the dry-run flag. It doesn't send the policy file, so it can't alter the rules that block A just checked.
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
gcloud artifacts repositories set-cleanup-policies shoestring --project="${PROJECT}" --location="${REGION}" --no-dry-run
```
It prints the 5 policies **without** the line `Dry run is enabled.`

**E. Verify straight away** (read-only)
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
gcloud artifacts repositories describe shoestring --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '{dryRun: (.cleanupPolicyDryRun // false), policies: (.cleanupPolicies | length)}'
gcloud artifacts repositories list --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '.[] | select(.name | endswith("/repositories/shoestring")) | {sizeBytes}'
gcloud logging read 'protoPayload.serviceName="artifactregistry.googleapis.com" AND protoPayload.methodName:"UpdateRepository"' \
  --project="${PROJECT}" --freshness=1h --limit=3 --format="table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)"
```
**Pass:** `"dryRun": false`, `"policies": 5`, and one `UpdateRepository` entry from you at the time you ran D. Then re-run **block A**: it should print `"dryRun": false` and `POLICY OK`. Re-run **block B**: all 7 `OK`.

**F. Verify the next day** (after at least 24 hours, so a cleanup run has happened)
1. Re-run **block B**: all 7 `OK`. If any line says "NOT in the registry", run the one-line revert below at once, then recover that digest with block G.
2. The morning's scheduled jobs prove their images still pull. The 08:00 UTC purge shows a green check-in on the Sentry `purge` cron monitor, and the 09:15 UTC backup turns the Better Stack heartbeat green. Block B's "digest is in the registry" covers the service, whose instances pull the same digest.
3. Re-run the `gcloud logging read` line from block C. Entries from a Google service agent are cleanup deletions. Every deleted digest must be one block C marked `WOULD DELETE`. Record what you see under V44.

**One-line revert to dry-run:**
```sh
gcloud artifacts repositories set-cleanup-policies shoestring --project="shoestring-prod-ssba" --location="us-east1" --dry-run
```
Reverting stops further deletions, but AR has no undelete. To bring an image back, use block G.

**G. Recover a deleted image that production pins** (F-70)
Use this when block B prints `STOP … digest is NOT in the registry: …/<pkg>@sha256:<64 hex>`.
- The revisions and jobs pin that **exact digest**, so you must copy that digest back. A different build of the same commit won't do.
- GHCR still holds the digest: no workflow deletes GHCR versions, and the packages are public.
- **Don't recover with deploy.md step 1 or the bootstrap 12g copy lines.** Both look the digest up through the `sha-<sha>` tag. A CI re-run of the same commit republishes that tag as a new build with a different digest, so you would copy the wrong image and the pinned revisions and jobs would stay broken.
- **`gh attestation verify` is mandatory here too (F-67).** Never skip it because you "already know" the digest. The `&&` means nothing is copied unless verification passes.
- Prerequisites: run from the repo checkout (`gh` logged in; `gcloud auth configure-docker us-east1-docker.pkg.dev` done once, as in deploy.md).

G1 (read-only). Find the commit the attestation names, and check it:
```sh
PINNED="sha256:<64 hex from the block B STOP line>"; PKG="<app|migrate|backup>"   # PKG = the package in the STOP line's path
GH_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; GH_REPO_LC=$(printf '%s' "${GH_REPO}" | tr '[:upper:]' '[:lower:]')
GHCR_REPO="ghcr.io/${GH_REPO_LC}"; [ "${PKG}" = app ] || GHCR_REPO="${GHCR_REPO}-${PKG}"
SRC_SHA=$(gh attestation verify "oci://${GHCR_REPO}@${PINNED}" --repo "${GH_REPO}" \
  --signer-workflow "${GH_REPO}/.github/workflows/ci.yml" --source-ref refs/heads/main --deny-self-hosted-runners \
  --format json --jq '.[0].verificationResult.signature.certificate.sourceRepositoryDigest')
echo "attested commit: ${SRC_SHA:-NONE (verification failed: STOP)}"
git fetch -q origin main && git merge-base --is-ancestor "${SRC_SHA}" origin/main && git log -1 --format='%H %cs %s' "${SRC_SHA}"
```
Continue only if all of these hold:
- It prints a 40-hex commit that is on `main`.
- The commit is the one you expect:
  - `app`: the release the broken service revision or job runs (`APP_RELEASE` in `gcloud run revisions describe <rev>` or `gcloud run jobs describe <job>`).
  - `migrate`: the same release (deploys always copy app and migrate from one SHA).
  - `backup`: the `BACKUP_SHA` you recorded when that digest was rolled (bootstrap 12g).
- If anything differs, stop and tell the tech lead.

G2 (the change). Verify again, pinned to that commit, then copy that exact digest:
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
PINNED="sha256:<same 64 hex as G1>"; PKG="<same as G1>"; SRC_SHA="<40-hex commit G1 printed>"
GH_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; GH_REPO_LC=$(printf '%s' "${GH_REPO}" | tr '[:upper:]' '[:lower:]')
GHCR_REPO="ghcr.io/${GH_REPO_LC}"; [ "${PKG}" = app ] || GHCR_REPO="${GHCR_REPO}-${PKG}"
AR_PKG="${REGION}-docker.pkg.dev/${PROJECT}/shoestring/${PKG}"
ATTEST_FLAGS=(--repo "${GH_REPO}" --signer-workflow "${GH_REPO}/.github/workflows/ci.yml" --source-ref refs/heads/main --source-digest "${SRC_SHA}" --deny-self-hosted-runners)
gh attestation verify "oci://${GHCR_REPO}@${PINNED}" "${ATTEST_FLAGS[@]}" \
  && crane copy "${GHCR_REPO}@${PINNED}" "${AR_PKG}:prod-recovered-${PINNED:7:12}" \
  && crane digest "${AR_PKG}@${PINNED}"      # must print exactly ${PINNED}
```
- The `prod-recovered-<12 hex>` tag protects the copy from the moment it lands, through the `prod-` keep rule. It moves no existing `prod-` tag, so it can't unprotect anything else.
- Then re-run **block B**: every line `OK`.
- Then put the standard tag back on the image that role should use:
  - `app` or `migrate`: deploy.md step 7's `tags add` lines, with `IMAGE` / `MIGRATE_IMAGE` / `PREV_IMAGE` set to the digests block B shows for the service and jobs.
  - `backup` (F-68): if the backup job and `backup:prod-backup` now point at different digests, put them back together through bootstrap-production.md 12g "Rolling the backup image" (it verifies and tags). Don't hand-edit the job.
- Once block B shows nothing pins that digest any more, remove the extra tag: `gcloud artifacts docker tags delete "${AR_PKG}:prod-recovered-${PINNED:7:12}"` (with the G2 variables set).
- Tell the tech lead which digest was deleted and when (V44, and an incident note if users were affected).

**Record:** dry-run switched **off** on **2026-11-23 23:14 UTC** by the owner. Block A: `dryRun: true`, 5 policies, 115,554,690 bytes, `POLICY OK`. Block B: 7 of 7 `OK`. Block C: 0 `WOULD DELETE` (5 versions, all kept). Block E: `dryRun: false`, 5 policies, one `UpdateRepository` entry from the owner. A and B re-run afterwards: `POLICY OK`, 7 of 7 `OK`. Next-day block F: ____ (due after 2026-11-24 09:30 UTC). Copy the date into the bootstrap-production.md Record table, row 3b.

**Verify (any time; the monthly check, §11 row 5):**
```sh
PROJECT="shoestring-prod-ssba"; REGION="us-east1"
gcloud artifacts repositories describe shoestring --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '{dryRun: (.cleanupPolicyDryRun // false), policies: (.cleanupPolicies | length)}'
gcloud artifacts repositories list --project="${PROJECT}" --location="${REGION}" --format=json 2>/dev/null \
  | jq '.[] | select(.name | endswith("/repositories/shoestring")) | {sizeBytes}'
```
`sizeBytes` should stay under ~350,000,000 (70% of 0.5 GB). Once 5b is done, `dryRun` must be `false`. (`describe` doesn't return `sizeBytes` and `list` doesn't return the policies, hence two commands.)

**Back out:**
- Live deletions: the one-line revert above.
- A single rule: `gcloud artifacts repositories delete-cleanup-policies shoestring --location="$REGION" --project="$PROJECT" --policynames=<name>`. Make the same change in infra/artifact-registry/cleanup-policy.json first, so block A keeps passing.

### 5c. Never download image layers from AR to your machine
Artifact Registry has **no free internet egress** (about $0.10/GiB, SKU "Artifact Registry Network Internet Egress"). Only Cloud Run's same-region pulls are free. So no operator command may read image **layers** from `us-east1-docker.pkg.dev`: no `crane export`/`pull`/`copy`/`flatten` with AR as the source, no `docker pull`/`run` of an AR image.
- Need the bytes of a deployed image? Read the same digest from **public GHCR**: `crane export "ghcr.io/$GH_REPO_LC@$DIGEST" -` (always `@digest`, never a tag). The digest is content-addressed and crane verifies each blob against it, so the bytes are exactly what Cloud Run runs. deploy.md step 5 (F-10 gate) does this.
- Fine against AR (metadata, a few KB): `gcloud artifacts docker images list/describe`, `gcloud artifacts docker tags add/delete`, `crane digest`, `crane config`, and `crane copy` **into** AR from GHCR (ingress is free).
- Cause of the November 2026 bill of **$0.01**: 0.06 GiB of AR internet egress, from the F-10 gate exporting the app image from AR during the 2026-11-23 deploy (fixed 2026-11-24). Recorded in the §11 log.

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
5. Watch Console → **Usage** (or Billing): CU-hours (limit 100 per project, warn at 70; measured ≈ 7–8 per month, 2026-11-23), storage (limit **1 GB** per project, owner-confirmed from Neon's pricing 2026-11-23, V7; warn at 70%), egress (limit 5 GB, warn at 3.5 GB).
6. When a limit is hit: CU-hours → the compute is suspended until the next month (the API returns 503, the SPA still loads); storage → writes fail. Both show up as a Sentry error spike.

## 10. Other free services: make sure none can bill
| Service | Check |
|---|---|
| GitHub | Settings → Billing → Actions and Packages spending limit **$0** (ci-engineer checklist). GHCR packages for the public repo are free. |
| Sentry | Developer (free) plan, no card. The plan has no pay-as-you-go budget, so it can't bill (checked 2026-11-16, V18). New orgs start a 14-day Business trial: after its end date, Settings → Subscription must show **Developer** (V41). Never add a card or upgrade. Exactly 1 cron monitor. `tracesSampleRate: 0`. |
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
| 12 | Sentry quota | Sentry → Org Settings → **Stats → Usage** (errors accepted vs 5,000; dropped). Monitors → Crons lists exactly 1 monitor. Also run docs/runbooks/sentry-data-check.md step 1 on the top 5 issues per project. | < 50% of errors; 1 monitor; no leak | > 70%; 2+ monitors; any leak |
| 13 | Resend usage | Resend dashboard | < 1,000/month | > 2,000 |
| 14 | Free-tier terms unchanged | Skim the pricing pages in infra/hosting-evaluation.md "What to verify" (quarterly is enough) | unchanged | changed: tell sre |
| 15 | Cloudflare records | Cloudflare → DNS: `shoestring` CNAME is **DNS only**; `_dmarc.mail` at the current ramp stage (`p=reject` once launched) | as configured | proxied without a security-reviewer sign-off; DMARC weaker than the ramp stage |
| 16 | Admin job access | `gcloud secrets get-iam-policy shoestring-app-keyring --project "$PROJECT"`: only the run and rewrap SAs | as configured | any other member |
| 17 | Operator MFA (quarterly) | bootstrap-production.md step 1 table still true; no new sign-in methods or tokens on any account | unchanged | anything new |

### Monthly check log
| Month checked | Date | By | Net cost | Notes |
|---|---|---|---|---|
| 2026-11 (partial, from the billing CSV) | 2026-11-24 | owner | **$0.01** (Warn) | Only non-free line: "Artifact Registry Network Internet Egress North America to North America", 0.06 GiB = $0.0063, billed $0.01. Cause: deploy.md step 5's F-10 gate ran `crane export` against AR on the 2026-11-23 deploy. Fixed 2026-11-24: it now reads the same digest from GHCR (§5c). Everything else was covered by free tiers. **Watch only:** "Cloud Run Network Internet Data Transfer Out Intercontinental" $0.00036, probably an outbound call to a host outside North America (Sentry or the email API); act if it ever bills ≥ $0.01. Re-check the full month in early December. |

## Verify (whole runbook)
- Two budgets listed (section 1), cap or kill switch recorded (section 2), quota values visible in the console (section 3), cleanup policy and log exclusions described (sections 5 and 6), bucket settings correct (section 7).
- After one full month: check 1 shows $0.00 net.

## Back out
Each section has its own back-out step. Removing protections is never needed to deploy; if a protection blocks a deploy (for example the CPU quota), raise that one limit and tell sre.

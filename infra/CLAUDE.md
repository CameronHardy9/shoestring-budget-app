# Infrastructure and operations conventions (loads when working in infra/) — owner: sre

Status: **accepted platform** (owner, 2026-11-12; round 2 rulings 2026-11-13; ADR-0007 being written by the architect). **Nothing exists in the cloud yet.** Setup order: docs/runbooks/bootstrap-production.md. Unconfirmed provider facts are tagged (Vn), see infra/hosting-evaluation.md "What to verify".

## Platform
- **App:** Google Cloud Run, service `shoestring`, region **us-east1**. Request-based billing, scale to zero. **min 0, max 2 instances, concurrency 20** (F-15), 1 vCPU / 512 MiB, timeout 30 s, startup CPU boost, gen1. Startup probe `GET /api/healthz`. The deploy gate calls `GET /api/readyz` on the tagged candidate revision.
  - The F-15 memory budget is a per-instance argon2id semaphore of 4 × 19 MiB ≈ 76 MiB, well inside 512 MiB. That gives at most 8 concurrent hashes across both instances.
- **Database:** Neon free, project `shoestring`, region **aws-us-east-1**, branch `main`, compute fixed 0.25 CU. **Postgres major 17** to match local.
  - **Local is Postgres 17.12** (ci-engineer's compose).
  - Neon free is believed to support 17 (it offers 14–17), but Neon manages the minor version itself, so production's 17.x minor may differ from 17.12. Majors must match; minors may drift. Verify (V30) and record `select version();` at bootstrap: 17.12.
  - `pg_dump`/`pg_restore` clients must be major 17 or newer.
- **Connections:** the app uses the **pooled** endpoint (`-pooler` host). Migrations, `pg_dump` and restores use the **direct** endpoint. Every URL has `sslmode=verify-full` (F-28). libpq tools (`psql`, `pg_dump`, `pg_restore`, the backup URL) also add `sslrootcert=system`; the URLs node-postgres reads (`DATABASE_URL`, `MIGRATOR_DATABASE_URL`) must **not** have it (node-pg treats it as a file path and fails with ENOENT). The Neon default owner role (`neondb_owner`) is used only by the owner for role setup, never by the app (F-28).
- **Jobs** (Cloud Run Jobs, each with its own service account and only the secrets it needs: F-02, F-28):
  - `shoestring-migrate`: release step, **migrate image** (below): its entrypoint runs dbmate as `migrator`, then db/roles.sql's grant check. No `--command`/`--args`; only `MIGRATOR_DATABASE_URL`; `--max-retries 0`, 10 min, 512 MiB. No Sentry SDK: a failure shows only as the execution status and its logs. `DATABASE_ADMIN_URL` is local/test only, never set in production.
  - `shoestring-purge`: Cloud Scheduler, daily 08:00 UTC, counts-only output (app image)
  - `shoestring-admin`: owner-run admin commands, target email in `--args` (R-12 accepted). Destructive single-user commands run in two steps: a dry run, then `--yes --expect-user-id`. App image, `DATABASE_URL` plus email config only, **never the keyring**. **Never run admin commands in GitHub Actions** (OD-3).
  - `shoestring-rewrap-mfa`: owner-run `rewrap-mfa` for keyring rotation (app image, `DATABASE_URL` + `APP_KEYRING`). It is separate so `shoestring-admin` never mounts the keyring (admin-commands.md contract).
  - `shoestring-backup`: Cloud Scheduler, daily 09:15 UTC, **backup image** (below).
  - Cloud Scheduler: **2 of the 3 free jobs** per billing account (purge, backup). One spare.
- **Images:** CI builds (linux/amd64 only; never a Mac build), scans and pushes to GHCR (lowercase paths: `ghcr.io/<owner>/<repo, lowercased>[-migrate|-backup]:sha-<full sha>`). The GHCR packages are **public** (owner ruling 2026-11-17; free private storage is 500 MB), so copying from GHCR needs no credential. The deploy copies the digest to Artifact Registry. Deploy by **digest**, never by tag. Three images (packages in the AR repo `shoestring`):
  - **App** `…/shoestring/app`: service, purge, admin, rewrap-mfa. Holds nothing of `db/`. The moving tags `prod-current` and `prod-previous` protect the serving image, the jobs' image and the rollback target from infra/artifact-registry/cleanup-policy.json (dry-run since 2026-11-18; switched to live by billing-protection.md §5b, date in the bootstrap Record row 3b).
  - **Migrate** `…/shoestring/migrate` (Dockerfile target `migrate`): the `shoestring-migrate` job only. Compiled migrate CLI, pg, dbmate, `db/migrations`, `db/roles.sql`. **Always the same SHA as the app image** (the app's readyz requires the newest migration its build ships with). Tag `prod-current` (its own, per package) marks the job's image; no `prod-previous`, because rollback never runs migrate. ~33 MB uncompressed on top of the shared distroless base (measured locally 2026-11-17).
  - **Backup** `…/shoestring/backup`: a small dedicated image. It is a pinned `alpine` base plus `bash`, `postgresql17-client`, `age`, `curl` and `ca-certificates`, a non-root user, and entrypoint deploy/backup/backup.sh (ci-engineer: `Dockerfile.backup`). Tag `prod-backup` (protected by the `prod-` keep rule).
  - Why not the app image: `pg_dump` would add surface to the internet-facing service, and the backup is decoupled from app releases. It is only ~20 MB, which matters for AR's 0.5 GB.
  - The **owner** updates the backup job's image; the deployer cannot (no actAs on the backup SA).
- **Domain:** Cloud Run domain mapping for `shoestring.<domain>`. **DNS is on Cloudflare**, and every mapped record is **DNS only (grey cloud)**. The Cloudflare proxy is the documented fallback (hosting-evaluation.md §3a). Email is sent from `mail.<domain>` via Resend: click and open tracking off (F-06), DMARC **ramped to `p=reject`** (none → quarantine → reject; `p=reject` before launch, F-29).
- **Backups (owner ruling 2026-11-13):** the Cloud Run job `shoestring-backup` (prod project) runs `pg_dump` (read-only `backup` role) piped through `age` with the public key only. It uploads to the private bucket `shoestring-backups-<suffix>` in the **separate** backup project, as `shoestring-backup@` with `objectCreator` only. **The database credential never enters GitHub.** Lifecycle: infra/gcs/backup-lifecycle.json (34 days) (OD-4, F-17). Heartbeat to Better Stack.
- **Hard cap:** a Cloud Billing **spend cap** at $1 on the prod project (owner decision). The kill switch in infra/billing-kill-switch/ is a fallback only, used if V0 fails.

## Client IP (F-08)
- Normal path (domain mapping, DNS-only): Fastify `trustProxy: 1` (exact hop count, **never `true`**), set by the service env var `TRUST_PROXY_HOPS=1` (bootstrap step 12b). The client IP is the rightmost `X-Forwarded-For` entry. Expected; **measured at bootstrap** with the echo probe (V26), on **both** public paths, because the one value applies to both (F-65):
  - `run.app` URL: hop count = **1** on 2026-11-23 (`"203.0.113.7,<client IP>"`)
  - custom domain (domain mapping): hop count = **1** on 2026-11-23 (same result, via `xff-probe.<domain>`; probe deleted)
- **V26 must be measured before launch** (security-reviewer). Launch is blocked until **both** counts above are filled in and agree.
- **If the two paths differ, stop:** no single `TRUST_PROXY_HOPS` is safe while both URLs are public (too low on one path shares one IP bucket among all users; too high on the other lets clients forge their IP). Escalate to security-reviewer; don't pick a value.
- Cloudflare proxy fallback: the hop count stays 1, but the trusted client IP becomes `CF-Connecting-IP`, and only when the request carries a valid origin-auth header. That needs a backend change and an extra secret (hosting-evaluation.md §3a). **It is switched on only after a security-reviewer review and sign-off** (owner ruling 2026-11-13).

## Environments
| Name | What | Where config lives |
|---|---|---|
| `local` | docker compose via OrbStack (ci-engineer owns compose), Postgres 17.12 | `.env` from `.env.example` |
| `production` | GCP project `shoestring-prod-<suffix>` + Neon project `shoestring` | Cloud Run service/job config + Secret Manager |
| (support) | GCP project `shoestring-backup-<suffix>`: backup bucket only | — |
Record the chosen suffix here once picked: `<suffix>` = ssba.

No staging (owner decision). GitHub environments:
- `production`: deploy only. Required reviewer = owner, branch `main` only, admins cannot bypass.
- `sentry`: holds only `SENTRY_AUTH_TOKEN` for the private source-map upload (CI job `environment: sentry`). Branch `main` only, no reviewer (bootstrap step 11b, S6).

There is **no** GitHub `backup` environment: backups run in GCP.

## IaC approach (platform-native blueprint, per meeting 7)
- The Cloud Run service and jobs will be **Knative YAML** in `deploy/cloudrun/`, written after the Dockerfile and `/api/healthz` exist (not yet). Until then, the flags in docs/runbooks/bootstrap-production.md are the spec.
- One-time setup, IAM and cost controls are **reviewed `gcloud` commands in docs/runbooks/** that the owner runs. Every console change gets a follow-up edit here.
- **Plan / dry-run commands** (read-only):
  - `gcloud run services replace deploy/cloudrun/service.yaml --region us-east1 --dry-run` (validates server-side, applies nothing; confirm the flag exists)
  - **Not** `gcloud artifacts repositories set-cleanup-policies … --dry-run`: that flag is the repository's dry-run *mode*, so the command writes the policy and switches deletion off. It is a production change. The read-only checks for the cleanup policy are docs/runbooks/billing-protection.md §5b blocks A–C (the live policy against the file, `prod-` tags on every image in use, a modelled deletion preview).
  - `python3 -m json.tool <file>` for every JSON file; `bash -n` and `shellcheck` for every shell block and script
  - Scripts in deploy/scripts/ print commands by default and change anything only with `APPLY=1`.
- sre never runs a mutating `gcloud`, `neonctl`, `gh` or Cloudflare command against production. The owner does.

## Identities (least privilege, no service-account keys anywhere)
| Identity | Used by | Grants |
|---|---|---|
| `shoestring-run@` | Service | Secret accessor on database-url, app-keyring, email-api-key |
| `shoestring-purge@` | `purge` job | Secret accessor on database-url **only** (F-02) |
| `shoestring-admin@` | `admin` job | Secret accessor on database-url, email-api-key |
| `shoestring-rewrap@` | `rewrap-mfa` job | Secret accessor on database-url, app-keyring |
| `shoestring-migrate@` | `migrate` job | Secret accessor on migrator-database-url only (F-28) |
| `shoestring-backup@` | `backup` job | Secret accessor on backup-database-url **only**. `roles/storage.objectCreator` on the backup bucket in the backup project: **cannot read, list or delete** (F-17). |
| `shoestring-deployer@` | GitHub `production` environment via WIF | `roles/run.developer` **per resource** on the `shoestring` service and the migrate, purge, admin and rewrap-mfa jobs, **never project-wide** (F-39). A minimal custom project role `shoestringDeployerProject` (`run.operations.get`, `run.revisions.get/list`, `run.locations.list`; V36). `iam.serviceAccountUser` on run, purge, admin, rewrap and migrate. AR writer on the `shoestring` repo. **No access of any kind to `shoestring-backup` or its SA.** |
| `shoestring-scheduler@` | Cloud Scheduler | Execute the `shoestring-purge` and `shoestring-backup` jobs only (V25) |
| Owner's Google account | Human | Project owner on both projects; the only identity that can read backups. Phishing-resistant MFA required (F-03). |

**WIF (F-16):** pool `github`, provider `github-oidc`.
- The provider condition pins the numeric `repository_id`, the `repository_owner_id`, `ref == refs/heads/main` and `environment == production` (F-66).
- The deployer SA binding is to the exact subject, immutable form: `repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:production`, built from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix` (the repo has `use_immutable_subject: true`). It is the only WIF binding. **Never widen it to a `principalSet`**; if deploy auth fails, stop and tell the tech lead.
- The deploy job runs no `pnpm install`.

## Secrets (by name only; values never in the repo, logs or runbooks)
Secret Manager, prod project, single location us-east1. **5 secrets × 1 active version, one under the free tier of 6** (V6).
- `APP_KEYRING` replaced `MFA_ENCRYPTION_KEY` and `THROTTLE_KEY`, and the admin-input secret was removed (R-12).
- A rotation briefly reaches 6, which is still free. Destroy the old version the same day.
| Secret | Env var | Consumers |
|---|---|---|
| `shoestring-database-url` | `DATABASE_URL` (`app` role, pooled, verify-full) | service, purge, admin |
| `shoestring-migrator-database-url` | `MIGRATOR_DATABASE_URL` (direct) | migrate job **only** |
| `shoestring-app-keyring` | `APP_KEYRING`: JSON keyring `{"current":"kN","keys":{…}}`, each key 32 random bytes. HKDF subkeys `totp-v1`, `recovery-code-v1`, `throttle-v1`, `cursor-v1` (data-model.md "Application keyring", F-24) | service and `rewrap-mfa` job **only** |
| `shoestring-email-api-key` | `EMAIL_API_KEY` (Resend, sending access, `mail.<domain>` only) | service, admin |
| `shoestring-backup-database-url` | `BACKUP_DATABASE_URL` (`backup` role, read-only, **direct**, `sslmode=verify-full&sslrootcert=system`) | backup job **only** |
- Pin **numbered versions** for every secret, so a rotation is an explicit, reviewable change.
- **Admin job arguments:** the target email goes in `--args`. This is accepted risk R-12 (2026-11-13): the email stays in owner-only job execution records (no time limit, until 1,000 newer runs) and the System Event audit log (400 days, locked); Admin Activity doesn't record job runs (V34, 2026-11-23). No cleanup (owner ruling 2026-11-23); the privacy notice says "at least 400 days, no fixed end date" (wording in docs/runbooks/admin-commands.md). Nothing else personal goes in args, overrides or labels, and **no token or secret ever does**.
- `APP_KEYRING` is never stored with backups. Its **offline escrow copy** lives in a **separate password-manager vault** (vault B) from the `age` private key (vault A) (owner ruling 2026-11-13, F-17). Update the escrow on every rotation.
- `GET /api/readyz` fails if any row references a key ID missing from the keyring, so the deploy gate blocks a bad rotation (rotate-secret.md "Application keyring").

| GitHub environment `production` | Kind | Purpose |
|---|---|---|
| `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `GCP_PROJECT` | variables | not secret |
GitHub holds **no** production or backup secret at all. The one GitHub secret is `SENTRY_AUTH_TOKEN`: a Sentry organization token (`org:ci` scope: releases and source-map upload only), stored as an **environment** secret on the `main`-only environment `sentry`, never repository-wide (bootstrap step 11b, S6). Not secret: the repository variables `SENTRY_DSN_WEB`, `SENTRY_ORG` and `SENTRY_PROJECT_WEB` (ci.yml).

Backup job plain env vars (not secret): `BACKUP_BUCKET`, `BACKUP_AGE_RECIPIENT` (`age` **public** key), `BACKUP_HEARTBEAT_URL`.
- **Owner-confirmed (2026-11-13):** the heartbeat URL stays plain config, keeping the last free Secret Manager slot spare. Only the owner can read the backup job's config now that the deployer is scoped away from it (F-39). The worst case is a fake "success" ping, which can't read or change backups.
- **Owner-confirmed (2026-11-13):** the prod spend cap may pause the backup job (with the site and purge) until the cap lifts. Alert A4 fires; billing-alert.md runs both jobs by hand afterwards. The **backup project has no spend cap** (alert only), so existing backups stay readable.

The `age` **private** key is held offline in two places: vault A and one offline copy (F-17). It is never in GitHub or GCP.

Non-secret runtime config (plain env vars on the service): `NODE_ENV=production` (also set in the Dockerfile, F-10), `TRUST_PROXY_HOPS=1` (**required**: config.ts refuses to start in production without it or below 1; F-08, V26 measures it; the jobs don't read it), `APP_ORIGIN=https://shoestring.<domain>`, `WEBAUTHN_RP_ID=shoestring.<domain>`, `WEBAUTHN_RP_NAME=Shoestring`, `EMAIL_TRANSPORT=provider`, `EMAIL_FROM=Shoestring <no-reply@mail.<domain>>`, `COOKIE_SECURE=true`, `HIBP_ENABLED=true`, `LOG_LEVEL=info`, `APP_RELEASE=<git sha>` (name ratified by the architect), `SENTRY_DSN`, `EMAIL_DAILY_QUOTA=100` (F-09, name pending backend). `TEST_HOOKS` is never set.

## Monitoring stack (details: observability/README.md)
| Alert | Tool (free) | Channel | Runbook |
|---|---|---|---|
| Site down: `/api/healthz` via the custom domain every 5 min, 2 failures | Better Stack Uptime | email + Better Stack app push | site-down.md |
| Error spike (backend + SPA) | Sentry alerts `error-new`, `error-spike` | email (Gmail push) | error-spike.md |
| Purge missed or failed | Sentry cron monitor `purge` + alert `purge-cron` | email (Gmail push) | purge-failed.md |
| Backup missed or failed (`shoestring-backup` job) | Better Stack heartbeat, 24 h + 2 h grace | email + Better Stack app push | backup-missed.md |
| Any spend, or cap reached | GCP budget at $0.01 / $0.50 / $1 | email (Gmail push) | billing-alert.md |
| Email quota at 60% / 100% of the daily limit (F-09, F-60) | Sentry `warning` / `error` events, fingerprint `email-quota-threshold`; alerts `email-quota-warning`, `email-quota-exhausted` | email (Gmail push) | email-quota.md |
- **Sentry free (Developer) plan** (checked 2026-11-16, V18): 1 user, 5,000 errors/month, exactly 1 cron monitor, email-only alerts, no pay-as-you-go (can't bill). There is no per-key rate limit (Business only). The Sentry mobile app is unmaintained, so push goes through Gmail. Setup: bootstrap-production.md step 11b and step 13. Leak check and canary: docs/runbooks/sentry-data-check.md.

- **Logs:** Cloud Logging `_Default` with 30-day retention, JSON from pino. Cloud Run platform request logs are **excluded** (they contain IPs and user agents).
- **Metrics:** Cloud Run built-in metrics, for viewing only, with no Cloud Monitoring alert policies.
- **Tracing:** none; Sentry `tracesSampleRate: 0`.

## Never do (cost or safety traps)
- `gcloud run deploy --source`. Enabling `containerscanning.googleapis.com`, Cloud Build (except for the fallback kill switch), Compute Engine, Cloud SQL or a load balancer.
- `--min-instances` ≥ 1, `--no-cpu-throttling`, max instances > 2, `_Default` log retention > 30 days.
- Run an admin command or a backup in GitHub Actions. Put any database credential into GitHub.
- Put a token, secret or any personal data other than the target email (R-12) into job args, overrides or labels.
- Print anything from a dump in logs, or store a dump anywhere but the backup bucket.
- Delete an image tagged `prod-current` or `prod-previous` (in the `app` or `migrate` package).
- Add a card to Neon. Turn on the Cloudflare proxy **without a security-reviewer review and sign-off** and the hosting-evaluation.md §3a checklist.

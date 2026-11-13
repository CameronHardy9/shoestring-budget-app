# ADR-0007: Hosting on Cloud Run + Neon at $0
- Status: **Accepted (owner, 2026-11-12)**, including risk R1 (bounded overshoot) and the Cloud Billing spend cap. Several facts are still to be verified: see "Open verification" (V0–V26).
- Date: 2026-11-12 (converted from the proposal on 2026-11-13; revised 2026-11-13 with the owner's round-2 rulings: backups as a Cloud Run job, keyring escrow, Cloudflare fallback gated on security review)
- Areas affected: sre, ci, backend, frontend, data, security
- Inputs: infra/hosting-evaluation.md (sre), docs/mvp-planning/10-contract-review-decisions.md, security findings F-02, F-03, F-08, F-11, F-15, F-17, F-28

## Context
Running cost must be $0 (hard constraint). A card on file is acceptable only with hard spending caps and billing alerts. Cold starts must stay quick: the first API response after idle must be ≤ 3 s p95. Fewer than 10 users, all in the US. The app is served from `shoestring.<domain>` on the owner's existing domain (DNS on **Cloudflare**), with email from `mail.<domain>`. There is no staging: local + production with a tested rollback. Backups: RPO 24 h, expiring within 35 days.

## Fixed constraints
1. **Same origin.** The SPA under `/` and the API under `/api`, on one host, `https://shoestring.<domain>`. This is what makes the `__Host-` SameSite=Strict cookie, no CORS, the CSP and the Host check work.
2. **The host name is permanent.** It is the WebAuthn RP ID and the cookie host, so changing it later invalidates every passkey and every session.
3. **One container image**, built by CI (non-root, multi-stage, `NODE_ENV=production` set in the prod target, no test hooks; ADR-0009) and deployed unchanged **by digest**. Migrations run as a release job with the `migrator` role before traffic moves. Rollback = move traffic to the previous revision.
4. **Health.** Startup probe: `GET /api/healthz` (no DB). Pre-traffic deploy gate: `GET /api/readyz` on the tagged revision.
5. **Admin commands run only as Cloud Run jobs in the private production project (OD-3, F-02),** started by the owner from the authenticated `gcloud` CLI or the console. `purge` runs daily from Cloud Scheduler with counts-only output. Admin commands never run in GitHub Actions: the repo, its logs and its dispatch inputs are public. Each job mounts only the secrets its command needs (admin-commands.md).
6. **Secrets** live only in Secret Manager (prod project). **No database credential and no application key ever enters GitHub** (owner ruling, round 2). Secrets are never in the image or the repo. Secret Manager holds **5 secrets**, one under the free tier's 6 active versions: `database-url`, `migrator-database-url`, `app-keyring` (one keyring replaces the separate MFA and throttle keys, saving a slot), `email-api-key` and `backup-database-url`. Each is mounted only on the service or job that needs it. Deploys use GitHub OIDC → Workload Identity Federation, with no service-account keys. The WIF attribute condition pins this repository, `refs/heads/main` and the GitHub environment.
7. **Operator accounts use phishing-resistant MFA (F-03).** Every operator account uses a passkey or a security key, with recovery codes stored offline: GitHub, Google Cloud (owner account), Neon, Resend (and Brevo if used), Sentry, Better Stack, Cloudflare (DNS), the domain registrar, and the owner's own mailbox. GitHub additionally requires 2FA for the repo and has push protection on. sre puts this first on the first-deploy checklist; the **owner** carries it out and confirms. (In-app MFA stays optional, OD-1; operator accounts are the real root.)
8. **Client IP and proxy hops (F-08).** Fastify `trustProxy` equals the exact number of proxy hops in front of the container. It is never `true`.
   - **Cloud Run domain mapping:** the Google front end appends the client address, so `trustProxy = 1` (to be confirmed by V26).
   - **Cloudflare proxy (fallback, below):** the IP comes from `CF-Connecting-IP`, trusted only when a shared-secret header set by a Cloudflare rule is present. Without the header the request is rejected, and the `run.app` URL is blocked by the Host check.
   - Per-IP keys use the full IPv4 address or the IPv6 /64 prefix.
9. **Capacity bound (F-15, R-10).**
   - Service: `max instances = 2`, `concurrency = 20`, 1 vCPU / 512 MiB, timeout 30 s, request-based billing, `min instances = 0`.
   - The app's argon2id semaphore (4 per instance) bounds hashing memory at about 76 MiB per instance.
   - Never: `--no-cpu-throttling`, `min-instances ≥ 1`, or `max instances > 2`, without a new ADR.
10. **Backups (OD-4, F-17).**
    - **Job (owner ruling, round 2; F-17 option (a)):** a **Cloud Run job `shoestring-backup` in the prod project**, triggered nightly by Cloud Scheduler after the purge. It is not a GitHub Actions job.
      - It streams `pg_dump` as the read-only `backup` role (direct endpoint, `sslmode=verify-full`; credential `backup-database-url` from Secret Manager) through `age`, which encrypts to the owner's **public** key (a plain env var).
      - The output goes into a **private GCS bucket in a separate project**, through a **create-only** JSON API upload with `ifGenerationMatch=0`, so `objectCreator` is sufficient and no existing object can be overwritten.
      - **Dedicated image `prod-backup`**, not the app image: pinned alpine with bash, `postgresql17-client`, `age` and `curl`, running as non-root (~20 MB). It is built in the same CI pipeline as the app image and copied to Artifact Registry by digest as `prod-backup`.
        - **Why a separate image:** `pg_dump` stays off the internet-facing service; app deploys cannot break backups; the size is negligible against the 0.5 GB AR free tier; and the Postgres client major is pinned independently of Node.
      - **Heartbeat:** the job pings the Better Stack heartbeat on success and on failure.
    - **Bucket:** 34-day lifecycle; soft delete off.
    - **Credentials:** the job's service account has a cross-project `roles/storage.objectCreator` grant on the bucket only: it cannot read, list or delete. The deploy identity has **no `actAs`** (`iam.serviceAccountUser`) on the backup service account, so a compromised deploy cannot run code as the backup identity.
    - **Key custody:** the `age` private key lives only in the owner's password manager plus one offline copy. The **offline escrow copy of `APP_KEYRING`** lives in a **separate** password-manager vault, never next to the `age` key and never with backups (owner ruling, round 2).
    - **Hygiene:** dumps are never written to disk on the runner or printed; job logs contain only the object name and byte count.
    - **Proof:** a restore drill before launch covers the whole chain, including the post-restore steps in admin-commands.md (F-11).
11. **Database hygiene (F-28).** Separate `app`, `migrator` and `backup` roles; Neon's default owner role is never used by any component. Long random passwords. `sslmode=verify-full` everywhere. `MIGRATOR_DATABASE_URL` is mounted only on the migrate job.

## Decision
**Option A: Google Cloud Run in `us-east1` (request-based billing, scale to zero, max 2 instances), with Neon free Postgres in `aws-us-east-1`, behind Cloud Run domain mapping on `shoestring.<domain>`.**

| Item | Choice |
|---|---|
| Projects | `shoestring-prod-<suffix>` (service, jobs, Artifact Registry, Secret Manager, Scheduler); `shoestring-backup-<suffix>` (backup bucket only); one billing account |
| Service | `shoestring`: 1 vCPU, 512 MiB, concurrency 20, min 0, max 2, timeout 30 s, startup CPU boost, gen1 |
| Jobs | `shoestring-migrate` (release step, migrator secret only), `shoestring-purge` (Cloud Scheduler, daily 08:00 UTC, `DATABASE_URL` only), `shoestring-backup` (Cloud Scheduler, daily 09:15 UTC after the purge, `backup-database-url` only, `prod-backup` image), `shoestring-admin` (owner-run, no keyring), `shoestring-rewrap-mfa` (owner-run, `APP_KEYRING`). Cloud Scheduler uses 2 of its 3 free jobs: purge at 08:00 UTC and backup at 09:15 UTC. |
| Domain | Cloud Run domain mapping: CNAME `shoestring` → `ghs.googlehosted.com.` in Cloudflare DNS, **DNS-only (grey cloud)**, so Google issues the certificate and sees the client IP |
| Images | CI pushes to GHCR; the deploy workflow copies the digest to Artifact Registry (us-east1) and deploys by digest; the AR cleanup policy always keeps `prod-current` and `prod-previous` |
| Database | Neon free, 0.25 CU fixed, Postgres 17; the app uses the pooled endpoint (pool `min: 0`, idle timeout ≤ 30 s, so Neon can scale to zero); migrations, `pg_dump` and restores use the direct endpoint |
| Cost cap | **Cloud Billing spend cap** (owner's choice) plus a $0.01 budget alert. The billing kill switch is a fallback only, because it is destructive (R5). |
| Email | Resend free on `mail.<domain>` (Brevo free as fallback). Click and open tracking off. SPF and DKIM, and DMARC on the sending subdomain ramping from `p=none` (2 weeks of reports) to **`p=reject`** (F-29). |
| Monitoring | Sentry free (errors + cron monitor for purge), Better Stack free (uptime on `/api/healthz`, backup heartbeat), Cloud Logging `_Default` at 30 days, GCP budget alert. Alerts: down, error spike, missed backup, failed purge, billing, email budget. Push via the Sentry and Better Stack apps. |
| Logs | Cloud Run platform request logs contain client IP, raw User-Agent and query strings (PII). sre excludes them from `_Default` or minimizes them where the platform allows; app logs follow ARCHITECTURE "Never logged". |

Scores against the criteria (from infra/hosting-evaluation.md): C1 ⚠️ (card, spend cap, R1) · C2 ⚠️ (estimated 1.5–3.5 s, must be measured: V9) · C3 ⚠️ (domain mapping is Preview: V3) · C4 ✅ · C5 ✅ · C6 ✅ (Neon: no expiry; restore window unknown, V8) · C7 ✅ · C8 ✅ (Cloud Scheduler → Cloud Run job) · C9 ✅ · C10 ✅.

## Alternatives considered
- **Cloud Run + Supabase:** the free database pauses after about 7 days of low activity and has no backups (fails C6). Second choice only if Neon's wake time fails C2.
- **Koyeb free + Neon (no card):** 0.1 vCPU makes Node start-up and argon2id slow; limited regions. No-card fallback if the owner later rejects card risk.
- **Render free:** sleeps after 15 min with a 30–60 s wake, and the free Postgres expires after 30 days (fails C2, C6).
- **Vercel Hobby + Neon:** same origin, but Fastify must become a serverless function (not our container), and logs are kept for about 1 h.
- **Firebase Hosting rewrites in front of Cloud Run:** would put the shell on a CDN (an LCP gain), but **Firebase Hosting forwards only a cookie named `__session`** and strips all others. `__Host-ss_sid` would never reach the backend, and renaming it to `__session` loses the `__Host-` guarantees that auth.md relies on. Rejected.
- **Global external HTTPS load balancer (needed for Cloud Armor rate limiting):** about $18/month. Violates $0.
- **Cloud SQL, Fly.io, Railway, a Compute Engine e2-micro, Oracle Always Free, Cloudflare Workers:** each is not free, carries a VM operations burden, or is incompatible with Fastify and the argon2 native module (hosting-evaluation.md §2).
- **Paid always-on app + managed Postgres with PITR ($15–40/month):** violates the $0 constraint.

### Fallback for domain mapping (R4): Cloudflare proxy
**Switched on only after a security review (owner ruling, round 2).** If Cloud Run domain mapping is withdrawn or misbehaves, switch the Cloudflare record to **proxied** through a Cloudflare Worker (or origin rule) that forwards to the `run.app` URL, which stays reachable directly. This is $0 within 100,000 requests/day. It also gives free DDoS protection and one WAF rate-limit rule, which partly answers R1. The host name stays the same, so passkeys and cookies survive. Before switching, the following must be done together:
- the backend trusts `CF-Connecting-IP` only with the shared-secret header (constraint 8)
- the Host check still sees `shoestring.<domain>`
- security-reviewer signs off on the change

## Consequences
- **Cost risk R1 (accepted):** Cloud Run has no free platform rate limiting, and billing data lags. A sustained request flood could cost a few dollars, up to the low tens of dollars, before the spend cap acts. Mitigations: max 2 instances, app rate limits, the Host check (blocks the `run.app` URL), the spend cap, and the $0.01 alert.
- **Other risks:**
  - R2 (cold start not met) → measure, then try an always-on free Postgres.
  - R3 (Neon CU-hours exhausted) → fixed 0.25 CU, idle connections closed, V23.
  - R6 (GitHub disables crons after 60 idle days) no longer affects backups, which run on Cloud Scheduler; the backup heartbeat alert stays.
  - R7 (Neon reachable from the internet) → constraint 11.
- **sre:**
  - Knative YAML for the service and jobs.
  - Billing-protection guide (spend cap), cost sheet.
  - Runbooks: deploy, rollback, restore (with the post-restore steps), rotate-secret (including `APP_KEYRING` rotation with `rewrap-mfa`), reset-mfa identity check, operator-MFA checklist (constraint 7).
  - The post-deploy smoke test: security headers, and `/api/_test/reset` returns 404.
  - V26 (proxy hop count).
- **ci:**
  - Deploy workflow (WIF, copy digest to AR, migrate job, readyz gate, traffic move).
  - Build the `prod-backup` image (pinned alpine, `postgresql17-client`, `age`, `curl`, non-root) in the same pipeline and copy it to Artifact Registry by digest (constraint 10). The AR cleanup policy must keep the current `prod-backup` digest. The deploy identity gets no `actAs` on the backup service account.
  - Private source-map upload.
  - Prod-image smoke job (ADR-0009).
- **backend:** `trustProxy` per constraint 8; Host check; config refusals (ARCHITECTURE "Config"); pool settings for Neon scale-to-zero; fast start-up (no lazy work on the request path).
- **data:** `backup` role, `purge_security_events()` function, `sslmode=verify-full` in every URL.
- **Disaster recovery:** moving hosts is a redeploy, a DNS change and a `pg_restore`. Only Secret Manager and the WIF wiring are GCP-specific.

## Open verification (owner or tech lead with web access; tracked in infra/hosting-evaluation.md)
**V0–V25 remain open.** Blocking items:
- **V0:** the spend cap exists for Cloud Run, what it pauses, and how services resume.
- **V1–V3:** free-tier amounts, region, domain mapping.
- **V7:** Neon storage and CU-hours.
- **V9:** measured cold start.
- **V23:** whether an idle connection keeps Neon awake.

New: **V26**, the `X-Forwarded-For` layout Cloud Run delivers through domain mapping (hop count for `trustProxy`), measured with a forged leftmost entry. If a blocking item fails, sre reports it and the owner decides whether to switch to a fallback option or relax a constraint. This ADR is amended, not silently changed.

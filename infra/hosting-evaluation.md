# Hosting evaluation for Shoestring at $0
- Owner: sre
- Date: 2026-11-12
- Status: **Option A accepted by the owner on 2026-11-12** (docs/mvp-planning/10-contract-review-decisions.md), including risk R1. The architect records it as ADR-0007.
- Owner rulings: the **Cloud Billing spend cap** is the hard cap (the kill switch is a documented fallback only). **DNS is on Cloudflare.** The Cloudflare proxy is the fallback for domain mapping and partial R1 mitigation (§3a). Alerts: down, error spike, missed backup, failed purge, billing, plus email quota (F-09).
- Round 2 rulings (2026-11-13):
  - The nightly backup is a **Cloud Run job** (no DB credential in GitHub).
  - Admin emails go in job `--args` (**R-12 accepted**).
  - The `APP_KEYRING` escrow copy (it replaces `MFA_ENCRYPTION_KEY` and `THROTTLE_KEY`) lives in a separate vault.
  - The restore notice is sent manually.
  - The Cloudflare proxy is switched on **only after a security-reviewer review**.
  - V26 must be verified before launch.
  - DMARC ramps to `p=reject`.
  - The env names `MIGRATOR_DATABASE_URL` and `APP_RELEASE` are ratified.
- Scored against the criteria C1 to C10 in docs/decisions/0007-hosting-constraints-at-zero-cost.md

> **Evidence level.** sre had no web access for this evaluation. Free-tier terms come from the tech lead's research on 2026-11-12 plus sre's background knowledge, which may be out of date. Every number or behaviour that the decision depends on is tagged **(verify Vn)** and listed in [What to verify](#what-to-verify-before-accepting-adr-0007). Nothing here should be treated as confirmed until the owner (or the tech lead with web access) has checked it against the provider's current pricing page.

## 1. Context (for ADR-0007 "Context")
- $0 per month, hard. A card on file is acceptable only with hard caps the owner applies.
- First API response after idle must be at most 3 s p95, including any database wake (NFR "Cold start", C2).
- Under 10 invite-only US users. Local + production only. No staging.
- One container (Fastify serves the SPA at `/` and the API at `/api`) on `https://shoestring.<domain>`. The host name is permanent because it is the WebAuthn RP ID and the `__Host-ss_sid` cookie host.
- Backups: RPO 24 h, encrypted, expire within 35 days, restore drill before launch.
- A daily `purge` admin command needs a free scheduler. Alerts go to email and phone push.

### Expected load (used for every "headroom" figure)
| Item | Estimate | Basis |
|---|---|---|
| API requests | ~15,000 / month | 10 users × 3 sessions/day × 15 calls |
| Static requests | ~3,000 / month | Service worker caches the shell, so mostly first loads and updates |
| Uptime pings | ~8,600 / month | `/api/healthz` every 5 min |
| Total requests | **~30,000 / month** (plan for 100,000) | ×3 safety margin |
| Cold starts | ~20–40 / day | Scale to zero between bursts of use |
| Database size | < 50 MB in the first year | < 10 users, manual entry |
| Emails | < 100 / month | Invites, verification, resets, security notices |

## 2. Options compared
Legend: ✅ meets · ⚠️ meets with caveats · ❌ fails. "Cold start" means the first API response after a long idle, including the database wake.

| | **A. Cloud Run + Neon** (accepted) | **B. Cloud Run + Supabase** | **C. Koyeb free + Neon** (no card) | **D. Render free** (no card) | **E. Vercel Hobby + Neon** (no card) |
|---|---|---|---|---|---|
| C1 Cost $0 | ⚠️ $0 at our load. Card on file; protected by a spend cap or kill switch, but billing data lags, so a request flood could cost a few dollars before the cap acts (Risk R1) | ⚠️ Same as A for the app; the database has no card | ✅ No card (verify V12) | ✅ No card | ✅ No card; hard stop at limits |
| C2 Cold start | ⚠️ Container ~1–2 s plus Neon wake 0.3–2 s; **estimated 1.5–3.5 s p95; must be measured** (V5, V9) | ✅ Container ~1–2 s; database always on **until it pauses** | ⚠️ Wake from sleep claimed fast (verify V13); 0.1 vCPU makes Node start and argon2id slow | ❌ Spins down after 15 min idle; wake takes ~30–60 s | ✅ Function cold start well under 1 s plus Neon wake |
| C3 Custom domain + TLS at $0 | ⚠️ Cloud Run domain mapping (Preview, limited regions, V3), or Firebase Hosting rewrites (cookie restriction, see §3) | ⚠️ Same as A | ⚠️ Verify custom domains are on the free plan (V12) | ✅ Free custom domains with TLS | ✅ Free |
| C4 Same origin | ✅ One container | ✅ | ✅ | ✅ | ⚠️ Static files on CDN + API as a serverless function; same origin, but **not one container** (contradicts ADR-0001's container model) |
| C5 US region | ✅ us-east1 + Neon aws-us-east-1 | ✅ | ⚠️ Free instance region limited (Washington, D.C. or Frankfurt; V12) | ✅ Ohio / Oregon / Virginia | ✅ |
| C6 Postgres | ✅ Neon: no expiry, wakes in < 1–2 s, 0.5 GB (V7), PITR window unknown (V8) | ❌ **Pauses after ~7 days of low activity** (manual unpause, minutes); free plan has **no backups** (V15) | ✅ Same as A | ❌ Free Postgres **expires after 30 days** | ✅ Same as A |
| C7 Runtime | ✅ Node 24 container, 512 MiB, max-instances | ✅ | ⚠️ 512 MB, 0.1 vCPU | ⚠️ 512 MB, 0.1 vCPU | ⚠️ Node runtime, not our image |
| C8 Jobs | ✅ Cloud Scheduler (3 free jobs; we use 2: purge and backup) → Cloud Run Jobs | ✅ | ⚠️ GitHub Actions cron only | ⚠️ Cron jobs are paid; GitHub Actions cron | ⚠️ Vercel cron on Hobby is limited (once a day, V14) |
| C9 Ops | ✅ 30-day logs free, one-command traffic rollback, GitHub OIDC (no keys), `X-Forwarded-For` from Google front end | ✅ | ⚠️ Rollback by redeploy, logs limited | ⚠️ | ✅ Instant rollback; logs ~1 h on Hobby (V14) |
| C10 Lock-in | ✅ Plain container + plain Postgres | ✅ | ✅ | ✅ | ⚠️ Fastify must be wrapped as a function |
| **Verdict** | **Accepted 2026-11-12** | Second choice for the database only if Neon's wake time fails C2 | **No-card fallback** if the owner rejects card risk | Rejected (C2, C6) | No-card fallback that needs ADR-0001 changes |

### Considered and rejected quickly
| Option | Why not |
|---|---|
| Fly.io | No free tier for new organisations since 2024 (pay as you go after a trial). |
| Railway | Trial credit, then paid. |
| Cloud Run + Cloud SQL | Cloud SQL has no free tier (~$7–10/month minimum). |
| Global external HTTPS load balancer in front of Cloud Run | Forwarding rule ~$18/month. Not free. Cloud Armor rate limiting needs it, so platform-level rate limiting is not available at $0 (see Risk R1). |
| Compute Engine e2-micro "always free" VM (us-east1/us-central1/us-west1) | No cold start at all, but we would patch the OS, run TLS (Caddy), and probably Postgres on 1 GB RAM. 1 GB/month free egress, and the external IPv4 address may be charged (V16). Not "boring to operate". |
| Oracle Cloud Always Free | Generous ARM VMs, but the same VM ops burden, a card is required, and idle instances can be reclaimed. |
| Cloudflare Workers / Deno Deploy for the API | Fastify plus the `argon2` native module do not run on Workers without rework. |
| Aiven free Postgres | Possibly always-on (no wake) with a US region, which would beat Neon on cold start; terms unverified (V17). Worth checking if Neon's wake fails C2. |

## 3. Decision (accepted 2026-11-12; for ADR-0007 "Decision")
**Option A: Google Cloud Run (request-based billing, scale to zero) in `us-east1`, with Neon free Postgres in `aws-us-east-1`, behind Cloud Run domain mapping on `shoestring.<domain>`.**

**Nothing fully meets "$0 + quick" without residual risk.** Option A meets both on paper, but:
1. **$0 depends on a card with caps whose enforcement lags.** No Google Cloud mechanism guarantees literally $0 because billing data arrives hours late. With the caps in docs/runbooks/billing-protection.md, the realistic worst case is a few dollars to the low tens of dollars during a sustained request flood before the cap acts (Risk R1). **The owner accepted this on 2026-11-12.**
2. **"Quick" is an estimate until measured.** Neon's wake time (0.3–2 s) stacks on the container start (~1–2 s). The 3 s p95 target is plausible but not proven. sre measures it in the first deploy (V9). If it fails, the fallback is to try an always-on free Postgres (Supabase with a keep-alive from the nightly job, or Aiven) rather than change the app host.

### Configuration in the decision
| Item | Choice | Why |
|---|---|---|
| GCP projects | `shoestring-prod-<suffix>` (app) and `shoestring-backup-<suffix>` (backup bucket only), on one billing account | A kill switch or a compromised deploy identity on the app project cannot touch backups |
| Region | **us-east1** (South Carolina) for Cloud Run, Artifact Registry and the backup bucket | Free-tier region for Cloud Storage; domain mapping supported (V3); ~10–15 ms to Neon in N. Virginia (V10). us-east4 is closer to Neon (~2 ms) and is a later optimisation if V3 and V2 confirm it is free and supports domain mapping. |
| Cloud Run service | `shoestring`: 1 vCPU, 512 MiB, concurrency 20, min 0, **max 2 instances**, timeout 30 s, startup CPU boost on, request-based billing (never `--no-cpu-throttling`), gen1 execution environment (faster cold start, V5) | Keeps cost inside the free tier and bounds the worst case |
| Health | Startup probe `GET /api/healthz`. The deploy gate calls `GET /api/readyz` on the tagged revision before traffic moves. | A startup probe on `/readyz` would wake Neon on every instance start and turn a Neon outage into a total outage (no SPA either). **Differs from ARCHITECTURE.md "Health", see cross-area request to architect.** |
| Custom domain | **Cloud Run domain mapping** (CNAME `shoestring` → `ghs.googlehosted.com.`) | $0, keeps the `__Host-ss_sid` cookie and one origin. Preview feature with known extra latency; acceptable for < 10 users. |
| Image registry | CI builds once and pushes to **GHCR** (public, free, scannable). The deploy workflow copies that digest into **Artifact Registry** `us-east1-docker.pkg.dev/<project>/shoestring/app` and deploys by digest. | Cloud Run pulls only from Artifact Registry or Docker Hub (V4). AR free storage is 0.5 GB, so AR holds only deployed images; a cleanup policy keeps `prod-current`, `prod-previous` and the 3 newest. |
| Database | Neon free, one project, branch `main`, compute fixed at 0.25 CU, Postgres 17 (V7), pooled endpoint for the app, direct endpoint for migrations and `pg_dump` | 100 CU-hours/month ≈ 400 h at 0.25 CU; we expect ~25–35 CU-h |
| Secrets | Google Secret Manager in the app project: **5 secrets** (`database-url`, `migrator-database-url`, `app-keyring`, `email-api-key`, `backup-database-url`), loaded **per consumer** (F-02, F-28). **No production or backup secret in GitHub.** | Free tier is 6 active versions and 10,000 accesses/month (V6); one slot spare. |
| Deploy identity | GitHub Actions OIDC → Workload Identity Federation → `shoestring-deployer` service account; no JSON keys anywhere | Least privilege, nothing to leak on a public repo |
| Migrations | Cloud Run Job `shoestring-migrate` (same image, `migrator` secret only), executed with `--wait` before traffic moves | Same image and config as the service; migrator credential never reaches GitHub |
| Purge | **Cloud Scheduler** (1 of 3 free jobs) → Cloud Run Job `shoestring-purge` running `node dist/admin.js purge --yes` daily at 08:00 UTC, with `DATABASE_URL` only and counts-only output (OD-3, F-02) | No production secret is copied into GitHub. Cloud Scheduler is more reliable than Actions cron. |
| Backups | **Cloud Scheduler** (2nd of 3 free jobs) → Cloud Run Job `shoestring-backup` at 09:15 UTC, running a small pinned backup image (deploy/backup/backup.sh). `pg_dump` (read-only `backup` role) → `age` (public key only) → private bucket in the separate backup project via `objectCreator` only. Lifecycle delete at 34 days, soft delete off. Better Stack heartbeat. | Owner ruling 2026-11-13: the DB credential never enters GitHub. See docs/runbooks/README.md "Backup design". |
| Admin commands | **Cloud Run Job `shoestring-admin`, never GitHub Actions** (OD-3). The target email is passed in `--args` (**R-12 accepted** 2026-11-13: it stays in owner-only execution records and audit logs for ~400 days, V34; disclosed in the privacy notice). Output shows IDs and counts only. | docs/runbooks/admin-commands.md |
| Monitoring | Sentry free (errors, email-quota warning, one cron monitor for `purge`, V18), Better Stack free uptime + heartbeat (V19), Cloud Logging (30 days), GCP budget alerts. Push through the Sentry and Better Stack mobile apps. | observability/README.md |
| Email | **Resend** free (100/day, 3,000/month, 1 domain, V20) on `mail.<domain>`; Brevo free is the fallback | Simple API; limits far above our ~100/month |

### Custom-domain options on Cloud Run, compared
| Option | Cost | Same origin | Cookie | Notes |
|---|---|---|---|---|
| **Domain mapping (chosen)** | $0 | ✅ | `__Host-ss_sid` works | Preview; limited regions (V3); Google warns of latency; managed cert takes 15 min–24 h to issue; needs domain verification in Search Console |
| Firebase Hosting rewrite `/**` → Cloud Run | $0 within 10 GB storage and 360 MB/day transfer (V11) | ✅ | ❌ **Firebase Hosting strips every cookie except one named `__session`** (V11). Our `__Host-ss_sid` would never reach the backend. Using `__session` loses the `__Host-` protections that auth.md relies on. | CDN-cached static shell is a real LCP gain. Needs an auth.md change and a security-reviewer sign-off. Not recommended. |
| **Cloudflare proxy (fallback, DNS is on Cloudflare)** | $0 (Free plan) | ✅ | ✅ | See §3a. Adds free DDoS protection and one free rate-limit rule (partial R1 mitigation), at the cost of a TLS-terminating third party, an extra proxy hop and origin bypass. |
| Global external load balancer | ~$18/month | ✅ | ✅ | Not free. |

### Client IP and proxy hop count (F-08)
Fastify must use an exact hop count, **never `trustProxy: true`**: `true` takes the leftmost `X-Forwarded-For` entry, which the client controls.
| Path | What the app receives | `trustProxy` | Client IP |
|---|---|---|---|
| **Normal: domain mapping, DNS-only** (and the `run.app` URL) | Google's front end appends the connecting client's address to any `X-Forwarded-For` the client sent, then connects to the container | **`1`** (expected; **measured at bootstrap**, V26) | Rightmost `X-Forwarded-For` entry |
| Cloudflare proxy fallback (§3a) | Cloudflare sets `CF-Connecting-IP` and appends the client to `X-Forwarded-For`; Google then appends Cloudflare's egress IP | Hop count `1` still yields **Cloudflare's** IP, which is useless for rate limits | `CF-Connecting-IP`, **trusted only if** the request carries the origin-auth header (§3a), otherwise the hop-1 address |
Per-IP keys use the full IPv4 address or the IPv6 /64 (backend, auth.md §14). The bootstrap runbook measures the real header shape with a throwaway echo service before launch (bootstrap-production.md step 14).

## 3a. Cloudflare proxy fallback (documented, not enabled)
**Use it when** (a) Cloud Run domain mapping is withdrawn, unavailable in us-east1, or failing to renew its certificate, or (b) a request flood (R1) is under way or keeps recurring. Normal operation is **DNS-only (grey cloud)** on every mapped record.

| Variant | How | When |
|---|---|---|
| **P1: proxy on top of domain mapping** | Turn the `shoestring` CNAME to **Proxied** (orange cloud). SSL/TLS mode **Full (strict)**. Google's domain-mapping certificate stays on the origin. | Flood mitigation while domain mapping still works. Risk: Google's certificate renewal may fail behind the proxy (verify V27). Switch back to DNS-only for renewal if it does. |
| **P2: Worker reverse proxy to the `run.app` URL** | A Cloudflare Worker on route `shoestring.<domain>/*` forwards to `https://shoestring-<hash>.us-east1.run.app`, adding the origin-auth header. Free plan: 100,000 requests/day. | Domain mapping is unavailable. Needs a small Worker script in infra/ (written only if this fallback is triggered) and a backend change. |

**Switch-on rule (owner ruling 2026-11-13):** neither variant is switched on until **security-reviewer has reviewed and signed off** the change (record the review in docs/security/). In an emergency, the owner asks the tech lead for that review before flipping the record. Waiting costs at most a few dollars (R1 accepted).

Trade-offs (for that review):
- **TLS:** Cloudflare terminates TLS with its free Universal SSL certificate, so **Cloudflare sees plaintext** traffic, including session cookies and financial data. That is a new third party with plaintext access. The origin leg stays HTTPS (Full (strict)). HSTS still comes from the app.
- **Hop count and client IP:** see the table above. The backend must read `CF-Connecting-IP` only when a shared-secret header proves the request came through our zone. This means a new secret `shoestring-origin-auth`, which would be the 6th Secret Manager version, still inside the free tier (V6). It is added only if the fallback is used.
- **Origin bypass:** the `run.app` URL (and in P1 the domain mapping itself) stays reachable directly, so an attacker who finds it bypasses Cloudflare. Cloudflare protection is therefore **partial** for R1. The origin-auth check makes bypassing traffic count as "unknown client", which falls under the global rate limit.
- **Things Cloudflare must not do:** inject scripts or rewrite pages, which would break the CSP (`script-src 'self'`). Turn off Rocket Loader, Email Address Obfuscation, Web Analytics auto-injection, Zaraz and Bot Fight Mode (which breaks API calls from the PWA). Add a Cache Rule that **bypasses cache for `/api/*`**. Leave "Always Use HTTPS" on.
- **Free rate limiting:** one WAF rate-limiting rule on the Free plan (verify V28), for example `/api/auth/*` at 20 requests per 10 s per IP, block 10 s. Plus Cloudflare's always-on L7 DDoS mitigation.

### Hidden-cost traps (all mitigated in billing-protection.md)
1. **Artifact Registry storage over 0.5 GB** ($0.10/GB-month). Mitigation: only deployed images go to AR, cleanup policy, image target ≤ 150 MB. A Cloud Run revision whose image digest has been deleted can no longer start instances, so the cleanup policy must always keep `prod-current` and `prod-previous`.
2. **Container Scanning API** ($0.26 per scanned image, V21). Never enable `containerscanning.googleapis.com`; CI scans in GitHub.
3. **`gcloud run deploy --source`** silently uses Cloud Build, creates a `cloud-run-source-deploy` AR repository and a staging bucket. Never use it.
4. **Cloud Logging** over 50 GiB ingestion or retention over 30 days. Our volume is ~50 MB/month. Never raise `_Default` retention above 30 days. Exclude Cloud Run's platform request logs, which also contain client IPs and user agents that our logging policy forbids (security-reviewer to confirm).
5. **Cloud Monitoring alerting policies** may now be charged (V22). We use Sentry and Better Stack for alerts, not Cloud Monitoring policies.
6. **Secret Manager** beyond 6 active versions or 10,000 accesses ($0.06/version, $0.03/10,000). Destroy old versions after a rotation; watch cold-start count.
7. **Instance-based billing** (`--no-cpu-throttling`) or `--min-instances ≥ 1` bills idle time. Never set either.
8. **Cross-region image pulls and storage.** AR, the service and the bucket all live in us-east1.
9. **Cloud Storage soft delete** (7-day default) bills deleted objects for 7 more days and keeps "expired" backups alive past 35 days. Create the bucket with soft delete off.
10. **Free tiers are per billing account.** Other projects on the same billing account share them (V1).
11. **Kill-switch function (fallback cap only)** builds with Cloud Build and stores its image in a `gcf-artifacts` AR repository that counts toward the same 0.5 GB. Needs its own cleanup policy.
12. **Neon CU-hours.** If an idle Cloud Run instance holds an open database connection and that keeps Neon awake, one month always-on at 0.25 CU is ~182 CU-h, which exceeds the 100 CU-h limit and **suspends the database for the rest of the month** (V23). Mitigation: backend pool `min: 0`, `idleTimeoutMillis ≤ 30000`; measured in V23.

### Backups, region and lock-in summary
| | Option A |
|---|---|
| Provider backups | Neon free restore window: unknown, perhaps hours (V8). Treated as a bonus, not as RPO. |
| Our backups | Nightly encrypted `pg_dump` to Cloud Storage in a separate project. RPO 24 h. |
| Region | us-east1 (app, registry, backups) + aws-us-east-1 (Neon). All US. |
| Lock-in | Low. Knative service YAML + standard container + `pg_dump`. Moving hosts is a redeploy, a DNS change and a restore. Secret Manager and WIF wiring are the only GCP-specific parts. |

## 4. Risks (for ADR-0007 "Consequences")
| # | Risk | Likelihood / impact | Mitigation | Owner decision |
|---|---|---|---|---|
| R1 | **Request flood costs money before the cap acts.** Cloud Run has no free platform rate limiting (Cloud Armor needs a paid load balancer). Every 429 still counts as a request ($0.40 per million past 2 M, V2). At max 2 instances, CPU is bounded at ~$4/day, but request charges are bounded only by the attacker's rate. Billing data lags hours, so the cap acts late. Example: 1,000 req/s for 12 h ≈ 43 M requests ≈ $17 + ~$2 CPU. | Low / low–medium | max-instances 2, CPU quota 3,000 m, app-level rate limits, the custom domain hides the `run.app` URL, spend cap, budget alert at $0.01; Cloudflare proxy fallback (§3a) if a flood happens | **Accepted by the owner 2026-11-12** |
| R2 | 3 s p95 cold start not met | Medium / medium | Measure (V9); uptime pings every 5 min keep a Cloud Run instance warm at no cost (request-based billing bills only during requests); try gen1 vs gen2; then try an always-on free Postgres | Accept "measure, then decide" |
| R3 | Neon exhausts 100 CU-h → database suspended until the 1st | Low if V23 passes / high | Fixed 0.25 CU, idle connections closed, monthly usage check, startup probe does not touch the DB | — |
| R4 | Domain mapping is Preview: could change or be withdrawn | Low / medium | Fallback: Cloudflare proxy, variant P2 (§3a). The host name stays the same, so passkeys survive. | — |
| R5 | Kill switch (fallback only) is destructive: detaching billing stops every service in the app project, and resources may eventually be deleted | Low / high | Spend cap chosen (owner, 2026-11-12). The kill switch is used only if V0 shows the cap cannot cover Cloud Run. Neon and the backup project are out of its reach. | Owner decides again only if V0 fails |
| R6 | ~~GitHub disables scheduled workflows after 60 days~~ **Retired 2026-11-13:** backups now run on Cloud Scheduler. Remaining risk: the spend cap pausing Cloud Run would also pause backups (the site is down then too). | Low / medium | Better Stack heartbeat alerts within 26 h | — |
| R7 | Neon has no IP allow-list on free; the database is reachable from the internet with a password | Low / high | Strong generated passwords, TLS required, separate `app`, `migrator` and `backup` roles, rotation runbook | security-reviewer |
| R8 | Spend cap behaviour unconfirmed (Preview vs GA for Cloud Run) | — | V0 is checked at bootstrap step 2. If the cap cannot cover Cloud Run, stop and ask the owner: kill switch (2B) or alerts only. | Only if V0 fails |

## 5. DNS records on Cloudflare (owner adds them; exact values come from each dashboard)
Cloudflare dashboard → the `<domain>` zone → **DNS → Records → Add record**. Cloudflare's **Name** field is relative to the zone (type `shoestring`, not `shoestring.<domain>`). **Every record below is "DNS only" (grey cloud).** TXT and MX records cannot be proxied anyway. The `shoestring` CNAME may be proxied only under the Cloudflare fallback (§3a). TTL: Auto.

| Purpose | Type | Name (Cloudflare) | Content | Proxy | Source of value |
|---|---|---|---|---|---|
| Prove domain ownership to Google (one-time; may be removed after verification is recorded, but keeping it is harmless) | TXT | `@` | `google-site-verification=<token>` | n/a | Search Console, opened by `gcloud domains verify <domain>` |
| App | CNAME | `shoestring` | `ghs.googlehosted.com` | **DNS only** | `gcloud beta run domain-mappings describe` (`status.resourceRecords`) |
| Certificate authorities (only if `dig +short CAA <domain>` returns anything) | CAA | `shoestring` | `0 issue "pki.goog"` and `0 issue "letsencrypt.org"` | n/a | Google-managed certificates (verify V3) |
| Email: DKIM | TXT | `resend._domainkey.mail` | `p=<public key>` | n/a | Resend → Domains → `mail.<domain>` |
| Email: bounce / return path | MX | `send.mail` | `feedback-smtp.us-east-1.amazonses.com`, priority 10 | n/a | Resend dashboard (region shown there) |
| Email: SPF | TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` | n/a | Resend dashboard |
| Email: DMARC for the sending subdomain (F-29) | TXT | `_dmarc.mail` | Ramp: `v=DMARC1; p=none; adkim=s; aspf=r` → `p=quarantine` → **`p=reject`** (see note) | n/a | sre policy |

Notes:
- **DMARC ramp to `p=reject`** (F-29; owner/coordinator 2026-11-13). The ramp catches a misaligned record before mail gets rejected.
  1. **Bootstrap (step 11):** publish `p=none` and send the alignment test. In Gmail, **Show original** must show SPF, DKIM and DMARC all PASS.
  2. **After the test passes and ≥ 3 days of clean aggregate reports:** change to `p=quarantine`.
  3. **After ≥ 7 more clean days, and before the first real invite (launch):** change to **`p=reject; adkim=s; aspf=r; pct=100`**. This is the end state and a launch blocker.
  - Why it is safe to be quick: nothing else sends from `mail.<domain>`. DKIM is signed as `mail.<domain>` (strict alignment passes). The return path is `send.mail.<domain>`, so SPF uses relaxed alignment.
  - Reports: Cloudflare **Email → DMARC Management** (free, verify V29) supplies the `rua=` address. Without it, judge from the test sends.
- A subdomain DMARC record overrides the apex `sp=` policy for `mail.<domain>`, so the other uses of the domain are unaffected.
- Nothing changes at the apex except the verification TXT.
- While the record is DNS-only, Cloudflare's page features (Rocket Loader and the rest) never touch our traffic. If the proxy fallback is switched on, apply §3a's "must not do" list first.
- Do not enable **Cloudflare Email Routing** on `mail.<domain>`: it would add MX records that conflict with Resend's.

## What to verify (before or during bootstrap)
Check each against the provider's current docs and note the date. Items marked **blocking** can change the recommendation.
| # | Claim to verify | Where | Blocking? |
|---|---|---|---|
| V0 | A Cloud Billing budget "spend cap" exists, supports Cloud Run (GA or Preview?), what it pauses (Cloud Run only? Artifact Registry? Secret Manager?), how fast it acts, and how services resume | docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps | **Yes** (decides R1/R5) |
| V1 | Cloud Run free tier: 2 M requests, 180,000 vCPU-s, 360,000 GiB-s per **billing account** per month (request-based); separate allowance for instance-based billing and jobs; free egress amount in North America (believed 1 GiB) | cloud.google.com/run/pricing | **Yes** |
| V2 | The free tier applies in us-east1 (and us-east4); list prices past the free tier (believed $0.000024/vCPU-s, $0.0000025/GiB-s, $0.40/M requests in Tier 1) | cloud.google.com/run/pricing | **Yes** |
| V3 | Cloud Run domain mapping: still available, regions include us-east1, works for a subdomain, CAA requirements, HTTP→HTTPS behaviour | cloud.google.com/run/docs/mapping-custom-domains | **Yes** |
| V4 | Cloud Run can pull only from Artifact Registry / Docker Hub (not GHCR); AR free storage is 0.5 GB per billing account; layers shared between images are stored once | cloud.google.com/artifact-registry/pricing | No |
| V5 | gen1 vs gen2 cold start; startup CPU boost is free within the vCPU-s allowance | Cloud Run docs; then measure | No |
| V6 | Secret Manager free tier: 6 active versions, 10,000 access operations; whether env-var secrets are accessed at each instance start; whether disabled versions count as active | cloud.google.com/secret-manager/pricing | No |
| V7 | Neon free plan: storage per project (0.5 GB or 1 GB?), 100 CU-h/project, 5 GB egress, compute size can be fixed at 0.25 CU, no card needed, no deletion of inactive free projects, default Postgres version, number of projects allowed (we need 2 during a restore drill) | neon.com/pricing, neon.com/docs/introduction/plans | **Yes** (storage, CU-h) |
| V8 | Neon free restore window (instant restore / PITR) length | Neon docs "Instant restore" | No |
| V9 | **Measured** first API response after > 30 min idle, p95 of 20 tries, via `shoestring.<domain>` | sre, after the first deploy | **Yes** (C2) |
| V10 | Round-trip latency us-east1 ↔ Neon aws-us-east-1 | measure with `psql \timing` from a Cloud Run Job | No |
| V11 | Firebase Hosting cookie rule (`__session` only) and free quotas (only if the Firebase option is reconsidered) | firebase.google.com/docs/hosting/manage-cache | No |
| V12 | Koyeb free: still offered, needs no card, custom domains, region, instance size, sleep threshold | koyeb.com/pricing | Only for option C |
| V13 | Koyeb wake time from sleep | koyeb.com docs | Only for option C |
| V14 | Vercel Hobby: function cold start, cron limits, log retention, non-commercial terms | vercel.com/pricing | Only for option E |
| V15 | Supabase free: pause rule (~7 days; what counts as activity), backups (none?), IPv4 pooler | supabase.com/pricing | Only for option B |
| V16 | Compute Engine free tier external IPv4 charge | cloud.google.com/free | No |
| V17 | Aiven free Postgres: always-on, US region, storage, inactivity shutdown | aiven.io/pricing | Only if V9 fails |
| V18 | Sentry free (Developer) plan: errors/month (believed 5,000), cron monitors included (believed 1), issue alert conditions available, mobile push options | sentry.io/pricing | No |
| V19 | Better Stack free: monitor count, min interval, heartbeats included, mobile-app push on free | betterstack.com/pricing | No (fallback: UptimeRobot + Healthchecks.io) |
| V20 | Resend free: 100/day, 3,000/month, 1 domain; current DNS record names | resend.com/pricing | No (fallback: Brevo 300/day) |
| V21 | Artifact Analysis on-push scanning price, and that it stays off unless the API is enabled | cloud.google.com/artifact-analysis/pricing | No |
| V22 | Cloud Monitoring alerting policy pricing and uptime-check pricing | cloud.google.com/stackdriver/pricing | No |
| V23 | **Does an idle open connection keep a Neon compute awake?** Test: one request, wait 10 min with no traffic except `/api/healthz` pings, check the compute state in the Neon console | Neon docs "Scale to zero", then measure | **Yes** (R3) |
| V24 | Cloud Storage free tier: 5 GB-month in us-east1, 5,000 Class A ops, a JSON API simple upload with `ifGenerationMatch=0` succeeds with `roles/storage.objectCreator` only (deploy/backup/backup.sh); lifecycle actions may lag up to 24 h | cloud.google.com/storage/pricing | No |
| V25 | IAM role that lets Cloud Scheduler execute a Cloud Run Job (`roles/run.invoker` vs a jobs-specific role) | Cloud Run docs "Execute jobs on a schedule" | No |
| V26 | **Measured** `X-Forwarded-For` shape on Cloud Run via domain mapping: one appended entry (hop count 1) or more | bootstrap-production.md step 14 (echo probe) | **Yes. Launch blocker** (F-08; security-reviewer requires it before launch) |
| V27 | Google domain-mapping certificate renewal still works with the Cloudflare proxy on (fallback P1) | Cloud Run + Cloudflare docs | Only for the fallback |
| V28 | Cloudflare Free plan: number of WAF rate-limiting rules, Workers free requests per day | cloudflare.com/plans | Only for the fallback |
| V29 | Cloudflare DMARC Management is free and supplies a `rua` address | Cloudflare docs | No |
| V30 | Neon free supports Postgres **17** (local is 17.12); Neon's 17.x minor; Postgres 18 status | Neon docs "Postgres version support"; then `select version();` | No (must match the major) |
| V31 | Secret env vars pinned to numbered versions resolve at each job execution start; job `--args` overrides are kept on the execution record (how long?) | Cloud Run docs "Execute jobs" | No |
| V34 | **Do Admin Activity audit logs record Cloud Run job arguments** (the `RunJob` request with `overrides.containerOverrides.args`), and with what retention? Expected: yes, in `_Required` for **400 days**, not configurable or excludable. Check by running `shoestring-admin --help` once and reading the audit entry: `gcloud logging read 'logName:"cloudaudit.googleapis.com%2Factivity" AND protoPayload.methodName:"RunJob"' --limit 1 --format json`. | Cloud Audit Logs docs; the check described | No (R-12 accepted either way; the privacy notice must state the real retention) |
| V35 | Does executing a Cloud Run job **with overrides** (`--args`, `--update-env-vars`) require `iam.serviceAccounts.actAs` on the job's SA, or only `run.jobs.runWithOverrides`? Either way the deployer has no role on `shoestring-backup` (F-39). | Cloud Run IAM docs | No (defence in depth) |
| V36 | The **minimum project-level permissions** a per-resource `roles/run.developer` deployer needs for `gcloud run deploy --no-traffic --tag`, `update-traffic`, `revisions describe` and `jobs execute --wait` | First GitHub deploy (bootstrap step 12h) | No (add single permissions only) |
| V32 | Each operator service's supported MFA types (passkey / security key / TOTP only) and whether it offers Google or GitHub sign-in | Each account's security settings | No (F-03 checklist) |
| V33 | Resend: click and open tracking are off by default and can be forced off per domain; quota-warning emails exist | Resend docs | No (F-06, F-09) |

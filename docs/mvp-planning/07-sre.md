# Meeting 7: sre
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP ops scope (solo developer)
- **Do now:**
  - Environments: local (compose) and production, plus per-PR previews if the platform makes them cheap
  - The CI-built image is deployed unchanged to every environment
  - Rolling deploy gated by `/healthz` and `/readyz`, with a one-command rollback
  - Managed Postgres with daily backups and PITR, and one restore drill before launch
  - Uptime checks, error tracking and JSON logs with request IDs
  - One SLO (for example, "record a transaction" succeeds 99.5% of the time over 30 days) and two alerts: site down and error spike
  - Secrets in the platform's secret store, separate per environment
  - Runbooks: deploy, rollback, restore, rotate a secret
- **Defer:** multi-region, blue-green, distributed tracing, a full metrics stack, Terraform for everything, autoscaling, paging

### Decisions for the owner
1. **Hosting:** (a) Fly.io, (b) Render, (c) Railway, (d) Vercel + Neon or Supabase, (e) AWS. *Recommended: Render or Fly.io, depending on the stack.*
2. **Monthly budget:** $0–10 (free tiers, the database may sleep or expire), $15–40 *(recommended: an always-on app and a paid database with PITR)*, or $50+
3. **Staging:** (a) none, (b) per-PR previews *(recommended if available, otherwise (a) plus a solid rollback)*, (c) a permanent staging environment (about double the cost)
4. **Expected users:** just you, under 100, or over 1,000, at launch and in 12 months
5. **Backup targets:** (a) RPO 24h / RTO 4h, (b) RPO 5–15 min / RTO 1h with PITR *(recommended)*
6. **Custom domain:** from day one *(recommended, because cookie and auth origins are painful to migrate)*. Who is the DNS provider?
7. **IaC:** (a) the platform's own blueprint (render.yaml or fly.toml) *(recommended)*, (b) Terraform or OpenTofu, (c) Pulumi
8. **Monitoring:** Sentry free tier plus Better Stack or UptimeRobot, with alerts by email or push *(recommended)*
9. **Data region:** US or EU?

### Draft task list
1. infra/CLAUDE.md: platform, environments, dry-run command, where secrets live
2. Platform IaC in infra/ with validated plan output
3. deploy/ config: health checks, limits, timeouts, platform rate limit, migrations run before release
4. observability/: uptime, error tracking, log format, SLO and alerts
5. SLOs in ARCHITECTURE.md (via the architect); RPO/RTO in the runbooks
6. Runbooks for deploy, rollback, restore, secret rotation, and each alert
7. A restore drill, with the date recorded
8. A monthly cost sheet
9. Exact first-deploy commands for the owner to run

### Dependencies
architect (stack, single or split service, auth and domain, journeys) · ci-engineer (image and registry; `git init` and a GitHub remote first) · data-engineer (migrations as a release step, expand/contract) · backend (`/healthz`, `/readyz`, request IDs, Sentry) · frontend (error tracking, request IDs) · security-reviewer

### Risks and open questions
- Bank sync (Plaid) is the largest scope swing: secrets, webhooks, background jobs, compliance and cost
- Backups must be encrypted; logs must not tie amounts or payees to users
- Free-tier traps: databases that sleep, no PITR
- Mobile load time needs a CDN or static hosting; is PWA or offline in scope?
- Who receives alerts, and on what channel? Set billing alarms.

## Owner decisions (2026-11-12)
| Decision | Choice |
|---|---|
| Monthly budget | **$0, hard constraint** |
| Card on file | **Acceptable, with hard spending caps and billing alerts** that the owner applies from sre's instructions |
| Cold starts | **Must stay quick** (a few seconds at most). Rules out free tiers that sleep for a long time. Candidate: a scale-to-zero platform with short cold starts (e.g. Google Cloud Run) plus a free Postgres that doesn't pause for long. sre checks current free-tier terms and reports if nothing fits. |
| Beta size | **Under 10 users** |
| Domain | Owner's existing custom domain: app on `shoestring.<domain>`, email from a sending subdomain; the owner applies the DNS records |
| Region | US |
| Staging | None. Local + production, with a tested rollback. |
| Backups | **RPO 24 hours**: nightly encrypted dumps (free scheduler and storage) plus any free restore window; expire after 35 days |
| Alerts | **Email and phone push** |

## Agreed tasks (approved as listed)
1. Hosting proposal ADR (with the architect): a free host with short cold starts plus free Postgres, US region, frontend and API on the same origin under `shoestring.<domain>`, exact DNS records for the app and email
2. Billing protection guide for the owner: hard caps, budget alerts, quotas
3. Environments: local + production only; a one-command rollback
4. Deploy config: health and readiness checks, migrations before release, limits, platform rate limit, secrets in the platform store
5. Backups: nightly encrypted `pg_dump` to free storage (e.g. a scheduled GitHub Action), 35-day expiry, a restore drill before launch
6. A free scheduled job for the 30-day deletion purge
7. Monitoring: Sentry free tier, a free uptime check, two alerts (down, error spike) sent by email and push
8. Runbooks: deploy, rollback, restore, rotate a secret, one per alert, a breach-response outline
9. Cost sheet confirming $0 and listing free-tier limits to watch
10. Exact first-deploy commands for the owner to run

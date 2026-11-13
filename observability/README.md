# Observability: Shoestring production
Owner: sre. Status: **DRAFT, configured by the owner during bootstrap** (docs/runbooks/bootstrap-production.md step 13). Everything here is free tier. Settings are click-paths because none of these tools is managed as code yet. Record each change here.

## Principles
- Alert on what users feel (site down, error spike) and on the things that silently break recovery (backups, purge, billing, email quota). Every alert has a runbook. An alert nobody acts on gets deleted.
- No financial data, emails, tokens or IPs in logs or Sentry (ARCHITECTURE.md "Request IDs and logging", F-07).
- Push to the phone comes from the **Sentry** and **Better Stack** mobile apps (owner decision). GCP budget alerts arrive by email (Gmail push).

## Alert catalogue
| # | Alert | Source | Condition | Channel | Runbook |
|---|---|---|---|---|---|
| A1 | **Site down** | Better Stack monitor `shoestring-healthz` | `GET https://shoestring.<domain>/api/healthz` is not 200 within 10 s, from 2 regions, confirmed for 2 checks (5-min interval) | email + Better Stack push | docs/runbooks/site-down.md |
| A2 | **Error spike** | Sentry issue alert `error-spike` (both projects) | An issue is seen more than 10 times in 10 minutes in `production`, **or** a new issue appears in `production` | email + Sentry push | docs/runbooks/error-spike.md |
| A3 | **Purge failed or missed** | Sentry cron monitor `purge` | Schedule `0 8 * * *` UTC, check-in margin 60 min, max runtime 15 min; alert on a missed or failed check-in | email + Sentry push | docs/runbooks/purge-failed.md |
| A4 | **Backup missed or failed** | Better Stack heartbeat `shoestring-backup` | No ping for 24 h + 2 h grace, or a `/fail` ping | email + Better Stack push | docs/runbooks/backup-missed.md |
| A5 | **Billing** | GCP budgets `shoestring-prod-1usd`, `shoestring-backup-1usd` | Actual $0.01 / $0.50 / $1.00, forecast $1.00; the spend cap reached | email | docs/runbooks/billing-alert.md |
| A6 | **Email quota** (F-09) | Sentry issue alert `email-quota` | The email adapter sends a `warning` event with fingerprint `email-quota-threshold` when the day's sends reach 80% of `EMAIL_DAILY_QUOTA` (80 of Resend's 100/day), and an `error` event at 100% | email + Sentry push | docs/runbooks/email-quota.md |
A3 and A6 need backend support (cross-area requests in the sre report).

## Sentry (Developer free plan)
**Projects:** `shoestring-api` (Node) and `shoestring-web` (browser), organization region **US**.

**Organization → Settings → Security & Privacy** (F-07):
- **Require Data Scrubber:** on
- **Require Using Default Scrubbers:** on
- **Prevent Storing of IP Addresses:** on
- **Global Sensitive Fields:** `token`, `password`, `code`, `email`, `payee`, `memo`, `amount`, `cookie`, `authorization`, `x-csrf-token`, `session`
- **Global Safe Fields:** none
- **Require Two-Factor Authentication** for org members: on (F-03)

**Each project → Settings → Security & Privacy**: the same fields (inherited from the org; confirm they show as enforced).
**Each project → Settings → General:** "Data scraping of source code" off. Source maps are uploaded privately by CI as artifacts and never served publicly (ci-engineer).
**Each project → Client Keys:** one DSN per project. Rate limit 100 events per minute (spike protection inside the free 5,000/month).
**Org → Settings → Subscription:** pay-as-you-go / on-demand budget **$0**. **Spike Protection:** on.
**Not used:** Performance/tracing (`tracesSampleRate: 0`), Session Replay, Profiling, User Feedback.

SDK settings the code must use (backend and frontend own them; listed so the settings above and the code agree): `sendDefaultPii: false`; DOM and console breadcrumbs off; fetch breadcrumbs keep the path only; `beforeSend` and `beforeBreadcrumb` strip `#…` and `?…` from every URL (F-06); no request headers, cookies or bodies; tags are only `requestId`, opaque `userId`, route template and `release`.

**Alert rules** (Project → Alerts → Create alert → Issues):
- `error-spike`: environment `production`. When "the issue is seen more than 10 times in 10 minutes" OR "a new issue is created" → send a notification to **Member: owner** (email + mobile push). Action interval 30 minutes.
- `email-quota`: environment `production`, filter "the event's fingerprint equals `email-quota-threshold`" (or message contains `email_quota_threshold`) → notify owner. Action interval 6 hours.

**Cron monitor** (Crons → Add monitor): slug `purge`, crontab `0 8 * * *`, timezone UTC, check-in margin 60 min, max runtime 15 min, failure tolerance 1. Notify the owner. The free plan is believed to include 1 monitor (V18).

**Mobile push:** install the Sentry mobile app (verify availability on iOS/Android, V18). Sign in and allow notifications. Then User Settings → Notifications → Alerts: on for email and push.

## Better Stack Uptime (free plan)
- **Monitor `shoestring-healthz`:** URL `https://shoestring.<domain>/api/healthz`, type "Status 200", check every **5 minutes** (or 3 if the free plan allows; the cost sheet assumes 5), request timeout 10 s, confirmation period 2 checks, regions: 2 US. "SSL/domain expiry" monitoring on if the free plan includes it. Escalation: email + push to the owner.
  - The monitor hits `/healthz`, which **does not touch the database**, so it never wakes Neon. Pings also keep a Cloud Run instance warm at no cost.
- **Heartbeat `shoestring-backup`:** period 24 h, grace 2 h. The URL is set as the plain env var `BACKUP_HEARTBEAT_URL` on the Cloud Run job `shoestring-backup` (bootstrap-production.md step 12g). deploy/backup/backup.sh pings it on success and `/fail` on failure.
- **Mobile push:** install the Better Stack app, sign in, allow notifications, then on-call settings → notify via push and email.
- A status page is not needed.

## Cloud Logging and metrics (GCP)
- `_Default` bucket: 30-day retention. Exclusions: `exclude-run-request-logs` (`LOG_ID("run.googleapis.com/requests")`) and `exclude-debug` (docs/runbooks/billing-protection.md §6).
- **Why exclude the request logs:** Cloud Run's platform request logs contain client IP, user agent and full URL, all forbidden by the logging policy. The app writes its own JSON line per request (route template, status, latency, requestId, opaque userId).
  - Alternative if security-reviewer prefers it: route them to a separate bucket with 1-day retention instead of excluding them.
- **Viewing:** Logs Explorer `resource.type="cloud_run_revision" resource.labels.service_name="shoestring" jsonPayload.requestId="<id>"` follows one request. Jobs: `resource.type="cloud_run_job"`.
- **Metrics:** Cloud Run console → `shoestring` → Metrics (request count by response class, latency p50/p95/p99, instance count, billable instance time). There are no alert policies, because their pricing is unverified (V22).

## SLO
"Record a transaction succeeds" 99.5% over 30 days (ARCHITECTURE.md). At $0 there is no burn-rate alerting. A2 is the symptom alert. Monthly, compute from logs: `POST /api/budgets/{budgetId}/transactions` with status < 500 divided by all such requests, using the Logs Explorer query `jsonPayload.route="/api/budgets/:budgetId/transactions" jsonPayload.method="POST"` (route field name pending backend). Record it in docs/runbooks/billing-protection.md's monthly log.

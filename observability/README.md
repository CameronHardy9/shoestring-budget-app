# Observability: Shoestring production
Owner: sre. Status: **DRAFT, configured by the owner during bootstrap** (docs/runbooks/bootstrap-production.md step 13). Everything here is free tier. Settings are click-paths because none of these tools is managed as code yet. Record each change here.

## Principles
- Alert on what users feel (site down, error spike) and on the things that silently break recovery (backups, purge, billing, email quota). Every alert has a runbook. An alert nobody acts on gets deleted.
- No financial data, emails, tokens or IPs in logs or Sentry (ARCHITECTURE.md "Request IDs and logging", F-07).
- Push to the phone comes from the **Better Stack** mobile app (A1, A4) and from **Gmail push** for email alerts: Sentry (A2, A3, A6) and GCP budgets (A5).
  - Sentry's free plan alerts by email only, and its mobile app is unmaintained (checked 2026-11-16, bootstrap-production.md step 13A).
  - Owner ruling (2026-11-16): Gmail push for A2, A3 and A6, with no Better Stack heartbeat for purge.

## Alert catalogue
| # | Alert | Source | Condition | Channel | Runbook |
|---|---|---|---|---|---|
| A1 | **Site down** | Better Stack monitor `shoestring-healthz` | `GET https://shoestring.<domain>/api/healthz` is not 200 within 10 s, from 2 regions, confirmed for 2 checks (5-min interval) | email + Better Stack push | docs/runbooks/site-down.md |
| A2 | **Error spike** | Sentry alerts `error-new` and `error-spike` (both projects) | In `production`, an error issue is new, regresses or escalates (`error-new`), **or** an issue gets more than 10 events in 15 minutes (`error-spike`) | email (Gmail push) | docs/runbooks/error-spike.md |
| A3 | **Purge failed or missed** | Sentry cron monitor `purge` + alert `purge-cron` | Schedule `0 8 * * *` UTC, check-in margin 60 min, max runtime 15 min, failure tolerance 1; alert on a missed, timed-out or failed check-in | email (Gmail push) | docs/runbooks/purge-failed.md |
| A4 | **Backup missed or failed** | Better Stack heartbeat `shoestring-backup` | No ping for 24 h + 2 h grace, or a `/fail` ping | email + Better Stack push | docs/runbooks/backup-missed.md |
| A5 | **Billing** | GCP budgets `shoestring-prod-1usd`, `shoestring-backup-1usd` | Actual $0.01 / $0.50 / $1.00, forecast $1.00; the spend cap reached | email | docs/runbooks/billing-alert.md |
| A6 | **Email quota** (F-09) | Sentry alerts `email-quota-warning` and `email-quota-exhausted` | The email adapter sends a `warning` event when the day's sends reach 60% of `EMAIL_DAILY_QUOTA` (60 of Resend's 100/day), the cutoff where non-priority mail such as password resets and budget invitations stops, and an `error` event at 100% (F-60, owner ruling 2026-11-17). Both use fingerprint `email-quota-threshold`, and their fixed message starts with `email_quota_threshold:`. | email (Gmail push) | docs/runbooks/email-quota.md |
A3 and A6 need backend support (cross-area requests in the sre report).

## Sentry (Developer free plan)
The owner sets this up in docs/runbooks/bootstrap-production.md **step 11b** (account, projects, privacy, keys) and **step 13** (alerts, cron monitor, push). The exact click paths live there. This section records what is configured and why.

**Plan check (V18, 2026-11-16).** Sources: sentry.io/pricing; docs.sentry.io/pricing, …/pricing/quotas/manage-cron-monitors, …/pricing/quotas/spike-protection, …/pricing/quotas/manage-event-stream-guide.
| Item | Developer (free) plan | Our need | Fits? |
|---|---|---|---|
| Users | 1 | the owner only | yes |
| Errors | 5,000 / month; over that, events are dropped (never billed: Developer has no pay-as-you-go) | < 200 / month expected | yes |
| Cron monitors | 1 (more need a pay-as-you-go budget, paid plans only) | 1 (`purge`) | yes, exactly |
| Alerts | Issue alerts with email notification. Slack, webhooks and other integrations: Team plan. "Additional alert types": Team plan (V39). Metric monitors: 20 (unused). | 5 issue alert rules, email | yes (frequency filter: V39) |
| Spike Protection | Per project, by Owner/Manager/Billing. Inactive during the trial. | on | yes (V38) |
| Per-key (DSN) rate limit | **Business plan only** | not used (owner ruling 2026-11-16: spike protection only) | n/a |
| Inbound filters | localhost, browser extensions, legacy browsers, crawlers, IPs. Release and error-message filters: Business plan. | the four toggles | yes |
| Data scrubbing, "Prevent storing IP", advanced scrubbing rules | included ("Manage PII") | F-07 settings | yes |
| Lookback | 30 days | | yes |
| Trial | New orgs start a 14-day Business trial and then drop to Developer without a card | | Don't configure Business-only features (V41) |
| Cost | **$0**: there is no card and no pay-as-you-go budget, so Sentry cannot bill | | yes |

**Projects:** `shoestring-api` (Node; also receives CSP reports) and `shoestring-web` (Browser JavaScript). Organization data region **US**.

**Org → Settings → Security & Privacy** (F-07):
- **Require Data Scrubber:** on
- **Require Using Default Scrubbers:** on
- **Prevent Storing of IP Addresses:** on
- **Global Sensitive Fields:** `token`, `password`, `code`, `email`, `payee`, `memo`, `amount`, `cookie`, `authorization`, `x-csrf-token`, `session`. ARCHITECTURE requires the first six; the rest are sre additions. Each word removes matching keys **and any value containing the word** in Sentry's PII fields (extra, user, request query, headers and cookies, breadcrumbs, frame variables). Messages, exception values, tags and contexts are **not** PII fields.
- **Global Safe Fields:** none
- **Advanced Data Scrubbing:**
  - Remove Anything from `$user.geo.**`. Sentry derives geo from the IP even with IP storage off.
  - Replace Email Addresses in `**`.
  - Replace Email Addresses and IP Addresses in `$error.value || $message`.

**Org → Settings → General:** Require Two-Factor Authentication on (F-03), Enhanced Privacy on, Allow Shared Issues off, JavaScript source fetching off, join requests off.

**Each project:**
- Inbound Filters: localhost, browser extensions, legacy browsers, web crawlers.
- `shoestring-web` Allowed Domains: `shoestring.<domain>`.
- `shoestring-api` Security Headers: default ignored sources on.
- One default client key (DSN).
- Source maps are uploaded privately by CI with an organization token (`org:ci` scope) and never served publicly (ci-engineer; deploy.md smoke check 3).

**Not used:** Performance/tracing (`tracesSampleRate: 0`), Session Replay, Profiling, User Feedback, Logs, Uptime monitors (Better Stack does A1), Seer.

**Volume backstops.** Owner ruling 2026-11-16: spike protection only, with no per-key rate limit (the free plan lacks it) and no SDK-side cap.
1. Spike Protection drops bursts.
2. The 5,000/month quota is a hard ceiling that can't bill. The cost of hitting it is blindness until the 1st, not money.
3. The rollback (error-spike.md step 5) stops the source.
4. Monthly usage check: billing-protection.md §11 row 12.

SDK settings the code must use (backend and frontend own them; listed so the settings above and the code agree):
- `sendDefaultPii: false`; `environment: "production"` in production.
- DOM and console breadcrumbs off; fetch breadcrumbs keep the path only.
- `beforeSend` and `beforeBreadcrumb` strip `#…` and `?…` from every URL (F-06).
- No request headers, cookies or bodies.
- Tags are only `requestId`, opaque `userId`, route template and `release`.
- Fields that must survive scrubbing must not sit in a PII field under a key or value containing a sensitive word. For example, `extra.code` would show as `[Filtered]`. The backend puts SQLSTATE `code=…` in the exception value, which is not a PII field, so it survives.

**Alert rules** (Monitors → Alerts; full table in bootstrap-production.md step 13C). All are environment `production` and notify **Member: owner** by email.
- `error-new` (A2): error issue new, regressed or escalating. Throttle 30 min.
- `error-spike` (A2): more than 10 events in 15 min on one error issue. Throttle 30 min. Sentry offers no 10-minute window.
- `purge-cron` (A3): source = monitor `purge`. Every trigger.
- `email-quota-warning` (A6, 60%): message contains `email_quota_threshold` (underscores; the fingerprint uses hyphens), level `warning`. Throttle 12 h.
- `email-quota-exhausted` (A6, 100%): same message match, level ≥ `error`. Throttle 12 h. Neither rule matches the percentage, so the F-60 move from 80% to 60% needed no rule change.

**Cron monitor:** slug `purge`, project `shoestring-api`, crontab `0 8 * * *` UTC, check-in margin 60 min, max runtime 15 min, failure tolerance 1, recovery tolerance 1, owner = the owner. If the backend's SDK upserts the monitor config, it must send these same values.

**Push:** Gmail filter on Sentry's sender → label `Shoestring alerts`, never spam, always important; Gmail app notifications on (step 13A).

**Checks:**
- The canary (docs/runbooks/sentry-data-check.md step 2) after any settings or SDK change.
- The smoke check after every deploy (deploy.md).

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

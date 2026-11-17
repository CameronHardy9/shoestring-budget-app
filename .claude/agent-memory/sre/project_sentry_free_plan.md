---
name: sentry-free-plan
description: Sentry Developer (free) plan facts, alert-builder pitfalls, and 2026-11-17 bootstrap lessons (UI-only org token, per-project spike action, GitHub env auto-create, CLI scopes)
metadata:
  type: project
---

Checked 2026-11-16 (sentry.io/pricing, docs.sentry.io/pricing, quotas docs). Recorded as V18 in infra/hosting-evaluation.md.
- Developer plan: 1 user, 5k errors/month, **exactly 1 cron monitor**, 30-day lookback, email-only alerts. There is no pay-as-you-go, so it can't bill. New orgs get a **14-day Business trial** first, with Spike Protection inactive during it.
- **Per-key (DSN) rate limits, release/message inbound filters and Delete & Discard are Business-only.** Owner ruling 2026-11-16: spike protection only, with no per-key limit and no SDK-side cap.
- **The Sentry mobile app is unmaintained** (getsentry/sentry-mobile-release-health-app) and not in the US App Store, and Slack/webhooks are Team+. So Sentry "push" goes through Gmail filter plus Gmail app notifications. The owner accepted Gmail push for A2/A3/A6 on 2026-11-16, with no Better Stack heartbeat for purge.
- Alert builder ("Monitors → Alerts", new UI):
  - frequency windows 5m/15m/1h/1d/1w/30d (no 10m)
  - throttle options lack 6h
  - fingerprint is not filterable
  - event-attribute filters only work with the "new issue" and "event captured" triggers
- Additional Sensitive Fields also remove any **value containing** the word, but only in PII fields (extra, user, request, breadcrumbs, frame vars). Messages, exception values, tags and contexts are not PII fields. Geo is derived from the IP even with IP storage off, so it needs an advanced rule to remove `$user.geo.**`.
- You can't delete a single event: delete the issue, delete the tag key, or recreate the project.
- The source-map token is an org token stored on GitHub environment `sentry` (main only).
- Backend A6 message text uses **underscores** (`email_quota_threshold: …`) while the fingerprint uses hyphens (`email-quota-threshold`). Alert filters must match the underscore form.

Bootstrap run 2026-11-17 (org slug `cameron-hardy`, trial ends 2026-12-01; details in bootstrap-production.md Record table):
- Sentry **refuses API-created org auth tokens even with OAuth `org:admin`**: S6 is browser-only.
- Spike Protection needs **one notification action per project**; one action across both projects is rejected.
- GitHub **auto-creates a missing environment with no branch policy** when a workflow first references it. Create `sentry` + main-only policy before any workflow uses it.
- Owner's Mac has the new Sentry CLI (`~/.local/bin/sentry`, `sentry api` like `gh api`), narrowed scopes, login expires ~2026-12-15. It lacks `event:admin` (can't delete issues) and `org:write`.
- F-60 (owner ruling 2026-11-17): A6 warning moved 80% → 60%; alert rules match prefix + level only, so no rule change.

**Why:** these decided the step 11b/13 runbook shape and are easy to get wrong from memory of older Sentry UIs.
**How to apply:** re-check pricing quarterly (billing-protection.md §11 row 14). Never configure trial-only features. Never create a second cron monitor. Run deploy/scripts/sentry-canary.sh after any Sentry settings or SDK change.
Related: [[owner-constraints]], [[project-hosting-proposal]]

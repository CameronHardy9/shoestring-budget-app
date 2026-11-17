# Alert A6: email quota (F-09)
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending the backend's quota events**
- Source: Sentry alert rules `email-quota-warning` and `email-quota-exhausted` (project `shoestring-api`, environment `production`; bootstrap-production.md step 13C; observability/README.md).
- Delivery: email; phone notification through the Gmail label `Shoestring alerts`.

## What the app sends (backend contract this runbook relies on)
| Day's sends (UTC day) | Sentry event | Level | Fingerprint | Alert |
|---|---|---|---|---|
| reach **60%** of `EMAIL_DAILY_QUOTA` (60 of Resend free's 100) | `email_quota_threshold: 60% of EMAIL_DAILY_QUOTA used today` | `warning` | `email-quota-threshold` | `email-quota-warning` |
| reach **100%** (all mail now stops) | `email_quota_threshold: 100% of EMAIL_DAILY_QUOTA used today` | `error` | `email-quota-threshold` | `email-quota-exhausted` |
- **Grouping.** Both levels share one fingerprint, so they group into **one Sentry issue**. The two alerts filter on the level, so each fires on its own.
- **Message matching.** The alerts match the message prefix `email_quota_threshold` (underscores). The hyphenated `email-quota-threshold` is the fingerprint, which only groups the events.
- **Event contents.** Each event carries the fixed text only (backend `ALERTS`), never an address, a recipient or a message kind tied to a person.
- **Repeats.** Each level is sent **at most once per UTC day across all instances and jobs**: the backend's one-shot reservation in the database.
- **The warning marks the cutoff** (F-60, owner ruling 2026-11-17). From **60%** the app sends only **priority** mail and silently drops the rest (auth.md §14 and §15). Priority mail is the security notices plus `signup_invite` (the owner's `create-signup-invite`) and nothing else. **`password_reset`, `budget_invitation` and the email-change confirmations are not priority**, so they have already stopped by the time the warning arrives.
- **Alert rules didn't change with the threshold.** Both rules match the `email_quota_threshold` prefix and the level only (bootstrap-production.md step 13C).

## When to use
- **`email-quota-warning`:** 60% used. **Password resets, budget invitations and email-change confirmations are no longer sent today** (silently: users see the normal response). Security notices and signup invites still go out until 100%.
- **`email-quota-exhausted`:** 100% used. **No email goes out until 00:00 UTC**: no password resets, invites or security notices.

Email is the **only recovery channel**, so exhaustion blocks account recovery. Resend free is believed to allow 100 a day and 3,000 a month (V20).

## Steps
1. **Real use or abuse?** Normal is fewer than 10 emails a day. Check Resend → **Logs** for the pattern. Many resets to the same few addresses means reset bombing (F-09). Don't copy addresses out of the dashboard.
2. **Check the app is protecting itself.** App logs show dropped sends with counts only:
   ```sh
   export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
   gcloud logging read 'resource.labels.service_name="shoestring" AND jsonPayload.outcome="dropped"' \
     --project "$PROJECT" --freshness 1d --format 'value(timestamp,jsonPayload.kind)' | sort | uniq -c | tail
   ```
3. **Check the Sentry event is clean:** run docs/runbooks/sentry-data-check.md step 1 on the latest `email_quota_threshold` event. It must hold no email address and no recipient.
4. **If it's abuse:**
   - Tell the tech lead. Look for a flood in Cloud Run metrics.
   - Ask about the Cloudflare fallback (hosting-evaluation.md §3a). It is switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13).
   - The quota resets at 00:00 UTC. Avoid sending invites until then.
5. **If Resend suspends or blocks the account** (complaints or bounces):
   - Follow Resend's support steps.
   - The fallback provider is Brevo. It needs a new API key, new DNS records on Cloudflare and an `EMAIL_*` config change. Do it through the tech lead.
6. If real users missed an email (an invite or reset), tell them to retry after 00:00 UTC, or re-send the invite (admin-commands.md).
7. **Leave the Sentry issue unresolved: don't Resolve it and don't Archive it.**
   - If you resolve it, the next day's event counts as a regression and also sends an `error-new` email (error-spike.md).
   - If you archive it, Sentry may stop alerting on it altogether (V39).

## Verify
- The next UTC day's sends are back to normal: Resend → Logs, or step 2 shows no `dropped` lines.
- No new `email_quota_threshold` events arrive (Sentry → the issue → events chart).

## Back out
Nothing to back out. If you switched providers temporarily, switch back following the same change process.

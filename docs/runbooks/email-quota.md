# Alert A6: email quota (F-09)
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending the backend's daily send counter** · Source: Sentry issue alert `email-quota` (observability/README.md)

## When to use
Sentry reports `email-quota-threshold`: the app has sent 80% of the daily quota (warning) or 100% (error). Resend free is believed to allow 100 emails a day (V20). Email is the **only recovery channel** (password reset, invites, security notices), so exhaustion blocks account recovery.

## Steps
1. **Is it real use or abuse?** Normal is fewer than 10 emails a day. Resend → **Logs**: look at the pattern (many resets to the same few addresses = reset bombing, F-09). Don't copy addresses out of the dashboard.
2. **Check the app is protecting itself.** Once the global email budget is reached, backend sends only security notices and owner-initiated invites (F-09 design). Sentry and app logs should show suppressed sends with counts only.
3. **If it's abuse:**
   - Tell the tech lead. Look for a flood in Cloud Run metrics and ask about the Cloudflare fallback (hosting-evaluation.md §3a), which is switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13).
   - The quota resets daily. Avoid sending invites until then.
4. **If Resend suspends or blocks the account** (complaints or bounces): follow Resend's support steps. The fallback provider is Brevo, which needs a new API key, new DNS records on Cloudflare and an EMAIL_* config change. Do it through the tech lead.
5. If real users missed an email (an invite or reset), tell them to retry tomorrow, or re-send the invite (admin-commands.md).

## Verify
The next day's sends are back to normal, and no new `email-quota` events arrive.

## Back out
Nothing to back out. If you switched providers temporarily, switch back following the same change process.

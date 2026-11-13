---
name: project-review-hotspots
description: Recurring weakness patterns found in Shoestring's design; check these first in every implementation diff so reviews go deeper, not wider
metadata:
  type: project
---
Patterns found in the 2026-11-12 and 2026-11-13 contract reviews that tend to come back in code:

1. **Token lifecycle on revocation.**
   - Revocation events must kill open `user_tokens`.
   - Email-change confirm needs the user's own session.
   - Re-review: **cancel tokens form a chain**. Using a later cancel token must never delete an earlier one (F-33, High). Check every "delete other tokens" statement for this ordering.
2. **De-noising rules that the attacker controls.**
   - Anything keyed on User-Agent-derived values (browser/OS vocabulary) can be spoofed. The new-sign-in "skip same device" rule silenced the main R-1 control (F-34).
   - I had suggested that de-noising myself, so don't propose noise filters on detective controls again.
3. **Public repo means public logs.**
   - Admin commands now run only as Cloud Run jobs.
   - The nightly backup still runs in GitHub Actions with a read-all DB credential (F-17 residual). Watch that workflow for third-party actions or npm.
4. **Error paths bypass redaction.** Postgres `detail` carries row values; Sentry breadcrumbs, URL fragments and IPs leak too. Look at error serializers and Sentry init (F-06, F-07).
5. **Proxy trust.** `trustProxy` is the hop count (1 for Cloud Run domain mapping, pending V26), never `true`. The Cloudflare fallback needs my sign-off (F-08).
6. **Test hooks.**
   - Dev entry only (ADR-0009).
   - The dist grep must match `_test` or a sentinel, not just `/_test/` (F-10).
7. **Routes outside BudgetScope.** Deleted-budget routes use `{deletedBudgetId}` and `x-budget-role: none`; they need their own branded scope (F-36). Any new route that escapes the `{budgetId}` startup check deserves the same scrutiny.
8. **Free-tier quotas and Cloud Run CPU throttling.**
   - Email budget of 60 per day, argon2 memory, denial of wallet.
   - Work after the response is unreliable on Cloud Run, so inline sends with timeouts are the accepted pattern (F-22 deviation).

9. **Ops/IAM isolation claims (ops review 2026-11-13).**
   - "No actAs" does not isolate a Cloud Run job: project-level `run.developer` can still get, delete and execute-with-overrides it (F-39). Check resource-scoped bindings.
   - Restores need a provenance check on the chosen object.
   - Operator steps that pipe keys through `pbcopy` leak via Universal Clipboard (F-40).
   - F-03-style operator-MFA checklists must include the passkey-sync account (Apple ID / iCloud Keychain).

**Why:** these were the non-obvious gaps that passed the architect's own review, including regressions introduced by fixes. **How to apply:** grep each diff for these spots before running the general checklist. Mark the F-number verified in FINDINGS.md when its regression test exists. When a fix adds a new token type or exemption, look for a chaining or ordering attack.

Related: [[project-security-rulings]]

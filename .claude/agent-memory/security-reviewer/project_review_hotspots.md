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

10. **Code-level boundary bypasses (first code review, data layer 2026-11-13).**
    - Brands plus a runtime registry are only as strong as their constructors. Grep for any *exported* function that mints a scope (F-41: `issueBudgetScope`). A registered scope passes both the type checker and the WeakSet.
    - The package `exports` map does not stop relative imports (`../../db/src/...`). Semgrep must ban specifiers into `db/(src|dist)/` and all `kysely` imports outside db/, not just `{ sql }`.
    - "Local host only" URL guards that check `new URL().hostname` can be bypassed with `?host=` (pg-connection-string and lib/pq both honor it; verified). Require the driver's own parser (F-42).
    - Dev-only CLIs (seed, testing) ship in the prod image when `package.json` `files` includes `src`/`dist` and the backend uses `pnpm deploy`. Every such CLI needs its own environment guard (F-43).
    - Postgres PUBLIC keeps database `TEMPORARY`/`CONNECT` unless revoked. "No DDL" checks must test `create temp table` (F-44).
    - Deferred FKs move failures to COMMIT. Check that the backend error serializer handles commit-time SQLSTATEs (F-07).

11. **Backend code review (2026-11-14, `feat/backend-api`).**
    - **Check-then-record limits race.** `assertUnder`/`rollingCount` before the work and `hit` after it lets a parallel burst through, and the DB pool's FIFO queue makes that reliable. It mattered for MFA (F-45). Race-free only: atomic `hitOrThrow` upserts, or `UPDATE … WHERE n < limit RETURNING`. Grep every new limit for this order.
    - In-memory maps keyed by client data (IP /64s) need eviction by window end and a hard cap (F-46).
    - `pnpm deploy` copies the whole package unless `files` is set or the Dockerfile allowlists `/out`. "Physically absent" claims must be checked on the image, not on `dist` (F-47).
    - Plain-text defanging must cover Unicode dot equivalents (U+3002, U+FF0E) and bidi controls (F-48).
    - Lock-order questions: read the *other* path's first lock. `acceptInvitation` is safe because the owner's deletion request locks every owned budget row first.

    - **READ COMMITTED plus `FOR UPDATE OF b`:** after a lock wait, Postgres re-checks only the locked row. Joined columns (for example `u.status`) keep the statement's old snapshot. Any status rule must be re-read in a statement issued *after* the lock (F-49).
    - The local `image-smoke` reuses `<sha>-dirty` image tags, so check the image's build time before trusting a local smoke run.
**Why:** these were the non-obvious gaps that passed the architect's own review, including regressions introduced by fixes. **How to apply:** grep each diff for these spots before running the general checklist. Mark the F-number verified in FINDINGS.md when its regression test exists. When a fix adds a new token type or exemption, look for a chaining or ordering attack.

Related: [[project-security-rulings]]

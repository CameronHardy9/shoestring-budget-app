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
12. **Frontend code review (2026-11-14, `feat/frontend`).**
    - **"Imported first" is not "runs first" in a bundle.** Rolldown has no strict execution order: shared chunks imported by the entry evaluate before the entry's own top-level code. Verify ordering claims in the built `assets/index-*.js`, not in the source (F-50). Re-check this when Sentry lands.
    - Swallowed `catch {}` around security-relevant requests (logout) turns a failure into a false "done" (F-51). Grep `catch {` in auth flows.
    - `no-restricted-globals` doesn't see `window.x`. Storage bans need `no-restricted-properties` too (F-52).
    - Smoke and header tests that probe only `/api/healthz` miss the HTML document, where the CSP matters (F-53). Probe the image by hand: run it with a bogus `DATABASE_URL`; the server starts and serves static files.
    - In-memory state that survives re-login (draft stash, return path) must be bound to the user ID (F-54).

13. **Test-suite review (2026-11-16, `feat/test-suite`). Judging whether a test proves its claim.**
    - **Per-document collectors.** `addInitScript` arrays (`window.__x`) reset on every navigation. A teardown check reads only the last document, so any `page.goto` mid-test drops earlier events (F-55). Collect them Node-side (`exposeBinding`).
    - **Behaviour vs mechanism.** A "Back after sign-out" test can pass on a plain reload. To prove bfcache, assert `pageshow.persisted` (F-32 stays unverified until then). The Vite dev server's HMR socket can make a page ineligible for bfcache.
    - **Gates against the dev server are vacuous.** Vite sends no CSP, so only the csp-prod and visual projects (`tests/scripts/prod-server.mjs`) test the policy. prod-server copies headers from `/api/healthz`, so it proves nothing about what the image serves on `index.html` (F-53).
    - **Single-IP stacks can't test IP-keyed rules** (F-21's (email, IP) key, F-08 XFF). Check before accepting such a claim.
    - **Test env precedence.** In tests/support/env.ts the process env beats `.env.stack`, with no local-only guard on DB URLs (F-56). HTTP paths fail closed through the `_test/reset` = 204 probe; direct DB connections don't.
    - Read test names against their bodies: "single-use challenge" tested cross-session binding instead.

14. **Hardening review (2026-11-16).**
    - **One-shot notices keyed on `=== N` over a non-atomic sum** (`rollingHit` is upsert then sum) are skipped when two hits interleave, and the attacker controls that concurrency (F-58). The right pattern is a dedicated `reserve(noticeKey)` with `count === 1`, as for `mfa:locked_notice`. Grep for `=== LIMIT` near rolling counters.
    - Every new limit: grep for `count`/`rollingCount`/`assertUnder` followed later by `hit`. Read-only pre-checks are fine only when a reservation enforces the limit afterwards (F-57).
    - Test proxies that honour a spoof header (`X-E2E-Client-IP`) are fine only if they are confined to test compose and dockerignored paths. Verify against .dockerignore and the Dockerfile COPY lines each time.

15. **Sentry review (2026-11-17, `feat/sentry`).**
    - **"Rebuilt in beforeSend" isn't the whole wire.** The SDK adds things *after* `beforeSend`: `_enhanceEventWithSdkInfo` merges `sdk.settings` (`infer_ip`), integrations and packages, plus envelope headers. Check the SDK source in node_modules/.pnpm and the e2e envelope test, not just the scrub function.
    - **Stack frames are parsed from `error.stack`, which starts with the message.** Multi-line messages can produce fake frames on both sides (F-59). Any allowlist that keeps frames needs bounded `filename`/`function` charsets.
    - **Alert thresholds vs cutoffs.** If a detective alert sits above a cutoff that the attacker's traffic can't cross (non-priority mail stops at 60%, alert at 80%), the alert never fires for that attack (F-60). Compare every alert threshold with the limit it is meant to watch.
    - **devDependencies bundled into dist are runtime code** (@sentry/node). Never dismiss their advisories as dev-only (F-61). Check the dist chunk's source map to see what actually ships.

**Why:** these were the non-obvious gaps that passed the architect's own review, including regressions introduced by fixes. **How to apply:** grep each diff for these spots before running the general checklist. Mark the F-number verified in FINDINGS.md when its regression test exists. When a fix adds a new token type or exemption, look for a chaining or ordering attack.

Related: [[project-security-rulings]]

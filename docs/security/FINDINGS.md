# Security findings
Owner: security-reviewer. Threat model: [THREAT_MODEL.md](THREAT_MODEL.md). Checklist: [mvp-security-checklist.md](mvp-security-checklist.md).

**Review 1, 2026-11-12:** MVP contracts, design phase. **Re-review, 2026-11-13:** contract revision 2 (auth.md rev 2, data-model, admin-commands, test-hooks, ADR-0003/0006/0007 revised, ADR-0008/0009/0010 new) and the owner's rulings in mvp-planning/10. No code exists yet.

Locations in the details below refer to the **first-review drafts**; new findings (F-33 onward) cite revision 2. Most findings are owned by the **architect** (contract change first); "Implements" names who builds the fix. Owner-only actions are marked **owner**.

Status values:
- `open`: not addressed, or a new finding
- `partially-fixed`: the contract changed but a gap remains (see note)
- `contract-fixed`: the contract is right; implementation and tests pending
- `verified`: tested in code
- `owner-accepted`: residual risk signed off by the owner, dated in THREAT_MODEL "Open risks"

**Clearance (2026-11-13, third pass):** F-33 and F-34 are fixed in the contract text, so **nothing blocks owner approval of the contracts**.

**Ops review (2026-11-13, sre runbooks and backup job):** cleared to PR **after one one-line edit**: F-03's checklist must add the passkey-sync account (details under "Ops review" below). New Lows F-38 to F-40 can follow.

**Data-layer review (2026-11-13, branch `feat/db-data-layer`):** the first code review. No Critical or High findings, so the branch is **OK to merge**. New: F-41 (Medium) and F-42 to F-44 (Low). F-25, F-26 and F-35 are now verified in code. Details are under "Data-layer review" below.

**Backend review (2026-11-14, branch `feat/backend-api`, commit 9adc728):** no Critical or High findings, so the branch is **OK to merge**. New: F-45 (Medium, fix before launch) and F-46 to F-48 (Low). F-04 is verified; the backend halves of F-07 and F-08 are verified. Details are under "Backend review" below.

**Final pass (2026-11-14, uncommitted tree against 9adc728):** **nothing blocks the PR.** F-45 (the owner ruled: fix it in this PR), F-46, F-47 and F-48 are fixed and verified. F-10 is verified at the image level; the post-deploy probe is still for sre. New Low F-49, the restore race, is **deferred by the owner (2026-11-14)**. Details are under "Final pass" at the end.

**Frontend review (2026-11-14, branch `feat/frontend`, commit 371b77c):** no Critical or High findings, so **nothing blocks the PR**. **CSP style hashes: signed off** (F-23). New Lows F-50 to F-54. PR #6 (throttle refunds) does not weaken F-45. Details are under "Frontend review" at the end.

**Test-suite review (2026-11-16, branch `feat/test-suite`: 52a556a plus the uncommitted Phase B tree):** no Critical or High findings, so **nothing blocks the PR**. Nothing in tests/ can reach production or real data. Now **verified by tests:** F-01, F-18, F-23 (except the SPA-document half, F-53, and the Sentry parts), F-33, F-34 and F-36. Already verified, and now with API-level regression tests: F-45, F-48 and the PR #6 path. **Partly tested, status unchanged:** F-06, F-09, F-21, F-22 and F-32. **Claimed but not tested in tests/:** F-08. New Lows: F-55 (the CSP gate drops violations when a test navigates) and F-56 (the test env has no local-only guard on its database URLs). BUG-1 (GET bodies ignored) is not a security issue. Details are under "Test-suite review" at the end.

**Hardening review (2026-11-16, branch `fix/pre-launch-hardening`, uncommitted tree on 48bbf3c):** no Critical or High findings. **Approve with follow-ups.** Closed: F-51, F-52 and F-54 (verified), F-53 (verified by script review; the PR's CI `image-smoke` job is the proof). Verified by the new integration tests: F-08 (code and tests; the production hop count still waits for V26), F-09 (the app side; the owner alert is sre's), F-21 and F-22. Re-checked from #13: F-32, F-55 and F-56 are verified. New: **F-57** (Medium, fixed and verified in this PR): read-then-increment limits on reset requests, the daily email budget, invitation caps and email-change requests. **F-58** (Low): the login failure counters still check before they increment (overshoot accepted; conversion owner-deferred), and the `login_throttled` notice could be skipped by a concurrent burst. **The notice was fixed and verified in the #14 follow-up.** CodeQL #6 on the e2e edge proxy is Info (test-only), fixed anyway. The e2e `edge` proxy and its `X-E2E-Client-IP` override cannot reach the production image. Details are under "Hardening review" at the end.

**Sentry integration review (2026-11-17, branch `feat/sentry`, uncommitted tree on 9a1cd66):** no Critical or High findings. **Approve; nothing blocks the PR.** I found no path by which financial data, emails, names, tokens, IPs, cookies or request bodies reach Sentry from the server or the browser. Both SDKs rebuild every event from an allowlist, v11 `dataCollection` is all off with `defaultIntegrations: false`, and the browser envelope still carries `sdk.settings.infer_ip: "never"`, because the SDK adds it back after `beforeSend` (e2e asserts it). **All seven `SAFE_MESSAGES` patterns and the contract-code passthrough are signed off.** The dynamic-import pattern keeps the chunk name. Closed: **F-50** (verified in the built `dist/`). Now verified: the Sentry halves of **F-06** and **F-07**, the Sentry parts of **F-23**, and the code of the **F-09** owner alert. New Lows: **F-59** (frame-shaped message lines and unbounded frame text, defence in depth), **F-60** (no owner alert at the 60% cutoff, where password-reset mail stops) and **F-61** (`@sentry/node` is a devDependency that ships as runtime code). Details are under "Sentry integration review" at the end.

**Sentry follow-ups review (2026-11-17, branch `fix/sentry-followups`, uncommitted tree on 704e2cd):** no Critical or High findings. **Approve.** **F-60** and **F-61** are fixed and verified. **F-59** is fixed and verified for every case it named, on both sides. Two narrower residuals remain, so they are filed as **F-62** (Low, defence in depth, not blocking): on the web, a message line that holds `(error: …)` is rewritten by the SDK's parser, so the "came from the message" check misses it; and on both sides, a message shortened after `.stack` was first read leaves a stale header. Either way, at most one identifier-shaped word and two integers get through, and there is still no trigger. Triage of the 4 open CodeQL alerts on main: none is a real issue (#1, #2 and #4 are false positives; #3 is won't-fix). The exact dismissal text is in the section at the end. The sw-register change and the `randomPassword()` test helper add no risk. Details are under "Sentry follow-ups review" at the end.

**PR #20 audit, picomatch GHSA-fc5q-39xc-vjpf (2026-11-17):** a high-severity ReDoS in dev tooling only (vite, vitest, typescript-eslint through tinyglobby and fdir). It is not in any production dependency tree, not bundled, and never fed untrusted patterns, so it is **not exploitable**. **I signed off** on the time-boxed osv-scanner ignore: exact ID, `effectiveUntil = 2026-12-17` (checked against the osv-scanner v2.7.1 source: the advisory fails the gate again on that date, and unknown keys fail the scan), listed in the audit summary, thresholds unchanged. Details are at the end.

**Offline and F-62 review (2026-11-17, branch `fix/offline-and-f62`, uncommitted tree on a55786e):** no Critical or High findings. **Approve; nothing blocks the PR.** **F-62 is verified and closed**, with one documented residual that I accept (no owner decision needed): a header made stale by a post-read cut that lands exactly on a line break. The `(error: …)` handling and Node's `Name [CODE]: message` header add nothing new. The offline change ("online to save") adds no duplicate-write, wrong-budget or wrong-user path, stores nothing on the device, and shows no cached data. New Low **F-63** (web, defence in depth, not blocking): the header line and a multi-line `name` are not in the "from the message" haystack, and the linked-error walk is capped in a way that can skip an error the SDK reports. Details are at the end.

**Pre-deploy pass review (2026-11-17, branch `chore/pre-deploy`, uncommitted tree on 9b1f427):** no Critical or High findings. **Approve; nothing blocks the PR.** **F-43 is closed:** besides the seed guard verified on 2026-11-13, nothing of `db/` is in the app image any more, and the migrate image holds only `dist/cli/migrate.js` and `dist/conn.js`, with no seed. **F-47 stays closed.** I checked both on the built images, not only in the scripts. The migrate image, the smoke's root scans, the migrate-only job config and the public GHCR ruling expose nothing that the public repo doesn't already show: no secret in config, env, labels or layer history; the SPA DSN is build-stage only; the backend `.map` files hold public source and aren't served. `TRUST_PROXY_HOPS=1` on the service is right for F-08, and V26 is still open. New Lows, both runbook edits for sre, recommended in this PR or at least before bootstrap: **F-64** (restore.md takes roles.sql to run as the database owner from an unvalidated `SERVING_SHA`; an empty value silently uses the index copy) and **F-65** (step 14 measures the hop count only on `run.app`, and the domain-mapping path users take is optional). The F-10 post-deploy probe and the F-44 owner-run roles.sql are now in the runbooks. Details are at the end. **Re-check (same day): F-64 is fixed and verified, and F-65 is fixed in the runbook (the measurement waits for V26).**

## Summary
| ID | Sev | Owner → implements | Issue (first review) | Status | Note (re-review 2026-11-13) |
|---|---|---|---|---|---|
| F-01 | **High** | architect → backend, data | Open email-change and reset tokens survive recovery; confirm needed only the token; no cancel path | verified | Revocation deletes tokens, confirm is session-bound, cancel/revert link added; the chain is closed (F-33). Residual R-11 accepted by the owner on 2026-11-13. **Verified 2026-11-16 (tests/):** confirm needs the same user's session and dies with the requesting session; the cancel link reverts; an attacker's password change and revoke-others keep the victim's cancel link; enrolling a factor deletes an open reset token (`f33-email-change.test.ts`, `password-reset-mfa.test.ts`) |
| F-02 | **High** | architect, sre → backend, ci | Admin CLI in public Actions; emails in output; secret sprawl | contract-fixed | Cloud Run jobs only, no emails in output, least config per job. Ops runbook confirms (two-step `--expect-user-id`, no retries, keyring never on `shoestring-admin`, private admin log). Note: the CLI must reject an email containing `,`, because `--args` is comma-joined, or `job_run` should use a custom gcloud delimiter such as `^;^` |
| F-03 | **High** | sre → **owner** | No MFA required on operator accounts | partially-fixed | ADR-0007 constraint 7; bootstrap step 1 checklist is good, but **it omits the account that syncs the passkeys** (Apple ID, iCloud Keychain, or the password manager if it stores them). That account is the root of every "phishing-resistant" factor. **Blocking for the ops PR: add that row** |
| F-04 | Medium | architect → data, backend | Recovery codes as unsalted SHA-256 | verified | HMAC with the `recovery-code-v1` HKDF subkey, constant-time compare. **Verified 2026-11-14:** backend/src/auth/recovery-codes.ts, per-row key ID, every row compared, tests in factors.test.ts |
| F-05 | Medium | architect → backend | MFA failure limits per endpoint | contract-fixed | One per-user budget, 20 per 24 h, across verify, reauth and reset; `mfa_locked` plus email |
| F-06 | Medium | architect → frontend, backend, sre | Fragment tokens leak | verified (app); click tracking: owner bootstrap | `replaceState` before Sentry init, URL stripping, tracking off. **Tests 2026-11-16:** the history half is verified: `location.hash` is empty and the URL holds no token after loading the reset, email-change-undo and invite links (`e2e/sessions.spec.ts`, `j1-onboard.spec.ts`). The Sentry half (`beforeSend` stripping, init order: F-50) waits for Sentry; click tracking off is sre's. **Sentry half verified 2026-11-17 (`feat/sentry`):** the capture is the first module script (F-50); Sentry loads only after `load`; `stripUrl`/`pathOf` cut every URL, and navigation breadcrumbs become route templates. `csp-prod/sentry-no-pii.spec.ts` "F-50" sends errors that quote the token before the SDK loads and finds no token in any envelope. Click and open tracking off is bootstrap step 4 (owner), which can't be tested from the repo |
| F-07 | Medium | architect → backend, frontend, sre | Error paths bypass redaction | contract-fixed | Allowlist serializer with a DB-error fixture test; Sentry SDK and project settings specified. **Backend half verified 2026-11-14** (logging.ts serializer, fixture test, commit-time 23503 test); Sentry init and the frontend are still to come. **Sentry halves verified 2026-11-17 (`feat/sentry`):** the server builds events from `serializeError` (only `code=…`/`constraint=…` values, never the message), `beforeSend` rebuilds every event (uncaught ones too), only 5xx are captured, and there are no breadcrumbs, request data or default integrations (error-tracker.test.ts; build.test.ts checks the wire bytes of the *bundled* SDK). The browser side rebuilds from an allowlist, `SAFE_MESSAGES` is signed off, and DOM and console breadcrumbs are off (scrub.test.ts, plus `sentry-no-pii.spec.ts`, which checks the real envelopes key by key). The project settings are owner bootstrap 11b, checked by the canary. Defence-in-depth gap: F-59 |
| F-08 | Medium | architect, sre → backend | Client-IP derivation | verified (V26 open) | Hop count, never `true`; IPv6 /64. `trustProxy = 1` must be confirmed by V26 before launch. **Backend half verified 2026-11-14** (hop-count trust function, `TRUST_PROXY_HOPS` required in production, forged-XFF test). **Tests 2026-11-16:** nothing in tests/ exercises proxy trust; every request comes from one loopback IP. The claimed partial coverage is limited to the per-IP limits themselves. **Verified 2026-11-16 (hardening, tests/):** the e2e stack now trusts one hop, an `edge` proxy that appends the client address (`f08-client-ip.test.ts`). Forged leftmost `X-Forwarded-For` entries change neither the login bucket, nor the in-memory global limit, nor `security_events.ip` (IPv4 and IPv6); IPv6 keys on the /64. **Launch gate still open:** V26 must confirm that Cloud Run appends exactly one entry, so that `TRUST_PROXY_HOPS=1` is right in production. **Pre-deploy pass 2026-11-17:** bootstrap step 12b sets `TRUST_PROXY_HOPS=1` on the service (config accepts 0–5 and refuses below 1 in production; `app.ts` trusts `hop < n`). The backend never reads `request.hostname`, `protocol` or `ips`, so trusting the proxy doesn't make forwarded Host or Proto spoofable. Step 14 escalates a value other than 1 to me and changes it through a gated revision. **Gap F-65:** the domain-mapping path must be measured too, and must match |
| F-09 | Medium | architect → backend, sre | Email quota exhaustion | verified (app; alert: sre) | 5 per 24 h per email, 60 per day app budget, priority mail, alert. Deviation 4 accepted. **Tests 2026-11-16:** the app budget is verified (past 60% only priority mail goes out, and nothing goes out at the quota: `notification-emails.test.ts`). Not yet tested: the silent per-address reset limits (3 per hour, 5 per 24 h) and the owner alert. Flip to verified when those are tested. **Verified 2026-11-16 (hardening):** `f09-reset-request-limits.test.ts` proves 3 per hour and 5 per rolling 24 h per address from rotating IPs, with byte-identical silent 202s, and the per-IP 429. The per-address limits and the email budget are now reserve-first (F-57). The owner alert is sre's log-based alert on the "daily budget" warning, tracked with observability. **Owner alert code verified 2026-11-17 (`feat/sentry`):** a Sentry `warning` at 80% and an `error` at 100%, each a one-shot `reserve()` per fixed UTC day with `>=` (the F-58 pattern). Tested: a concurrent burst, a failed send that still counts, the next day, tracking off, and the store being down. **Gap: nothing alerts at the 60% cutoff where reset mail stops (F-60)**. **F-60 fixed 2026-11-17:** the warning is now raised at the cutoff itself (`bulkCutoff`), and the error stays at 100%. The Sentry alert rules (step 13) are still pending with sre and the owner |
| F-10 | Medium | architect → backend, ci, sre | Test hooks vs one image | verified | **Verified 2026-11-14** (build and image: hardened dist tripwire, `make image-smoke` /app allowlist plus sentinel scan over all of /app plus 404 probes); the post-deploy probe (sre) is still pending. ADR-0009; the tripwire matches the `__SHOESTRING_TEST_HOOKS__` sentinel and `_test`. If `_test` false-positives on bundled code, ci may narrow that half, but **never drop the sentinel**. **Pre-deploy pass 2026-11-17:** the runbooks now probe `POST /api/_test/reset` for 404 on the candidate tag (deploy step 5), on the public `run.app` URL right after traffic moves (step 6, where a failure means roll back at once), on the custom domain (Verify), after a rollback (rollback step 5) and at bootstrap 12. The probe runs at the first deploy |
| F-11 | Medium | architect, sre → backend | Restore resurrects access | contract-fixed | restore.md follows the contract order (restore, `revoke-sessions --all --yes --restore`, purge, reopen, re-apply post-restore security actions, BCC notice). Note: after `db/roles.sql`, verify that `app` has only INSERT/SELECT on `security_events` and that `purge_security_events()` is owned by `migrator` |
| F-12 | Medium | architect → backend | Detective controls for optional MFA | contract-fixed | All notices are priority mail; the new-sign-in notice goes out on every sign-in (F-34) |
| F-13 | Medium | architect → backend, frontend | Invitations without re-auth | contract-fixed | `x-reauth: true` on invite and on ownership transfer |
| F-14 | Medium | architect → backend | No budget recovery path | contract-fixed | Replaced by self-service restore (OD-5, ADR-0010) with notices to members. Scope construction: F-36 |
| F-15 | Medium | architect, sre → backend | argon2id DoS / denial of wallet | contract-fixed | Semaphore of 4, 2 s queue, then 503; max 2 instances × 512 MiB |
| F-16 | Medium | ci-engineer, sre | Supply chain | contract-fixed | ADR-0008 (pnpm 10.34.9, blocked scripts, 7-day release age, no-downgrade) and the WIF pin in ADR-0007 constraint 6. ci implements |
| F-17 | Medium | sre → ci | Backup storage and credentials | contract-fixed | Cloud Run job, read-only role in Secret Manager, age public key, `objectCreator` create-only (`ifGenerationMatch=0`), separate project, lifecycle 34 d. The claim "a compromised deploy can't redirect the dump" does not hold yet: F-39 |
| F-18 | Medium | architect → data, backend, ci, tests | Isolation by convention | verified | Semgrep rules, explicit extensions plus the startup check, body-ID 400, replay and export scope, cursor MAC. Deleted-budget routes: F-36. **Verified 2026-11-16 (tests/):** the permission matrix is generated from `x-budget-role` and covers every budget-scoped operation × 9 caller kinds, with non-members and ex-members getting 404. The two-household suite covers foreign sub-resource IDs (404, A unchanged, none of A's text in any answer), split category ID 400, a foreign-category filter returning an empty page, a cross-budget cursor 400, idempotency keys across budgets, a removed member's replay 404, and export |
| F-19 | Low | architect | No absolute session lifetime | contract-fixed | 90-day cap (OD-2) with DB `CHECK` constraints |
| F-20 | Low | architect → backend | Pending-session eviction; device labels | contract-fixed | Separate caps; fixed `DeviceBrowser`/`DeviceOs` enums |
| F-21 | Low | architect → backend | Login lockout DoS | verified | (email, IP) key, 100 per day per-email ceiling with notice, reset clears counters. **Tests 2026-11-16 (partial):** the 100-failure ceiling sends `login_throttled` and then refuses the right password, and the 20-per-15-minute per-IP limit is tested. Not tested: that the (email, IP) key spares the victim on *another* IP (tests/ has one IP), and that a reset clears the counters. **Verified 2026-11-16 (hardening):** `f21-login-lockout.test.ts` shows that 10 failures from one IP lock only that pair while the owner signs in from another IP, that IPv6 pairs key on the /64, and that a successful reset clears both the pair counter and the 100-per-day email counter. Concurrency residual: F-58 |
| F-22 | Low | architect → backend | Enumeration timing | verified | Deviation 1 accepted: inline send, 700 ms timeout, fixed 1 s. **Tests 2026-11-16 (partial):** budget-invitation create is timed for known vs unknown addresses (`invitations.test.ts`). Password-reset request and email-change request are not timed. **Verified 2026-11-16 (hardening):** `f22-enumeration-timing.test.ts` times both: every answer is at least 950 ms, the known and unknown medians are within 250 ms, and the known path's mail is proven sent. The slow-provider case rests on the mailer unit test (a 50 ms timeout returns `failed` without throwing); an API-level slow-mailer hook is not needed |
| F-23 | Low | architect → frontend, backend | CSP and headers | verified | CORP, XFO, `report-to`, exact Sentry host, Host check, violation gate in e2e. **Style hashes signed off 2026-11-14** (owner ruling, frontend review): `style-src 'self'` plus React Aria's two fixed sha256 hashes, nothing else. Header verified on API and SPA responses in the built image; the e2e violation gate (C3.1) and the tests/ drift contract test are still to come (test-engineer). Image-smoke gap: F-53. **Verified 2026-11-16 (tests/):** the drift test pins `style-src` to the frontend's `STYLE_SRC` and the whole policy to ARCHITECTURE.md (no `unsafe-`, nonce or `strict-dynamic`; hashes only in `style-src`). The production-build gate runs on WebKit with an iOS platform and on Chromium, asserts that both React Aria styles were injected, and proves itself live with a deliberate violation. The Host check and the headers are verified on every API route class, including 413, 415, 429 and framework errors. Still open: the SPA document (F-53), and the Sentry `connect-src`/`report-to` once `SENTRY_DSN` exists. Gate hardening: F-55. **2026-11-16 (hardening):** the SPA document half is now checked in the image (F-53), and F-55 is fixed. Only the Sentry parts remain. **Sentry parts verified 2026-11-17:** with `SENTRY_DSN` set, `connect-src` is exactly `'self'` plus the DSN's ingest origin, and `report-to csp` plus `Reporting-Endpoints` point at that project (headers-and-csp.test.ts with the fake `.test` DSN, and image-smoke step 8 on the image). The SDK adds no script, style or inline code: the csp-prod gate records zero violations with Sentry running |
| F-24 | Low | architect → backend | Crypto details | contract-fixed | `APP_KEYRING` accepted; rotate-secret.md's three stages, roll-forward rule, candidate readyz gate and vault-B escrow are correct. The compromise-mode deletion of recovery codes is **not** covered: F-38 |
| F-25 | Low | architect → data, backend | Deletion/acceptance race | verified | Row locks and purge re-check. The two checks disagree on deleted budgets: F-35. **Verified 2026-11-13** (db tests: acceptance vs deletion request serialized; purge skip-and-fail) |
| F-26 | Low | architect → data, backend | Audit log | verified | INSERT/SELECT only, `SECURITY DEFINER` purge, new types, `budget_id`; `security-events` command (deviation 6 accepted). **Verified 2026-11-13:** roles.sql verify block plus tests (app cannot UPDATE/DELETE events, function owned by migrator, cascade on user purge) |
| F-27 | Low | ci, **owner** | Public disclosure | open | Decided (OD-6). SECURITY.md and private vulnerability reporting still to be added before launch |
| F-28 | Low | architect, ci, sre | Config hygiene | contract-fixed | Migrator URL only on the migrate job; `verify-full` refused otherwise; `.gitignore` still with ci |
| F-29 | Low | architect → backend, sre | Email content injection, DMARC | contract-fixed | Escaped plain text; DMARC ramps to `p=reject` |
| F-30 | Low | ci, backend | Hooks on the LAN | contract-fixed | The origin tripwire keeps hooks off LAN origins |
| F-31 | Low | architect | Invitation list bound | contract-fixed | 20 pending per invitee email; `maxItems: 20` |
| F-32 | Low | frontend | bfcache after sign-out | verified | ARCHITECTURE: re-check on `pageshow.persisted` before rendering. **Implemented 2026-11-14** (auth.tsx: `pageshow.persisted` clears memory and shows loading before re-checking; sign-out does `location.replace('/signin')`); no test yet, so the C3.5 e2e is still needed. Sign-out that fails silently: F-51. **Tests 2026-11-16 (claim downgraded):** `e2e/sessions.spec.ts` signs out, goes Back to the budget document, and finds no budget text and a 401 session. It never asserts that the page came back *from bfcache* (`pageshow.persisted`). The journeys run on the Vite dev server, whose open HMR WebSocket can make a page ineligible for bfcache, so the test may pass on a plain reload without ever exercising the `pageshow` handler. To verify, record `persisted` in an init script and assert it is `true` on at least one project. Better still, also run the test on the production build (csp-prod projects). **Verified 2026-11-16 (re-check of #13):** `e2e/csp-prod/sign-out-back.spec.ts` runs on the production build. A Node-side `pageshow` collector (`exposeBinding`, so it survives navigation) asserts `persisted === true` on csp-prod-chromium, so the F-32 handler is exercised. WebKit covers the fresh-load path, and the test fails if either browser's behaviour changes |
| **F-33** | **High** | architect → backend, data | **New (rev 2):** cancelling with a *later* cancel token deleted the victim's earlier one | verified | auth.md §9 and §14, the OpenAPI descriptions and data-model: an earlier token wins, one change per 24 h (429), both addresses emailed, two regression tests (API, plus a DAL-seeded chain). Verified against the text 2026-11-13. **Verified in code 2026-11-16:** both auth.md §9 regression tests exist and match the text (`f33-email-change.test.ts`). In test 1, B → C gets a 429 with Retry-After of about 24 h, cancel_A reverts and revokes every session, and both addresses get `email_change_cancelled`. In test 2, cancel_B leaves cancel_A open, and cancel_A deletes the reissued token and cancel_B |
| **F-34** | Medium | architect → backend | **New (rev 2):** new-sign-in notice skipped for a previously seen browser/OS | verified | auth.md §15: sent on every successful sign-in, no skip rule. **Verified 2026-11-16:** three sign-ins with the same User-Agent send three `new_sign_in` mails, and an MFA sign-in sends one only after the second factor (`notification-emails.test.ts`) |
| F-35 | Low | architect → data | **New (rev 2):** deletion request and purge disagreed on soft-deleted budgets | verified | Same rule (non-deleted) in both; soft-deleted owned budgets are hard-deleted with the owner; the deletion email says so. **Verified 2026-11-13:** one shared function (`lockOwnedBudgetsAndCheckShared`) and tests for both paths |
| F-36 | Low | architect → data, backend, tests | **New (rev 2):** deleted-budget routes outside the scope machinery | verified | `x-budget-role: deleted_budget_owner` plus `DeletedBudgetScope` from `requireDeletedBudgetOwnership()`; startup check and permission tests cover it. The list route is user-scoped. **Verified 2026-11-16:** `permission-matrix.test.ts` "deleted-budget routes" covers these cases. A restore by an outsider, a current non-owner member, an ex-member, the owner after 30 days, or on a live budget gets 404; signed out gets 401. The list shows the budget only to its owner. Every `{budgetId}` operation on a soft-deleted budget gets 404 for its owner, and the contract side asserts that only `{deletedBudgetId}` paths carry `deleted_budget_owner` |
| F-37 | Low | architect → backend | **New (rev 3):** a restore can push other members past 10 budgets, but `BudgetList.maxItems` is 10 | open | Not blocking; see details |
| F-38 | Low | architect → backend, sre | **New (ops):** no way to retire recovery codes on a burned keyring key; stage 3 can't remove a compromised key until every user regenerates | open | Not blocking |
| F-39 | Low | sre | **New (ops):** project-level `roles/run.developer` lets the deployer execute (with env overrides) or delete `shoestring-backup`, undoing its isolation; the restore runbook picks the newest object without a provenance check | open | Not blocking; fix before launch |
| F-40 | Low | sre | **New (ops):** key material moves through the macOS clipboard (Universal Clipboard and clipboard history) and process arguments; a restore-drill note suggests running the app locally on a copy of production data | open | Not blocking |
| F-41 | Medium | data-engineer, ci-engineer | **New (data layer):** a scope can be minted outside `requireMembership`. `issueBudgetScope` is exported, and relative imports into `db/src` get around the package boundary and the Semgrep rules | verified | **Verified 2026-11-13 (re-check):** `issueBudgetScope` is module-private, with a test that it is not exported. New Semgrep rules: `shoestring-db-internal-import`, `shoestring-kysely-import-outside-db` and `shoestring-issue-budget-scope-outside-scope-module`. The DeletedBudgetScope cast rule no longer excludes the test. audit.sh now scans `tests/` |
| F-42 | Low | data-engineer | **New (data layer):** the "local host only" guards in the migrate CLI and `@shoestring/db/testing` can be bypassed with a `?host=` URL parameter; no `verify-full` check on a non-local migrator URL | verified | **Verified 2026-11-13 (re-check):** `db/src/conn.ts` takes the host from pg's own parser, refuses `host`/`hostaddr` and ambiguous hosts, and requires `verify-full` for a remote migrator URL. Used by migrate, seed and testing, with tests |
| F-43 | Low | data-engineer | **New (data layer):** the seed CLI has no environment guard and ships in the production image (`files: src, dist`) | verified | **Verified 2026-11-13 (re-check):** refuses `NODE_ENV=production` and non-local hosts (tested). `files` and `tsconfig.build.json` exclude the seed, `testing` and test support. **Closed 2026-11-17 (pre-deploy pass):** `@shoestring/db` is a backend devDependency; the bundle inlines the DAL. On the built images, the app image has no `@shoestring` package, `.pnpm` entry, dbmate, migrations or roles.sql, and its `dist/` has no seed or testing strings. The migrate image holds only `dist/cli/migrate.js`, `dist/conn.js`, migrations, roles.sql, pg and dbmate. image-smoke asserts both, with a whole-filesystem root scan of the app image |
| F-44 | Low | data-engineer | **New (data layer):** `app` can still create temporary objects (PUBLIC keeps `TEMPORARY` on the database), contrary to "no DDL" | verified | **Verified 2026-11-13 (re-check):** `REVOKE ALL ON DATABASE … FROM PUBLIC` and `REVOKE TEMPORARY` from the three roles. The verify block fails on TEMPORARY, and a test shows temp tables and `pg_temp` functions are refused. Note for sre: on an existing database, run roles.sql as the owner before the next migrate, or the verify block stops the migrate job (it fails closed). **2026-11-17:** sre's runbooks now cover this: bootstrap step 8 and the deploy precondition when roles.sql changes run it as `neondb_owner`, restore step 5 runs it as the owner before the migrator run (provenance: F-64) |
| **F-45** | Medium | backend-engineer, data-engineer, test-engineer | **New (backend):** MFA failure limits are read before the factor check and written after it, so one parallel burst gets far more guesses than 5 per session or token and 20 per user per 24 h | verified | **Fixed in this PR (owner ruling 2026-11-14) and verified:** atomic slot reservation (DAL), reserve-first user budget with refunds, `AttemptGuard`; 50-way tests on real Postgres and in the backend. **API regression 2026-11-16:** `f45-mfa-attempt-slots.test.ts` holds a table lock so that "in flight" is deterministic. A 6th attempt during the 5th gets 429 with Retry-After 1, the 5th slot can still succeed, and a burst of 12 runs exactly 5 checks. The per-user budget counts only real failures (refunds) and returns 429 with Retry-After 3600 to a correct code. It is shared with re-auth and reset, and a reset token allows at most 5 checks |
| F-46 | Low | backend-engineer | **New (backend):** the in-memory limiter map grows without bound; above 10,000 keys every request runs a full sweep that frees nothing | verified | **Verified 2026-11-14:** windows expire by end time, unref'd timer sweep, cap of 50,000 (oldest evicted); rate-limit.test.ts |
| F-47 | Low | ci-engineer, backend-engineer | **New (backend):** the production image contains backend `src/` (test-hooks.ts, dev-server.ts, test support), because `pnpm deploy` copies the whole package | verified | **Verified 2026-11-14:** backend `files: ["dist"]`; the Dockerfile copies only package.json, dist and node_modules; `make image-smoke` passed (allowlist, sentinel absent from all of /app). The earlier exposure is assessed under Final pass |
| F-48 | Low | backend-engineer (architect for the text rule) | **New (backend):** plain-text defanging misses Unicode dot equivalents and bidi controls in budget and display names | verified | **Verified 2026-11-14:** bidi controls rejected by `text()` and by `is_clean_text` (migration 20261114000100), stripped in mail; NFKC, then replacements that survive NFKC and the URL parser; tests in db and backend. **API regression 2026-11-16:** `f48-bidi-controls.test.ts` sends all 12 bidi controls to 6 create and rename fields and gets 400 `invalid_value`; ZWJ emoji are still accepted. Transaction PUT and category PATCH are not in its list; the DB `is_clean_text` rule backs them up |
| F-49 | Low | data-engineer | **New (final pass):** a deleted-budget restore racing the owner's own deletion request can succeed, because the owner's status is read in the locking statement and never re-read after `lockUser` | verified | **Fixed and verified 2026-11-16** (`fix/f49-restore-race`). `restoreDeletedBudget` locks every member's user row (ascending ID) after the budget lock and requires the owner's `lockUser` status to be `active`, else NOT_FOUND. db tests force both orders with lock-waiter gates: deletion first gets NOT_FOUND for the restore, restore first gets OWNS_SHARED_BUDGET for the deletion |
| F-50 | Low | frontend-engineer | **New (frontend):** the `#token=` capture does not run first in the production bundle. Shared chunks (API client, app components, libraries) evaluate before it, so the F-06 ordering guarantee depends on where Sentry init lands. Link tokens are also copied into TanStack query keys | verified | Not blocking; fix before Sentry is added. **Fixed and verified 2026-11-17 (`feat/sentry`).** A separate rolldown entry `boot` is injected `head-prepend` as the first `<script type="module">`. Checked in the built `dist/`: it comes before `index-*.js`, imports nothing, and holds only `capture-link-token.ts` and `lib/link-token.ts`; the main chunk imports it, so the token state is shared. check-dist proves the same on every build, and Sentry is a lazy chunk started after `load`. Signup preview and reset verify use fixed query keys with `gcTime: 0` |
| F-51 | Low | frontend-engineer | **New (frontend):** sign-out ignores a failed `POST /auth/logout` and shows sign-in anyway. Offline, the server session and cookie stay live on a shared phone | verified | **Verified 2026-11-16 (hardening):** only a 2xx or a 401 `UNAUTHENTICATED` counts as signed out; anything else throws `SignOutError`, keeps the screen and shows `sign-out-error`. `signOut({revoked: true})` is used only after the session's own DELETE succeeded. Unit tests (`auth.test.tsx`: 204, 401, offline, proxy 502, revoked) and an e2e (offline, then 503, then a retry that kills the old cookie on the server) |
| F-52 | Low | frontend-engineer | **New (frontend):** the ESLint storage ban (`no-restricted-globals`) does not catch `window.localStorage`, `window.sessionStorage`, `window.indexedDB` or `caches` | verified | **Verified 2026-11-16 (hardening):** `no-restricted-globals` plus `no-restricted-properties` on any object for `localStorage`, `sessionStorage`, `indexedDB`, `caches`, `cookieStore` and `cookie`. The only exception is one commented line in src/lib/preferences.ts; test files are exempt (they never ship). `frontend/scripts/eslint-storage-ban.test.ts` has 29 cases, covering bare, `window`/`globalThis`/`self`, computed, alias, destructuring and `document.cookie`, and confirms the exception covers one line only. I ran it: 29 passed |
| F-53 | Low | ci-engineer (test-engineer for C3.2) | **New (frontend):** `make image-smoke` checks the security headers only on `/api/healthz`, never on the SPA document where the CSP matters | verified (CI image-smoke) | Not blocking; verified by hand on 371b77c. **2026-11-16:** the C3.2 API half is in tests/. The csp-prod gate's document header is copied from `/api/healthz` by `tests/scripts/prod-server.mjs`, so it does **not** prove what the image serves on `index.html`. This finding stays open for the hardening PR. **Fixed 2026-11-16 (hardening), verified by script review:** `check_headers` runs on `/api/healthz`, `GET /` (text/html), a deep link and `/sw.js`. It checks every security header, CORP included, and requires exactly one `script-src 'self'` and exactly one `style-src 'self'` plus the two hashes from frontend/src/security/csp.ts; it fails on any third hash, any `-elem`/`-attr` override, any `'unsafe-*'` or nonce, and a duplicate CSP header. The proof is a green `image-smoke` job in this PR's CI; reopen if it is red |
| F-54 | Low | frontend-engineer | **New (frontend):** the unsaved quick-add draft and the return path survive a sign-in by a *different* user in the same tab | verified | **Verified 2026-11-16 (hardening):** new src/app/draft-stash.ts and lib/return-path.ts record the user ID. Every transition to signed-in discards another user's draft and path, and `takeStashedDraft`/`takeReturnPath` check the ID again. A path left before anyone signed in (a deep link, `userId` null) is usable by whoever signs in, which is fine: it is the link the person opened, and it still passes `safeReturnPath`. Unit tests (draft-stash, return-path, App: same user gets both back, another user gets neither) |
| F-55 | Low | test-engineer | **New (tests):** the e2e CSP gate keeps violations per *document*. A `page.goto` mid-test throws away everything recorded before it, so the gate test checks only its last page, not the quick-add sheet it is named for. The visual suite clears *all* violations after each screenshot | verified | **Verified 2026-11-16 (re-check of #13):** tests/e2e/fixtures.ts collects violations Node-side through `page.exposeBinding("__cspViolation")`, so they survive navigation. A missing binding throws as a page error instead of dropping the report. The visual `snap()` asserts before the screenshot and afterwards drops only Playwright's own screenshot style (`csp.take(isScreenshotStyle)`) |
| F-56 | Low | test-engineer (data-engineer to export the guard) | **New (tests):** `tests/support/env.ts` accepts any `DATABASE_URL` / `DATABASE_ADMIN_URL`, and an exported shell variable overrides `tests/.env.stack`, so factories and superuser helpers can write to a non-local database | verified | **Verified 2026-11-16 (re-check of #13):** tests/support/db-env.ts runs both DB URLs through `parseDatabaseUrl` from `@shoestring/db` (pg's own parser, F-42) and refuses non-local hosts without echoing the URL. env-guards.ts uses tests/.env.stack whole and makes a conflicting exported variable an error, and app and API addresses must be loopback. `make e2e-up` now writes the stack file with umask 077 |
| F-57 | Medium | backend-engineer | **New (hardening):** read-then-increment limits. The per-address reset limits, the app-wide daily email budget, the invitation caps and the email-change cap read the counter, did the work, then incremented, so one concurrent burst got past each limit (the F-45 class) | verified | **Fixed and verified in this PR (2026-11-16):** reserve-first (atomic upsert, compare, refund on refusal) with `refundOnError`/`releaseAll`; backend concurrency tests for each limit. The atomic upsert itself is proven on real Postgres by the F-45 tests. Details under "Hardening review" |
| F-58 | Low | backend-engineer | **New (hardening):** the login failure counters (`login:email_ip`, `login:email_day`) are still checked before they increment, and the `login_throttled` notice fires on `failures === 100` over a rolling sum, so a concurrent burst can skip it | verified (notice); counters owner-deferred | Counter overshoot is acceptable for launch (bounded; see details). **Notice fixed in #14 (owner ruling 2026-11-16) and verified:** `failures >= 100` plus a one-shot `reserve(login:throttled_notice, userId, DAY)`, the `mfa_locked` pattern. Tests cover two concurrent failures at 99, no repeat on the same UTC day, and a new notice the next day. Converting the counters to reserve-first is deferred by the owner |
| F-59 | Low | frontend-engineer, backend-engineer | **New (Sentry):** stack frames are parsed from `error.stack`, which starts with the message, so frame-shaped message lines become frames. The browser scrub copies frame `filename` with no character bound, and both sides allow spaces in function names | verified (residual: F-62) | Defence in depth; no current trigger found. **Fixed and verified 2026-11-17 (`fix/sentry-followups`):** server `serializeError` skips the V8 header (`name` + `message` line count; fails closed on non-string name or message), and `FUNCTION_NAME` allows no free spaces; `beforeSend` re-derives SDK-built frames from `hint.originalException`. Web: file names are own hashed chunks, a pseudo-file or `<external>`; function names are identifier-only; frames whose text is in the message tail are dropped. I reproduced each case the finding named with the real SDK parser and V8: none gets through. Residual: F-62 |
| F-60 | Low | architect → backend-engineer, sre | **New (Sentry):** the A6 owner alerts fire at 80% and 100%, but non-priority mail, password resets included, stops at 60%. Only priority mail can raise the count past 60, so a non-priority flood from one signed-in account suppresses resets for everyone until UTC midnight with no owner alert | verified | **Fixed 2026-11-17 (`fix/sentry-followups`, owner ruling):** the warning line is `bulkCutoff(quota)`, the same function the refusal uses, so the count a bulk flood can reach (exactly the cutoff) always fires it. auth.md §14, ARCHITECTURE, observability A6, email-quota.md and the cost sheet agree. Deviation 4's premise holds again |
| F-61 | Low | ci-engineer, backend-engineer | **New (Sentry):** `@sentry/node` (with @sentry/core, server-utils, opentelemetry and `@opentelemetry/api`) is a backend *devDependency* but ships in `dist/chunks/esm-*.js`. Advisories in it look "dev-only" in Dependabot and in triage | verified | **Fixed 2026-11-17:** the ADR-0008 amendment and the audit.sh triage note state the rule; build.test.ts pins the exact set of bundled npm packages against `backend/scripts/bundled-runtime-packages.json`. I checked that list against the existing `dist/` maps: they match exactly (21 packages) |
| F-62 | Low | frontend-engineer, backend-engineer | **New (Sentry follow-ups):** F-59 residuals. (a) Web: the SDK parser rewrites `(error: X)` in a line before parsing it, so a crafted message line yields a frame whose function and file are not verbatim in the message, and `fromMessage` misses it. (b) Both sides: the frame/header split trusts the *current* `message`; V8 fixes the header at the first `.stack` read, so a message shortened afterwards exposes its old lines | verified (accepted residual) | Defence in depth; no trigger. What leaks at most: one identifier-shaped word and two integers. **Fixed and verified 2026-11-17 (`fix/offline-and-f62`):** (a) the web haystack also holds each tail as the SDK parser sees it (1024 cut, then the `(error: X)` rewrite); (b) both sides keep frames only when `stack` starts with exactly the current header (web: V8 only, every reachable linked error, own stack required, getters fail closed). I reproduced the original cases with the real parser and Node 24: none gets through. **Residual, accepted by security-reviewer:** a current header that is a whole-line prefix of the stale one (a cut exactly at a line break) still matches. Re-open conditions are in the review section |
| F-63 | Low | frontend-engineer | **New (offline/F-62 review):** web F-59/F-62 gaps. (1) The haystack holds only the message's later lines, but the SDK also parses the header's first line when it lacks `Error: ` (a name such as `ReauthCancelled`) and every line of a multi-line `name`. (2) `reachableErrors` counts non-Error objects toward its cap of 32 and does not fail closed when the cap is hit, so a long non-Error `cause` chain can hide an `errors[]` child that the SDK still reports | open | Defence in depth; no trigger (every error name and every first message line in the app is fixed text, and browser DOMException names all end in `Error`). Same ceiling as F-59: at most one identifier and two integers. Not blocking |
| F-64 | Low | sre | **New (pre-deploy pass):** restore.md step 5 feeds `git show "$SERVING_SHA:db/roles.sql"` to psql as the **database owner** without validating `SERVING_SHA`. Empty means the index copy; any fetched commit is accepted; `.spec.template` isn't the serving revision after a rollback | verified | **Fixed and verified 2026-11-17 (runbook review, same PR).** restore.md: `pipefail`; the SHA comes from the revision taking 100% of traffic (empty if traffic is split, which then stops); `check_sha` (40 hex, `merge-base --is-ancestor origin/main`, file exists) is re-run inside `roles_sql`, so an empty or off-main SHA can't reach psql; `git log -1` confirmation; the owner URL is `read -rs`, not exported, and unset after step 5. A newer release's owner part after a rollback fails closed in the migrate job. Bootstrap step 8: porcelain plus `diff --quiet origin/main`. Deploy precondition: detached clean checkout plus porcelain. Not done, and acceptable: reading roles.sql from the migrate image by digest. Nit (Info): bootstrap step 8 still `export`s `OWNER_URL`; plain `read -rs` and an `unset` after the `\password` session would match restore |
| F-65 | Low | sre (security-reviewer signs V26) | **New (pre-deploy pass):** bootstrap step 14 measures the hop count on `run.app` only. Users arrive through the domain mapping, which is "as well" (optional), and the rule if the two paths differ is not stated | verified (runbook); measurement pending (V26) | **Fixed 2026-11-17 (same PR).** Step 14 has mandatory 14a (`run.app`) and 14b (temporary DNS-only domain mapping) probes. On a mismatch: stop, don't change the value, don't launch, escalate to security-reviewer. If both are 2 or more: escalate, then use a gated revision. infra/CLAUDE.md "Client IP" records both counts and blocks launch until they agree; hosting-evaluation.md V26 requires both. If 14b's identity token is refused, the runbook escalates instead of making the probe public (correct). The F-08 gate closes when I sign the recorded measurements |

## Re-review 2026-11-13: architect deviations
| # | Deviation | Ruling |
|---|---|---|
| 1 | F-22: inline send, 700 ms provider timeout, fixed 1 s response, no retry | **Accept.** Cloud Run throttles CPU after the response, so a post-response queue would be unreliable. The timeout is below the pad, so timing is constant. Losing a non-priority mail is acceptable because the user can ask again. The email-change cancel link is sent twice (at request and at confirm), which covers a single failed send. |
| 2 | F-01: within 24 h the cancel link also reverts an already-confirmed change; cancel tokens are exempt from revocation | **Accept the revert semantics, with changes.** This is the only way back for a phished user. Required changes: **F-33**. Also, the cancel/revert notice must go to **both** addresses (the restored one and the one reverted away from), so a legitimate user whose old mailbox is compromised learns at once. The residual (whoever holds the old mailbox can undo a real change for 24 h) becomes **R-11** and needs the owner's sign-off. |
| 3 | F-02: target emails stay in private GCP job records and audit logs | **Accept as residual R-12**, at the same trust level as the Neon console. Note for sre to verify: Cloud Audit Logs Admin Activity entries are kept about 400 days and cannot be shortened. If job arguments are recorded there, a purged user's email outlives the 30 + 35-day deletion promise. State that in the privacy notice. |
| 4 | Password-reset mail is non-priority; during a flood resets are suppressed and security notices still go out | **Accept.** Priority mail is the takeover detector, and a reset can be re-requested. An anonymous attacker is capped at 5 resets per email per day, so with fewer than 10 users resets alone cannot reach the 60 per day budget. The owner gets the budget alert. |
| 5 | Ownership transfer has no acceptance step; all members are notified | **Accept.** Acceptance protects the recipient's consent, not security: an attacker-controlled recipient would simply accept. The transfer requires re-auth and an existing member with an active account, and sends a priority notice to everyone. The residual (a phished owner hands the budget to a co-conspirator member, and the former owner cannot reclaim it) falls under R-1 and R-4. |
| 6 | `security-events` puts IPs into 30-day Cloud Logging output | **Accept under R-6.** It is the same data, kept for less time, in the owner-only project, and only when the owner runs an investigation. Conditions: the `_Default` bucket stays at 30 days, no log sink copies the job logs elsewhere, and the output never contains emails. |

## Details

### F-01 High: one-time tokens survive account recovery (email-change takeover)
- **Location:** auth.md:15 §2 "Revocation", auth.md:58 §8 step 4, auth.md:62 §9; data-model.md:72–84 `user_tokens`; api.openapi.yaml:396–416 (`confirmEmailChange`, `x-session: none`); admin-commands.md:19–20.
- **Scenario:** a user without MFA (R-1) is phished. The attacker signs in, re-authenticates with the password, and calls `POST /me/email-change {newEmail: attacker@…}`. The victim receives the "email change requested" notice and does what we tell them: resets the password, which revokes all sessions. Sign-out-everywhere or the owner's `revoke-sessions` have the same weakness. **The email-change token stays valid for 24 h.** The attacker calls `POST /auth/email-change/confirm {token}` without any session. The account's email is now the attacker's. They then run a password reset to their own mailbox and hold the account and all of its budget memberships permanently. The same gap lets a pending reset token outlive a password change.
- **Recommended contract change:**
  1. auth.md §2: password change, password reset, revoke-others, admin `revoke-sessions`, `reset-mfa`, any MFA factor change, and the deletion request **delete all open `user_tokens`** for the user, in the same transaction.
  2. auth.md §9: make `POST /auth/email-change/confirm` require an `active` session **of the same user** as well as the token (`x-session: active`). Store `requested_by_session_id` on the token and invalidate it if that session is revoked.
  3. The notice to the old address includes a "this wasn't me" link (a fragment token, purpose `email_change_cancel`, valid 24 h) that cancels the change and revokes every session.
  4. Define exactly which sessions "revoke all other sessions" means at confirm (with item 2: all except the confirming session).
- **Implements:** data (new token purpose, column), backend, frontend (confirm page requires sign-in), tests (regression: reset, then confirm, gives `TOKEN_INVALID`).

### F-02 High: admin CLI execution location and PII in logs
- **Location:** admin-commands.md:4 (execution options include "a GitHub Actions workflow"), :9 ("may print the target email"), :10; ADR-0007:16 constraint 5; ARCHITECTURE.md:78.
- **Scenario:** the owner runs `reset-mfa --email alice@…` or `create-signup-invite` through a `workflow_dispatch` workflow. On a **public** repo, Actions run logs and dispatch inputs can be read by anyone. Every user's email address, and the fact that their MFA was reset (a signal that the account is weak right now), are published and kept for up to 90 days. Run as a platform job instead, stdout becomes platform logs, which contradicts "No emails in logs". Separately, "same environment variables as the server" copies `MFA_ENCRYPTION_KEY`, `EMAIL_API_KEY` and `THROTTLE_KEY` into every place the CLI runs, including GitHub for the purge cron.
- **Recommended contract change:**
  1. admin-commands.md: commands that take an email (`create-signup-invite`, `reset-mfa`, `revoke-sessions`) **must not run in GitHub Actions**. They run as a platform one-off job or exec started by the owner from the authenticated platform CLI or console. Secrets stay in the platform.
  2. Output never contains emails or tokens. Print the user ID, invite ID and expiry. The owner typed the email, so echoing it adds nothing.
  3. Each command loads **only the config it needs** (purge: `DATABASE_URL` only; it never needs `MFA_ENCRYPTION_KEY` or `EMAIL_API_KEY`).
  4. `purge` may run on GitHub Actions cron only if its output is counts only and its sole secret is a DB credential in a `production` environment restricted to `main`.
  5. `reset-mfa` runbook requirements (sre, reviewed by security): assume the requester's mailbox may be compromised. Verify identity by a call or video that **the owner** starts, to contact details known before the request, never ones supplied in it. Record the date and the method of verification. After the reset, the user re-enrolls immediately. `reset-mfa` also deletes open `user_tokens` (F-01).
- **Implements:** backend (CLI output, per-command config), sre (runbooks, job definitions), ci (workflow constraints).

### F-03 High: operator accounts are the real root, and none is required to use MFA
- **Location:** ADR-0007:17 constraint 6 (secrets) and the whole of ADR-0007; no contract states it.
- **Scenario:** in-app MFA is optional, but the owner's **GitHub** account can push to `main` and deploy, the **host** and **Neon** consoles read all data, the **DNS registrar** or **domain email** can redirect the app or receive reset links, and the **email provider** can send phishing from the real sending domain. A phished password on any of these is a full compromise that no app control can detect.
- **Recommended change:** ADR-0007 gains a fixed constraint: "Every operator account (GitHub, host, Neon, email provider, Sentry, DNS registrar, the owner's own mailbox) uses phishing-resistant MFA (passkey or security key), with recovery codes stored offline; GitHub has 2FA required and push protection on." sre adds it to the billing and first-deploy checklist. **Owner** carries it out and confirms.
- **Implements:** sre (checklist), **owner** (action).

### F-04 Medium: recovery codes are crackable offline
- **Location:** auth.md:44 §6 "Recovery codes"; data-model.md:126; contrast ADR-0003:30 ("so a database or backup leak alone does not defeat MFA").
- **Scenario:** a DB or backup dump leaks. The codes are unsalted SHA-256 of 50-bit values, and every user's codes are cracked together (about 100 targets across 10 users). A single modern GPU (~10^10 SHA-256/s) recovers *a* valid code for a chosen user in hours, or some user's code in minutes. With the victim's mailbox (password reset accepts a recovery code as the second factor) or their password, MFA is defeated. That is exactly the leak scenario ADR-0003 encrypts TOTP to prevent.
- **Recommended contract change:** store `HMAC-SHA-256(K_rc, normalized_code)`, where `K_rc = HKDF(MFA_ENCRYPTION_KEY, info="recovery-code-v1")`. This keeps lookup cheap and makes offline brute force impossible without the app secret (the same trust level as TOTP). Keep 50-bit codes. Alternatively, raise them to 80 bits (16 characters), but the HMAC is the simpler fix. Normalization must be specified (lowercase, strip the hyphen). Compare in constant time.
- **Implements:** data (column semantics), backend.

### F-05 Medium: MFA failure budget is not unified
- **Location:** auth.md:37 §5 step 3; :58 §8 step 4; :141–146 §14.
- **Scenario:** an attacker holding a password, or the victim's mailbox, spreads TOTP guesses across `/auth/mfa/verify` (5 per pending session; the 20 per user per 24 h cap applies here), `/auth/reauth` (5 per session per 15 min, with no per-user cap; this needs a stolen session) and `/auth/password-reset/complete`. The reset path allows 5 per token and 3 tokens per email per hour, about 360 guesses per day, and the contract never says it counts toward the per-user cap. Each 6-digit guess with ±1 step has a 3×10⁻⁶ chance, so this is slow but not negligible over months, and it is free.
- **Recommended contract change:** one per-user counter, "MFA failures, 20 per 24 h", incremented by every endpoint that verifies a factor (`mfa/verify`, `reauth`, `password-reset/complete`, `totp/confirm` is exempt because it is the user's own enrollment). When it is exceeded, every factor check for that user answers 429 for the rest of the window, a `mfa_locked` security event is recorded, and the user is emailed. State in §8 that reset-path failures count.
- **Implements:** backend, tests.

### F-06 Medium: fragment tokens leak to Sentry, browser history and email click tracking
- **Location:** auth.md:29 §4 (link format); ARCHITECTURE.md:71 (Error tracking), :74 (Email).
- **Scenario:** (a) A JavaScript error on `/reset-password#token=…` or `/signup#token=…` sends the page URL, fragment included, to Sentry. Navigation breadcrumbs also record it. (b) The fragment stays in browser history and in synced tabs (iCloud and Chrome sync) on shared devices. (c) Free email providers often enable click tracking by default. That rewrites links through their redirector and stores the full original URL, including the fragment.
- **Recommended contract change:**
  1. auth.md §4: "The SPA reads the token and immediately calls `history.replaceState` to remove the fragment, **before** the Sentry SDK initializes or any route renders. It keeps the token in memory only."
  2. ARCHITECTURE Error tracking: `beforeSend` and `beforeBreadcrumb` strip `#…` and `?…` from every URL.
  3. ARCHITECTURE Email: "Click and open tracking are disabled for all messages; plain links only."
- **Implements:** frontend, sre (provider setting), tests (an e2e check that `location.hash` is empty after load and that captured Sentry events contain no `token=`).

### F-07 Medium: error paths bypass the redaction list
- **Location:** ARCHITECTURE.md:70 (Request IDs and logging), :71 (Error tracking); errors.md:118 ("5xx log the stack trace and go to Sentry"); data-model.md:251 ("a trigger failure is a 500").
- **Scenario:** a split-sum trigger failure, an FK violation from a foreign `categoryId` (F-18), or a CHECK violation raises a `pg` error whose `detail` reads `Failing row contains (…, 'Pharmacy', 'therapy copay', 4500, …)`. The 5xx handler logs the error object and Sentry captures it, so payee, memo and amount reach logs and a third party. In the browser, Sentry's default DOM (`ui.click`) breadcrumbs capture element selectors and labels (for example an `aria-label` "Delete Pharmacy $45.00"), and Sentry stores the client IP unless that is disabled.
- **Recommended contract change:**
  1. Logging rules: errors are serialized through an **allowlist**: `name`, `code` (SQLSTATE), `constraint`, `table`, and the stack with frames only. Never log `message`, `detail`, `where`, `hint`, query text or parameters of DB or driver errors, or zod "received" values.
  2. Sentry (both sides): `sendDefaultPii: false`; DOM and console breadcrumbs **off**; fetch breadcrumbs keep the URL path only; the server SDK sends no request headers, cookies or bodies; the project settings turn on "Prevent storing of IP addresses" and the data scrubber, with extra fields `token`, `password`, `code`, `email`, `payee`, `memo`.
  3. The redaction unit test includes a DB-error case.
- **Implements:** backend, frontend, sre (Sentry project settings).

### F-08 Medium: trusted client IP is unspecified
- **Location:** auth.md:134 §14 ("trusted only as configured"), :137 global row; ADR-0007 criterion C9 and Consequences (backend `trustProxy`).
- **Scenario:** with Fastify `trustProxy: true`, `request.ip` is the **leftmost** `X-Forwarded-For` entry, which the client controls. An attacker who sends a random `X-Forwarded-For` on each request bypasses every per-IP limit (global, login, sign-up, reset) and writes arbitrary IPs into `security_events`. With IPv6, one host has a /64 or more to rotate through.
- **Recommended contract change:** auth.md §14: "The client IP is the address appended by the platform's edge: `trustProxy` is the platform's exact hop count (ADR-0007 records it; a Firebase-Hosting rewrite in front adds a hop), never `true`. Per-IP keys use the full IPv4 address or the IPv6 /64 prefix." Add a test that a forged leftmost `X-Forwarded-For` does not change the derived IP.
- **Implements:** sre (hop count in ADR-0007), backend, tests.

### F-09 Medium: email quota exhaustion denies recovery
- **Location:** auth.md:145 (`password-reset-request` 3 per email per hour, silent), :152; ARCHITECTURE.md:74.
- **Scenario:** free tiers allow on the order of 100–300 emails a day. Rotating IPs (or IPv6, F-08), an attacker asks for resets for every known user address: 3 per hour each, about 72 per day per victim, about 700 per day for 10 users. The provider quota runs out. Real resets, sign-up invites and security notices fail, and the provider may suspend the account after complaints. Notification emails are also our main detective control (R-1).
- **Recommended contract change:** add rows to auth.md §14: per-email reset requests at **3 per hour and 5 per 24 h** (silent); a **global email budget** per day (for example 80% of the provider quota) after which only security notifications and owner-initiated invites are sent, with an alert to the owner. ARCHITECTURE Email: the adapter records sends per day as a metric. sre puts the quota in the cost sheet.
- **Implements:** backend, sre (alert).

### F-10 Medium: keeping test hooks out of production is self-contradictory
- **Location:** test-hooks.md:4–7; ADR-0007:14 constraint 3 ("One container image … deployed unchanged"); ARCHITECTURE.md:73 (refuses `TEST_HOOKS=1` in production).
- **Scenario:** if e2e runs against the CI-built production image, the hooks module must be inside that image, so "the production build does not import it" is false. The only guard is then two environment variables, and common platforms (Cloud Run among them) do not set `NODE_ENV`. A misconfigured deploy with `TEST_HOOKS=1` and `NODE_ENV` unset exposes `POST /api/_test/login {email}`: anyone becomes anyone, with no password and no MFA.
- **Recommended contract change:** test-hooks.md:
  1. The Dockerfile has a `prod` target that **physically excludes** the hooks module (not present in `dist/`), and a `test` target (prod plus hooks) used by e2e. CI fails if the string `/_test/` appears anywhere in the prod image's `dist/`.
  2. The Dockerfile sets `ENV NODE_ENV=production` in the prod target. Config **fails closed** if `NODE_ENV` is missing.
  3. Third guard: hooks register only when `APP_ORIGIN` is an `http://localhost`, `http://127.0.0.1` or `*.test` origin.
  4. The post-deploy smoke test asserts `POST /api/_test/reset` returns 404 in production.
- **Implements:** ci (Dockerfile, audit rule), backend, sre (smoke test).

### F-11 Medium: restore resurrects revoked access
- **Location:** admin-commands.md:16–21; ADR-0007:18 constraint 7; data-model.md:278.
- **Scenario:** after an incident the owner revokes an attacker's sessions, the victim changes their password, and the owner removes a member. Days later the DB is restored from a backup taken before those events. The attacker's session token hash, the old (compromised) password hash, the removed membership and any removed MFA factor are all back. Time-based purge re-runs correctly; event-based changes do not.
- **Recommended contract change:**
  1. admin-commands.md: add `revoke-sessions --all` (every user), and have it also delete all open `user_tokens`.
  2. The restore runbook (sre) must then run, in order: `revoke-sessions --all`, `purge`, and an email to all users saying "data since <time> was restored; sign in again; check your members, MFA and password". Security reviews that runbook.
- **Implements:** backend, sre.

### F-12 Medium: detective controls for optional MFA
- **Location:** auth.md:157 §15 (notification list), :155 (event types).
- **Scenario:** with MFA optional (R-1), password compromise is the most likely attack, and nothing tells the victim that someone signed in. A compromised owner can also add an attacker's account, which the household never hears about, or delete the shared budget without members being told.
- **Recommended contract change:** add notification emails for: **new sign-in** (device label and time, a link to the device list; skip when the device label and the last 30 days of sessions match, if you want less noise); **five failed MFA attempts after a correct password**; **budget invitation accepted** (to the budget owner); **budget deleted** (to all members); **member removed** (to the removed member). Add event types `budget_invitation_created`, `budget_invitation_accepted` and `data_exported` (see F-26).
- **Implements:** backend, frontend (copy).

### F-13 Medium: sharing a budget needs no re-authentication
- **Location:** auth.md:66 §10 (re-auth list); api.openapi.yaml:1063–1077 (`createBudgetInvitation`, no `x-reauth`).
- **Scenario:** an ex-partner borrows the owner's unlocked phone for a minute (the session lasts 30 days) and invites their own existing Shoestring account. Accepting it from their own device gives them lasting access to the household's finances that **survives** session revocation, a password change and `reset-mfa`. Revocation removes the attacker's sessions on the victim's account, not the attacker's membership.
- **Recommended contract change:** `x-reauth: true` on `POST /budgets/{b}/invitations`, and add it to the auth.md §10 list and the permission matrix ("GET, POST /budgets/{b}/invitations" splits into GET ✓ and POST R). Combine with F-12 (acceptance notice).
- **Implements:** backend, frontend (re-auth dialog already exists), tests.

### F-14 Medium: no recovery path for a deleted budget
- **Location:** admin-commands.md:23–24 ("Not admin commands"); data-model.md:14 (soft delete), :173; api.openapi.yaml:975–985.
- **Scenario:** a phished owner (R-1; re-auth is password-only without MFA) or a mistaken tap plus re-auth deletes the shared budget. The rows are soft-deleted for 30 days, but no API or admin command restores them, so recovery would mean ad-hoc SQL against production, which the admin-commands principles rule out.
- **Recommended contract change (needs an ADR; owner decision OD-5):** add `restore-budget --id <budgetId>` (clears `deleted_at` if the 30-day window has not passed; writes `admin_budget_restored`; emails the members). Notify all members on deletion (F-12).
- **Implements:** backend, sre (runbook).

### F-15 Medium: argon2id denial of service and denial of wallet
- **Location:** auth.md:52 §7 (m=19 MiB); ARCHITECTURE NFR (login within 1 s); ADR-0007 C7 (256 MB RAM, max-instance setting).
- **Scenario:** a few dozen parallel `POST /auth/login` (for unknown emails too, because of the dummy hash) from many IPs each allocate 19 MiB. A 256 MB instance runs out of memory and crashes in a loop. On autoscaling hosts the same load adds instances, and some candidate hosts have only budget alerts, not hard caps (R-10).
- **Recommended contract change:** auth.md §7: "Password hashing runs behind a per-instance semaphore (for example 4 concurrent operations; the queue waits up to 2 s, then answers 503 `UNAVAILABLE` with `Retry-After`). The dummy-hash path goes through the same queue." ADR-0007: max-instances is fixed at a small number and stated; the per-request concurrency setting is stated.
- **Implements:** backend, sre.

### F-16 Medium: supply-chain and CI hardening gaps
- **Location:** ADR-0001:17 (CI line); ADR-0007:17 constraint 6; .github/workflows/ci.yml (unpinned `actions/checkout@v5`; ci-engineer is already fixing this).
- **Scenario:** a compromised npm package's `postinstall` script runs during `pnpm install` in CI (as in the 2025 npm worm campaigns), reads environment secrets or the OIDC token, and pushes or deploys. Alternatively, a broad workload-identity trust (for example "any workflow in this repo") lets a PR branch's workflow deploy.
- **Recommended change (ci-engineer and sre; no contract change):**
  - `pnpm install --frozen-lockfile`. pnpm's dependency build scripts are off except an explicit allowlist (`onlyBuiltDependencies`: argon2 and anything else proven to need them). `minimumReleaseAge` of at least 3 days for new versions.
  - Never use `pull_request_target` or `workflow_run` with a checkout of PR code. `permissions: {}` by default, with per-job grants.
  - Deploy only from a `production` environment restricted to `main`, with OIDC attribute conditions pinned to `repo:<owner>/<repo>:environment:production`. The deploy job runs no `pnpm install` (it deploys the image built earlier).
  - Pin base images by digest; Dependabot covers npm, Actions and Docker (already planned). `make audit` fails on High.
- **Implements:** ci-engineer, sre.

### F-17 Medium: backup storage and credentials
- **Location:** ADR-0007:18 constraint 7; ARCHITECTURE.md:78 and the system diagram.
- **Ruling:** **public-repo Actions artifacts are not accepted**, even encrypted. Any signed-in GitHub user can download them, the run logs are public (one `set -x` or `pg_dump` error line leaks data), and confidentiality would rest entirely on one key forever ("harvest now, decrypt later").
- **Recommended change (sre, in ADR-0007's Decision):** storage is one of (a) a separate **private** GitHub repo that runs only the backup workflow (private artifacts, 35-day retention, within the free minutes), or (b) free object storage with a lifecycle rule of 35 days or less. The credential is **write-only** (no list, read or delete from CI), so a CI compromise cannot read or wipe backups. The backup job connects as a dedicated **read-only `backup` role** (SELECT only), never `app` or `migrator`. It encrypts with `age` to the owner's public key. The private key is held offline in two places, and `MFA_ENCRYPTION_KEY` is never stored with backups. The restore drill proves the whole chain.
- **Implements:** sre, ci, data (the `backup` role).

### F-18 Medium: isolation guarantees must be enforced by tooling (conditions for accepting no RLS)
- **Location:** ADR-0006:13–14, :21; auth.md:73–75 §12; data-model.md:11 (Tenancy), :163 (idempotency replay), :284 (export scope); api.openapi.yaml `SplitWrite.categoryId`, `x-budget-role` usage.
- **Scenario:** TypeScript brands exist only at compile time. One `{ budgetId, userId, role } as BudgetScope`, a raw `sql\`…\`` in a handler, or a DAL helper that "just needs the transaction by ID" removes the only tenant guard, and nothing at the database level catches a read. Also unspecified in the contract today: the error for a foreign `categoryId` in a split body (the FK fires, giving a 500 whose detail contains values, F-07); whether idempotent replay goes through the scope and hides soft-deleted rows; and whether export derives budgets from `requireMembership`.
- **Recommended contract change (ADR-0006 Consequences, auth.md §12):**
  1. A Semgrep or lint rule (in `make check`/`make audit`) bans type assertions to `BudgetScope` outside `requireMembership`, Kysely `db`/`sql` imports outside `db/`, and DAL functions taking a raw `budgetId`.
  2. The startup route check requires `x-budget-role` on **every path containing `{budgetId}`**, and every operation states `x-reauth` and `x-budget-role` explicitly (`false` or `none`) rather than relying on absence.
  3. A `categoryId` in a body that is not in the budget gives 400 `VALIDATION_FAILED` (`splits.N.categoryId`, `invalid_value`), checked before the write.
  4. Idempotent replay loads the resource through the current `BudgetScope`; a soft-deleted resource replays as 404.
  5. Export iterates `requireMembership` for each membership.
  6. Cursors carry a MAC over budget ID, filters and position (with `THROTTLE_KEY`-style app secret, or a dedicated subkey).
  7. The two-household isolation suite runs every DAL function against a scope for budget A on a DB seeded with budget B.
- **Implements:** data, backend, ci (rules), tests.

### F-19 Low: no absolute session lifetime (owner decision OD-2)
- **Location:** auth.md:13 §2.
- **Scenario:** a cookie copied from a shared or lost device stays valid for as long as it is used once every 30 days.
- **Recommended change:** an absolute cap of 90 days from `created_at` (not extended by sliding), after which the user signs in again. Add an `absolute_expires_at` column.

### F-20 Low: pending-session eviction and device labels
- **Location:** auth.md:16–17; data-model.md:54, :57.
- **Scenario:** someone with the password but not the second factor logs in 20 times. Each `mfa_pending` session evicts the victim's least recently seen *active* session, forcing sign-outs. Separately, a label built from raw UA substrings could carry attacker text into the device list.
- **Recommended change:** `mfa_pending` sessions do not count toward the 20-session cap and never evict active ones (separate cap of 5 pending; the oldest pending is evicted). The device label comes from a fixed vocabulary of browser family × OS family, plus "Unknown device".

### F-21 Low: targeted login lockout
- **Location:** auth.md:140 §14.
- **Scenario:** 10 wrong passwords every 15 minutes for the victim's email keep them locked out (429) indefinitely, from a single IP.
- **Recommended change:** key the 10-per-15-minute row on (email, IP or /64). Add a per-email ceiling of 100 failures per 24 h that triggers 429 **and** a notification email. A successful password reset clears the email counters.

### F-22 Low: enumeration padding with an in-request email send
- **Location:** auth.md:152 §14.
- **Scenario:** if the provider API call takes longer than 1 s, existing accounts answer slower than unknown ones.
- **Recommended change:** commit, then queue the email (an in-process queue with retry after the response). Pad to a fixed 1 s measured from the start of the request. Make the provider call timeout shorter than the pad, so a slow send can never stretch the response.

### F-23 Low: CSP and header details
- **Location (first review):** ARCHITECTURE.md:72. **Now:** ARCHITECTURE.md "Security headers" (~124–136); backend/src/http/security-headers.ts:31–40 (`REACT_ARIA_STYLE_HASHES`, `STYLE_DIRECTIVES`); frontend/src/security/csp.ts:10–19.
- **Notes and recommended change:**
  - React's `style={…}` writes through CSSOM, which CSP does not govern. Primitives that inject `<style>` elements with *variable* content (Radix Dialog's scroll lock through `react-remove-scroll-bar`, ScrollArea) stay excluded. Add an e2e assertion that **any `securitypolicyviolation` event fails the test**. `script-src` never relaxes.
  - **Style exception (superseded 2026-11-14).** The first review said the only acceptable relaxation was `style-src-elem 'self' 'unsafe-inline'`. The owner's ruling (mvp-planning/10 "Build round 3") replaced that with something narrower: `style-src 'self'` plus **exactly two sha256 hashes** for React Aria's fixed `<style>` blocks (`usePress`, `usePreventScroll`). No `'unsafe-inline'`, no nonce, no `'unsafe-hashes'`, no other hash. **Security sign-off given 2026-11-14** (frontend review, below). Any change to this directive, including a new hash after a React Aria upgrade, needs security sign-off again.
  - Add `report-to` (Sentry's CSP endpoint) so production violations are seen.
  - `connect-src` names the **exact** Sentry org ingest host (`o<id>.ingest.us.sentry.io`), not a wildcard.
  - Add `Cross-Origin-Resource-Policy: same-origin` and `X-Frame-Options: DENY` (older WebViews).
  - The backend rejects requests whose `Host` is not the `APP_ORIGIN` host (blocks DNS rebinding and Host-header poisoning). Email links are built only from `APP_ORIGIN`.

### F-24 Low: cryptography details
- **Location:** auth.md:42 (TOTP AES-256-GCM), :51 (HIBP); data-model.md:90.
- **Recommended change:** GCM uses a random 96-bit nonce per encryption, **AAD = `user_id`** (stops ciphertexts being swapped between rows), and a stored key-ID prefix so `MFA_ENCRYPTION_KEY` can be rotated (sre runbook). Derive subkeys with HKDF (TOTP, recovery codes F-04, cursor MAC F-18) instead of reusing raw keys. HIBP requests send `Add-Padding: true`, verify TLS and cap the response size. Config refuses `HIBP_ENABLED=false` in production, so an outage falls back to the bundled list but a misconfiguration cannot silently disable the check.

### F-25 Low: deletion and acceptance race; purge safety
- **Location:** data-model.md:199 (accept invariants), :272–274 (deletion request and purge step 1).
- **Scenario:** a deletion request (checks "no other members") and an invitation acceptance (checks "owner active") commit concurrently. The purge later deletes a budget that now has a member, destroying that member's data.
- **Recommended change:** both transactions lock the budget rows (`SELECT … FOR UPDATE` on the owned budgets and on the invitation's budget). Purge step 1 **re-checks** "no other members" and skips that user, logging and alerting, instead of deleting.

### F-26 Low: audit log integrity and coverage
- **Location:** data-model.md:132–142 (`security_events`); auth.md:155.
- **Recommended change:** the `app` role gets INSERT and SELECT only on `security_events`. The 90-day purge runs through a `SECURITY DEFINER` function owned by `migrator` that deletes only rows older than 90 days. Add a nullable `budget_id` (no FK) for budget events. Add event types `data_exported`, `budget_invitation_created`, `budget_invitation_accepted`, `budget_invitation_revoked`, `mfa_locked` (F-05), `email_change_cancelled` (F-01), `admin_budget_restored` (F-14). Reserve a read-only `security-events --user-id` admin command for incident response, so the owner never needs ad-hoc production SQL (needs an ADR).

### F-27 Low: public disclosure of open findings (owner decision OD-6)
- **Location:** this file (a public repo).
- **Scenario:** after launch, an open High finding with an exploit scenario sits in a public file before it is fixed.
- **Recommended change:** add `SECURITY.md` and enable GitHub private vulnerability reporting. After launch, open Critical and High findings are tracked in a private GitHub security advisory and written up here once fixed. Design-phase findings, like this list, can stay public.

### F-28 Low: configuration and secret hygiene
- **Location:** ARCHITECTURE.md:73 (config list includes `DATABASE_MIGRATOR_URL`); admin-commands.md:4; .gitignore:1–5.
- **Recommended change:** `DATABASE_MIGRATOR_URL` is provided only to the release or migration step, never to the serving container or the CLI. DB URLs use `sslmode=verify-full` and long random passwords (free tiers are internet-reachable). The Neon default owner role is never used by the app. `.gitignore` covers `.env.*` except `.env.example` (ci-engineer task 1). Each key (`MFA_ENCRYPTION_KEY`, `THROTTLE_KEY`) is 32 random bytes, different per environment, and validated for length at startup.

### F-29 Low: email content injection; sending-domain policy
- **Location:** auth.md:157 §15 (budget names in invitation emails).
- **Scenario:** a budget named "Action needed: verify at evil.example" turns our invitation email into phishing sent from our domain.
- **Recommended change:** user-controlled text in emails is escaped, rendered as plain text, never linkified, and length-capped. The only link in any email is built from `APP_ORIGIN`. sre publishes SPF, DKIM and **DMARC `p=reject`** for the sending subdomain.

### F-30 Low: local dev exposure during phone testing
- **Location:** test-hooks.md:7; mvp-planning/06-ci-engineer.md task 10 (expose `make dev` on the LAN).
- **Scenario:** on café Wi-Fi, anyone can call `/api/_test/login`, and DNS rebinding can read `GET /api/_test/emails`. The data is synthetic, so the impact is low.
- **Recommended change:** the LAN-binding recipe disables `TEST_HOOKS` (or binds the hooks to loopback only). The Host check (F-23) applies in development too.

### F-31 Low: invitation list bound and flooding
- **Location:** api.openapi.yaml:2330–2338 (`MyInvitationList.maxItems: 50`); data-model.md:199 (10 pending per budget), :256 (10 budgets per user).
- **Scenario:** existing users can address more than 50 pending invitations to one email (several users × 10 budgets × 1 each), hiding a real invitation or breaking response validation.
- **Recommended change:** cap pending invitations per invitee email at 20 (`LIMIT_REACHED`, same response for any email so it does not enumerate), sort newest first, and keep `maxItems` at or above that cap.

### F-32 Low: back/forward cache after sign-out
- **Location:** ARCHITECTURE.md:69; ADR-0002.
- **Scenario:** on a shared phone, after sign-out, pressing Back restores the last financial screen from bfcache.
- **Recommended change (frontend):** sign-out does a full `location.replace('/signin')`. On `pageshow` with `event.persisted`, re-check the session and clear state before showing anything.
- **Re-review 2026-11-13:** `location.replace` is in ARCHITECTURE "No financial data on the device". The `pageshow` re-check is not written down; frontend adds it (checklist C3.5).

## Re-review notes on partially fixed findings (2026-11-13)
- **F-17 (backups):** the remaining exposure is the nightly GitHub Actions job's DB credential, the `backup` role, which can read every table: password hashes, TOTP ciphertext, and all financial data. It lives in environment `backup` of a **public** repo. A compromised action or tool in that workflow could stream the database somewhere else; `objectCreator`-only storage does not prevent that. Choose one and record it in ADR-0007 constraint 10:
  - (a) Run the backup as a Cloud Run job in the prod project. It costs nothing at this scale; Cloud Scheduler triggers it, the DB secret stays in Secret Manager, and a cross-project `objectCreator` grant writes to the bucket. **Recommended.**
  - (b) Keep GitHub Actions, but the backup workflow uses **no third-party actions** (not even checkout) and no npm. It installs `age` and `pg_dump` from pinned versions with verified checksums, runs only on `schedule`/`workflow_dispatch` from `main`, and environment `backup` holds only the DB credential and the WIF identity for the bucket.
- **F-10:** a tripwire on the literal `/_test/` misses a route registered as prefix `'/api/_test'` plus `'/reset'`. Grep `dist/` for `_test` and for a sentinel string exported by the hooks module (for example `__SHOESTRING_TEST_HOOKS__`). The prod-image smoke 404 check covers the same gap at runtime.
- **F-11:** `revoke-sessions --all --notify-restore` keeps `email_change_cancel` tokens. After a restore, cancel tokens that were already used come back usable for the rest of their 24 h. In restore mode, delete them too (every user is emailed anyway).

### F-33 High (new, blocking): the cancel-token chain lets the attacker delete the victim's cancel link
- **Location:** auth.md:99–103 §9 step 3 ("every other open one-time token (**including other cancel tokens of the user**) is deleted"); api.openapi.yaml:464–495 `cancelEmailChange` description; data-model.md:98–99 (`user_tokens`).
- **Scenario:** the same attacker as in F-01: phished password, no MFA (R-1).
  1. The attacker signs in, re-authenticates, requests A → B (attacker mailbox) and confirms it with their own session. The victim's address A receives `cancel_A`.
  2. Still inside the re-auth window, the attacker requests B → C. The request immediately creates `cancel_B` (holding B) and emails it to B, which the attacker reads.
  3. The attacker calls `POST /auth/email-change/cancel {cancel_B}`. The pending B → C is cancelled, and "every other open one-time token, including other cancel tokens", is deleted. **`cancel_A` is gone.** The email stays B.
  4. The attacker signs in again, or resets the password through B. The victim's link now answers `TOKEN_INVALID`.

  The data-model note says cancel tokens are kept per change so that "a later change cannot replace an earlier victim's link". The cancel rule undoes that guarantee.
- **Required contract change:**
  1. Using a cancel token deletes only the user's cancel tokens **created after it**, the later links in the chain, never earlier ones. An earlier cancel always wins: using `cancel_A` reverts to A and deletes `cancel_B` and anything newer.
  2. While the user has any open `email_change_cancel` token, `POST /me/email-change` is refused with 429 `RATE_LIMITED` and a `Retry-After` until it expires. That is at most one email change per 24 h, so no chain can form. The caller is authenticated, so this reveals nothing.
  3. A cancel or revert emails both the restored address and the address reverted away from (deviation 2).
- **Test:** A → B confirmed, request B → C, use `cancel_B`, then `cancel_A` still reverts to A, revokes every session and deletes `cancel_B`. A second email change within 24 h answers 429.
- **Implements:** backend, data (ordering by `created_at`), tests.

### F-34 Medium (new, blocking): new-sign-in notice can be suppressed by the attacker
- **Location:** auth.md:259 §15 ("Skipped when the same browser and OS signed in to this account within the last 30 days, judged from `security_events`"). This came from my own optional de-noising suggestion in F-12, which I withdraw.
- **Scenario:** the vocabulary is coarse (7 browsers × 9 OSes), and most beta users sign in from Safari on iOS. A phisher who signs in from an iPhone, or who simply sends a Safari-on-iOS User-Agent (the attacker controls that header), triggers no notice. The main detective control behind the owner's acceptance of R-1 (OD-1: "the non-MFA mitigations from F-12 and F-13 still apply") becomes opt-out for the attacker.
- **Required contract change:** send the new-sign-in notice on **every** successful sign-in (password-only, or after MFA completion), with no skip rule. Noise is low by design: sessions last up to 90 days, so each user signs in a handful of times a year per device.
- **Implements:** backend, tests (e2e: a second sign-in with the same User-Agent still produces a notice).

### F-35 Low (new): deletion request and purge disagree about soft-deleted shared budgets
- **Location:** data-model.md:293 (the request refuses only for **non-deleted** owned budgets with other members) vs data-model.md:295 (the purge re-check counts owned budgets "deleted or not"); ADR-0010 item 2.
- **Scenario:** an owner soft-deletes a shared budget (members stay attached for the restore window), then requests account deletion, which is allowed. On purge day the re-check sees the deleted budget's members, skips the user and fails the run, so the owner is paged until step 2 hard-deletes that budget. Meanwhile nobody can restore it, because the only owner is pending deletion and pending-deletion accounts cannot call restore. In the phished-owner variant, the attacker deletes the shared budget and requests account deletion. The real owner can recover only by signing in, cancelling the deletion and restoring. They are notified (both notices are priority), so this is recoverable.
- **Recommended change:** use one rule for both checks. Recommended: the purge re-check counts only **non-deleted** owned budgets, and soft-deleted owned budgets are hard-deleted with the owner at purge. State that the restore window ends when the owner's account is purged, and include that in the "account deletion scheduled" email.
- **Implements:** data, backend.

### F-36 Low (new): deleted-budget routes sit outside the scope machinery
- **Location:** auth.md:145 §12 "Deleted budgets"; api.openapi.yaml:899–949 (`listDeletedBudgets`, `restoreDeletedBudget`, `x-budget-role: none`, path parameter `{deletedBudgetId}`); ADR-0010 item 2; ADR-0006 Consequences (the Semgrep ban on DAL functions that take a raw `budgetId`).
- **Issue:** these routes "check the owner role inside the handler". That requires a DAL call keyed by a raw budget ID, which is the pattern F-18's Semgrep rule bans. The route also escapes the startup check, which only keys on `{budgetId}`. Either the rule gets an ad-hoc exemption, or the check is hand-written, untested and skipped by the generated permission tests.
- **Recommended change:** add a second branded constructor in `db/`, `requireDeletedBudgetOwnership(userId, budgetId)`. It confirms an owner membership on a budget soft-deleted no more than 30 days ago, with a row lock, and returns a `DeletedBudgetScope` that only the list and restore DAL functions accept. List both routes in the generated permission tests (other user, current member, former member → 404) and in the isolation suite. The startup check treats `{deletedBudgetId}` like `{budgetId}`, except that it requires this constructor.
- **Implements:** data, backend, tests, ci (Semgrep allowlist).

## Clearance pass 2026-11-13: architect's round-3 calls
| Call | Ruling |
|---|---|
| One `APP_KEYRING` replacing `MFA_ENCRYPTION_KEY` and `THROTTLE_KEY`, HKDF subkeys, mounted on the service and `shoestring-rewrap-mfa` only, readyz fails on a missing key ID | **Accept.** Both old keys were mounted on the same service, so splitting them gave no isolation; HKDF keeps the uses cryptographically independent. Versioned rows, rewrap and a separate escrow vault are an improvement. Notes in the F-24 summary row (readyz must not name key IDs; a compromise-mode deletion of recovery codes). |
| `LIMIT_REACHED` (422) on restore when the owner already has 10 non-deleted budgets; only the owner is checked | **Accept the code and the owner check**, with the schema fix in F-37. |
| `x-budget-role: deleted_budget_owner` with `DeletedBudgetScope` (F-36) | **Accept.** It closes F-36 exactly as recommended. |

### F-37 Low (new, rev 3): restore can exceed other members' budget limit, breaking `BudgetList`
- **Location:** data-model.md:207 ("Other members are not checked; they may briefly exceed 10"); data-model.md:290; ADR-0010 item 2; api.openapi.yaml:2576–2584 (`BudgetList.items.maxItems: 10`).
- **Scenario:** soft-deleted budgets no longer count toward the limit. A member can therefore rejoin up to 10 live budgets while a deleted one is pending, and the owner's restore takes them to 11 or more. `GET /budgets` must then either violate its own schema (the contract response validation fails, possibly as a 500) or truncate, which silently hides one of that member's budgets. There is no confidentiality impact, but repeated delete and restore by a co-member's owner can keep someone over the limit.
- **Recommended change (non-blocking):** pick one.
  - (a) Raise `BudgetList.maxItems` to a stated hard bound (for example 20) and treat the limit as soft for restores. Restore refuses with `LIMIT_REACHED` if **any** member would exceed that hard bound, without saying which member.
  - (b) Return `GET /budgets` paginated.

  (a) is simpler.
- **Implements:** architect (schema), backend, tests.

## Ops review 2026-11-13: sre runbooks, backup job, bootstrap
Scope: deploy/backup/backup.sh; docs/runbooks/README.md (backup design and image spec), backup-missed.md, rotate-secret.md, restore.md, admin-commands.md, bootstrap-production.md, billing-protection.md §2, billing-alert.md; infra/hosting-evaluation.md §3a; infra/CLAUDE.md. This is a design review; no cloud resources exist.

| Item | Ruling |
|---|---|
| 1. Backup job | **Accept.** `set -Eeuo pipefail` catches a failing `pg_dump` inside the pipe. Only ciphertext touches the in-memory `/tmp`. The ERR trap logs a line number only. The metadata-server token is used and unset. Create-only upload with `ifGenerationMatch=0`, which matches `objectCreator`. The SA can read only the backup secret. The image is small and pinned, separate from the app, non-root. See F-39 for the deployer's reach. |
| 1. Heartbeat URL as plain env (**owner decision**) | **Accept.** A forged success ping only hides a failure; it cannot read, change or delete backups. Exploiting it also needs a second capability to stop backups (today the deployer has one: F-39). Monthly check #11 (billing-protection.md §11) independently confirms nightly executions from the job history. Keep the last Secret Manager slot free. |
| 2. Keyring rotation | **Accept**: three stages, no rollback after stage 1 (roll forward only), candidate-revision readyz gate (Host-exempt, so it works on the tagged `run.app` URL), stage 3 only at 0 rows, vault-B escrow with a hash compare. **The F-24 compromise mode is not covered** (F-38). Clipboard handling: F-40. |
| 3. Restore sequence | **Accept.** It matches the contract and adds two good steps: re-apply security actions taken after the restore point, and the BCC notice. Notes: verify grants after `roles.sql` (F-11 note); provenance check on the chosen object (F-39). |
| 4. Admin commands | **Accept.** The email goes in `--args` (R-12); two-step dry run, then `--yes --expect-user-id`; no retries; `security-events` IPs kept 30 days (R-6); `shoestring-admin` never mounts the keyring; the `reset-mfa` identity check matches the contract. Comma note in F-02. |
| 5. Bootstrap | **Accept, with one required edit** to the F-03 checklist (the passkey-sync account). Correct as written: DMARC `p=reject` and V26 as launch blockers; V34 measured and stated in the privacy notice; WIF pinned on repository ID, owner ID, `main` and the `production` environment subject; required reviewer on `production`; no GitHub secrets; per-secret IAM; Cloud Run request logs excluded (this removes most of R-5's IP/UA exposure). The keyring value never prints, but it does pass through the clipboard (F-40). |
| 6. Spend cap pauses Cloud Run, so backups stop (**owner decision**) | **Accept.** While the cap is tripped the site is down, so nothing new is written and the last pre-trip backup stays valid. The cap releases at the month boundary at the latest, so that backup is at most about 32 days old when backups resume, under the 34-day lifecycle. Moving the job into the backup project would put a DB credential and a runtime there, a worse trade. Two conditions: (a) billing-alert.md notes that **purge also stops**, so deletions and the 90-day audit purge slip by the pause length; run `purge` manually after lifting the cap, and the privacy notice says deletions can be delayed by outages. (b) Do **not** put a spend cap on the backup project's Cloud Storage (alert only): a paused bucket could make backups unreadable exactly when a restore is needed. |
| 7. Cloudflare fallback gate | **Accept the wording** (hosting-evaluation.md §3a and bootstrap step 15): nothing is switched on without a security-reviewer review recorded in docs/security/. The criteria for that review are written in advance in THREAT_MODEL.md §11, so an emergency review is quick. |

### Blocking item for the ops PR (exact change)
- **docs/runbooks/bootstrap-production.md §1 table:** add, as the second row, `| ☐ | Passkey sync account (Apple ID / iCloud Keychain, or the password manager if it stores passkeys) | Security keys or Advanced Data Protection with a recovery key; no SMS-only recovery; trusted phone numbers reviewed; recovery key offline | | |`. Without it, every "phishing-resistant" factor in the table is only as strong as that account's recovery path (for example, SIM-swap → SMS recovery).

### F-38 Low (new, ops): no compromise mode for recovery codes on a burned key
- **Location:** docs/runbooks/rotate-secret.md:106–110 (stage 2 only *asks* users to regenerate; stage 3 needs 0 rows); docs/contracts/admin-commands.md `rewrap-mfa`; data-model.md "Application keyring".
- **Scenario:** a keyring key is suspected compromised. Recovery-code HMACs under it cannot be rewrapped. Until every MFA user regenerates, the burned key must stay in the keyring (readyz blocks its removal), and with a DB copy those codes are brute-forceable offline. One unresponsive user keeps the burned key live indefinitely.
- **Recommended change:** add `rewrap-mfa --retire-recovery-codes <keyId> --yes` (contract: admin-commands.md; backend). It deletes recovery codes whose `key_id` is that key, records `recovery_codes_retired`, and emails the affected users "regenerate your recovery codes". Their TOTP or passkeys still work. The rotate-secret runbook uses it in the compromise branch before stage 3.

### F-39 Low (new, ops): the deployer can still reach the backup job; restore has no provenance check
- **Location:** docs/runbooks/bootstrap-production.md:72–82 (`roles/run.developer` granted **project-wide**); docs/runbooks/README.md:47 ("a compromised deploy can't redirect the dump"); restore.md:38–40 (newest object chosen by listing).
- **Scenario:** withholding `serviceAccountUser` stops the deployer from *updating* `shoestring-backup`. But project-level `run.developer` also includes reading, deleting and executing jobs, and (verify, new V35) executing **with overrides** (env and args), which may not require actAs. A compromised deploy identity could:
  - run the job with `BACKUP_AGE_RECIPIENT` and `BACKUP_BUCKET` overridden, sending a dump readable by the attacker to a bucket that accepts any authenticated writer;
  - point it at an attacker database, so a crafted "backup" lands in our bucket as the newest object and restore.md would choose it;
  - delete the job and fake the heartbeat (item 1).

  A compromised deployer can already deploy code with the `app` role, so the *incremental* harm is small. But the documented isolation is not real, and restore poisoning would survive a later clean-up.
- **Recommended change:**
  1. Grant the deployer `roles/run.developer` (or a custom role) **on resources**: the `shoestring` service and the migrate, purge, admin and rewrap-mfa jobs. Do not grant it on the project, so the backup job is out of its reach. Its project-level rights then shrink to what creating revisions needs (verify).
  2. restore.md step 2: before choosing an object, confirm that its `timeCreated` matches a **scheduled** `shoestring-backup` execution that succeeded (`gcloud run jobs executions list`), and that the size is in line with the neighbouring nights.
  3. Correct the README sentence once item 1 is done.

### F-40 Low (new, ops): operator handling of key material and restored data
- **Location:** bootstrap-production.md steps 7 and 9 (`age-keygen | pbcopy`, keyring via `pbcopy`/`pbpaste`); rotate-secret.md:84–94 and :127 (`NEWKEY` passed to `jq --arg`, escrow via `pbcopy`, hash compare via `pbpaste`); restore.md:43 (age key via `pbpaste` into a temp file, cleanup only at step 11); restore.md:93 ("optionally run the app locally against the drill database").
- **Issues:**
  - macOS **Universal Clipboard** (Handoff) syncs the clipboard to the owner's other Apple devices, and clipboard-history tools keep it. The keyring, the `age` private key and DB URLs then leave the Mac.
  - `jq --arg k "$NEWKEY"` puts the key in process arguments.
  - If the restore script stops early, the `age` key file stays on disk.
  - `make dev` against a copy of production data runs the dev entry. Test hooks register for `localhost` origins, so `/_test/login` and `/_test/reset` would act on real users' data.
- **Recommended change:**
  - Turn Handoff off (System Settings → General → AirDrop & Handoff) and pause any clipboard manager for bootstrap, rotation and restore. Better still, pipe secrets straight into the password manager's CLI instead of the clipboard.
  - Pass the new key to `jq` through `--rawfile` from a pipe or file descriptor rather than `--arg`.
  - restore.md: set `trap 'rm -f "$KEYFILE"' EXIT` right after `mktemp`.
  - restore.md drill: if the app is run against drill data, use the production entry (`node dist/server.js`, `NODE_ENV=production`, no `TEST_HOOKS`), never `make dev`. Delete the drill project the same day (as written).

## Data-layer review 2026-11-13: `feat/db-data-layer`
Scope: `db/migrations/` (2 migrations), `db/roles.sql`, `db/src/` (the DAL, `scope.ts`, the CLIs, seed, `@shoestring/db/testing`), the `pnpm-lock.yaml` additions, and the ci-engineer's in-progress Semgrep changes. `make check` passed (9 files, 117 tests). `make audit` passed: gitleaks clean, Semgrep 0 findings, zizmor clean. osv-scanner reported one advisory, minimatch 10.2.6 (GHSA-g3hv-75wg-m249, 6.9). It is new in the lockfile but reached only through eslint and typescript-eslint dev tooling, with globs from repo config, so it is not exploitable. Bump it when eslint allows `>=11.0.1`.

**Verdict: OK to merge.** No Critical or High findings. F-41 should be fixed before the backend starts importing `@shoestring/db`.

**Re-check 2026-11-13:** F-41 to F-44 are fixed and verified by reading the code and running `make audit` (Semgrep 0 findings). `make check` was not run in this pass; the coordinator is running it. Still OK to merge.

### What was checked and holds
- **Privilege model:**
  - `app` has DML only. On `security_events` it has INSERT and SELECT only; on `schema_migrations`, SELECT only. It has no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN, and EXECUTE only on `purge_security_events()`.
  - `backup` is SELECT-only. All three roles are NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS. `CREATE` on `public` is revoked from PUBLIC.
  - `roles.sql` checks this whole end state and fails the migrate run if anything differs, and tests cover it. That closes the F-11 note.
  - Exception: temporary objects (F-44).
- **`purge_security_events()`:**
  - Owned by `migrator`, SECURITY DEFINER, and verified as such.
  - `search_path = pg_catalog, public, pg_temp`: pg_catalog comes first, pg_temp is explicitly last, and `public` is not writable by `app` or PUBLIC (verified). The table name is schema-qualified.
  - It takes no arguments and uses the database clock (F-26, intentional). The dry run counts with the same clock. Accepted as is.
- **Cross-budget isolation:**
  - Every function that takes a `BudgetScope` calls `assertBudgetScope` or `lockBudget*`. Every sub-resource query filters on `scope.budgetId`, and child tables use composite FKs.
  - Functions keyed on user or invitation (`acceptInvitation`, export, `listDeletedBudgets`, `createBudget` replay) go through `requireMembership`, `requireDeletedBudgetOwnership` or an email match re-checked under a lock.
  - F-18 items 3 to 5 and 7 are implemented and tested: a foreign `categoryId` gets a 400 before any write, replays go through the scope, the export calls `requireMembership` for each budget, and the two-household suite has a coverage check.
  - The scope check is a WeakSet, so a forged object fails at runtime. The one gap is F-41.
- **Tokens and secrets:**
  - F-01: every listed revocation event calls `deleteOpenUserTokens`, which keeps cancel tokens. The exception is restore mode, which deletes them too.
  - F-33: cancelling deletes only later cancel tokens, using `(created_at, id) >` ordering. The reissued cancel token holds the pre-change address. A new change is refused while any cancel token is open. Confirming needs an active session of the same user.
  - Password hashes are limited to argon2id by a `CHECK`. Session, invite and user tokens are stored only as 32-byte hashes.
  - TOTP is stored as `key_id` plus ciphertext; the AAD and encryption are the backend's job. Recovery codes are stored as 32-byte HMACs with `key_id`.
  - The DAL never logs. Error messages are fixed strings. Driver errors propagate unchanged, so the F-07 serializer must handle them.
- **CSV export:** user-text columns get the `'` prefix for `= + - @ \t \r`. The database's `is_clean_text` also rejects leading whitespace and all control characters, so a leading tab, CR or LF cannot be stored anyway.
- **Purge (F-35):** the deletion request and the purge re-check share one function. Soft-deleted owned budgets are hard-deleted with the owner. A skipped user sets `failed`.
- **Migrate CLI:**
  - URLs reach dbmate through the environment, not argv. Output contains only fixed strings, roles.sql notices (role names and counts) and SQLSTATEs. A test checks that a refused admin URL is not echoed.
  - `sslmode=disable` is added only for local hostnames that have no `sslmode`. The host check can be bypassed, though: F-42.
- **Seed:**
  - Uses example.com addresses. Invite token hashes are deterministic but consumed in the same run. `SEED_USER_PASSWORD` is optional (12+ characters); without it the password is random.
  - It runs as `app` through the DAL and is never printed. The missing environment guard is F-43.
- **Supply chain:** no new install scripts (`onlyBuiltDependencies: []`, `strictDepBuilds`). dbmate ships as platform binary packages. The lockfile has integrity hashes.

### Rulings on the data-engineer's deviations
| # | Deviation | Ruling |
|---|---|---|
| 1 | `transaction_splits_category_fkey` is `NO ACTION DEFERRABLE INITIALLY DEFERRED` instead of `RESTRICT`; `deleteCategory` pre-checks splits and sets the constraint `IMMEDIATE` | **Accept.** Integrity is the same at commit, and the composite `(budget_id, category_id)` still makes a cross-budget reference impossible. A direct delete still fails at once, as the test shows. Residual: when a quick-add races a category delete, the **transaction create** now fails at COMMIT with a raw 23503 (a 500 whose detail holds only IDs), where before the category delete would have failed. Conditions: the backend's F-07 serializer test includes a commit-time 23503, and the architect updates data-model.md (it still says `RESTRICT`). |
| 2 | An expired pending invitation for the same email is **deleted** when the owner re-invites | **Accept.** No security effect: `budget_invitation_created` in `security_events` is the audit record, and the expired row conveyed nothing else. The architect should note it in data-model.md. |
| 3 | Transferring ownership to a member whose account is pending deletion returns `NOT_FOUND` | **Accept.** It fails closed. The owner learns no more than "that member can't take ownership", about a co-member they already see in the list. The architect should name the code in the OpenAPI description of the transfer endpoint. |

### Tooling changes under review
- **Semgrep exclusion of `shoestring-budget-scope-cast` (and the DeletedBudgetScope twin) for `/db/src/scope.ts` and `/db/src/isolation.test.ts`: accepted in principle.**
  - The scope.ts exclusion is narrowed again by `shoestring-scope-cast-outside-constructor`. I confirmed that it works on the `export async function` form: the cast at scope.ts:131 is not flagged. The isolation test needs the forged cast for its negative test.
  - Conditions:
    - The exclusions stay file-exact (no globs).
    - The narrowing rule stays.
    - F-41 is fixed, because the narrowing rule names `issueBudgetScope` as a legitimate constructor, which is the gap.
  - Preferred, not required: replace the file-level exclusion of `isolation.test.ts` with one inline `// nosemgrep: shoestring-budget-scope-cast` on the forging line, so the rest of that file stays checked.
- **ESLint relaxations** (`no-non-null-assertion`, `no-confusing-void-expression`, `require-await` off for `src/**/*.test.ts` and `src/test-support/**`): **acceptable.**
  - These are type-hygiene rules, not security rules. The security-relevant lint (`sql.raw`/`sql.lit` ban, `no-console` outside the CLIs) still applies to tests.
  - Both paths are excluded from the build.
  - Condition: never extend this override to `src/testing/**`. That is shipped code that the backend's dev hooks import.

### F-41 Medium (new, data layer): a BudgetScope can be minted outside `requireMembership`
- **Location:**
  - db/src/scope.ts:87–95 (`export function issueBudgetScope`). It is called only at scope.ts:83, despite the comment about create and join functions.
  - db/package.json `exports` (`.` and `./testing` only).
  - .github/semgrep/data-access.yml (`shoestring-sql-import-outside-db` matches only `import { sql } from "kysely"`). The narrowing rule's comment names `issueBudgetScope` as a constructor.
  - db/src/repos/common.ts:54 and :94 (`loadBudgetRecord(budgetId, userId)` and `loadMemberContacts(budgetId)` take a raw `budgetId`).
- **Scenario:** a backend handler needs a scope where `requireMembership` is awkward, such as a replay, a "switch budget" call or a notification fan-out. It does `import { issueBudgetScope } from "../../db/src/scope.ts"` and calls it with the `{budgetId}` from the path. A relative import is not blocked by the package `exports` map. Nothing flags it:
  - no cast is written, so the cast rules stay silent;
  - the scope is registered in the WeakSet, so `assertBudgetScope` passes;
  - the isolation suite only exercises the DAL.

  Any signed-in user can then read or change any budget whose ID they learn: IDs appear in invitation emails, URLs and exports of ex-members. The same relative-import path reaches `loadMemberContacts(budgetId)`, which returns members' **emails**, and `createKysely`. The contract's ban on Kysely `db` imports outside db/ is only half-implemented: `Kysely` itself is not matched.
- **Why Medium:** today nothing exploits it, but R-7 (no RLS) was accepted only on the condition that tooling, not review, enforces F-18. This is a gap in exactly that tooling.
- **Recommended fix:**
  1. data-engineer: make `issueBudgetScope` module-private (drop `export`, or inline it into `requireMembership`), and fix the comment.
  2. ci-engineer: outside `/db/**`, ban every import specifier that resolves into db internals, meaning any string matching `\bdb/(src|dist)/` other than the already-reviewed `testing` paths. Also ban any import from `"kysely"`, not just `{ sql }`. Add a rule that flags `issueBudgetScope(` outside `/db/src/scope.ts`, in case it is ever exported again.
  3. Update the narrowing rule's comment once item 1 is done.
- **Owner:** data-engineer (1), ci-engineer (2, 3).

### F-42 Low (new, data layer): local-host guards can be bypassed; no TLS check on the migrator URL
- **Location:** db/src/cli/migrate.ts:88–93 (admin URL check), :117–123 (`dbmateUrl`); db/src/testing/index.ts:17–25 (`assertLocal`).
- **Issue:** each guard checks `new URL(url).hostname`, but the drivers let a `host` query parameter override the authority. I confirmed that `pg-connection-string` turns `postgres://postgres:pw@localhost/db?host=prod.example.net` into host `prod.example.net`, and lib/pq treats query parameters the same way. A superuser URL that carries `?host=` therefore passes the "local only" check. `resetDatabase` would then TRUNCATE that server, and the role bootstrap would `ALTER ROLE … PASSWORD` there. Separately, a non-local `MIGRATOR_DATABASE_URL` without `sslmode=verify-full` is accepted: node-pg would connect without TLS and dbmate with unverified TLS. The server refuses this for `DATABASE_URL` (ARCHITECTURE.md "Config").
- **Plausibility:** this needs an operator-supplied URL, so it is defence in depth for an accident-prevention control. Neon refuses non-TLS connections, which limits the TLS half.
- **Recommended fix:**
  - Parse with the driver's own parser (`pg-connection-string`'s `parse`). Refuse any URL that has a `host` or `hostaddr` query parameter, or a resolved host outside the local set. Share one helper between the migrate CLI, the seed CLI (F-43) and `testing`.
  - In `main()`, refuse a non-local `MIGRATOR_DATABASE_URL` whose `sslmode` is not `verify-full`.
  - Add tests: a `?host=` URL is refused, and a non-local URL without `verify-full` is refused.
- **Owner:** data-engineer.

### F-43 Low (new, data layer): seed CLI has no environment guard and ships in the production image
- **Location:** db/src/cli/seed.ts:34–58; db/package.json `files` (`src`, `dist`); db/tsconfig.build.json (builds `dist/cli/seed.js`); Dockerfile `pnpm --filter ./backend deploy --prod` (copies `@shoestring/db` with those files).
- **Scenario:** an operator runs `node …/@shoestring/db/dist/cli/seed.js` against production, for example as a one-off job with an override, confusing it with `migrate`, or with `DATABASE_URL` pointed at production while `SEED_USER_PASSWORD` is set from the local `.env`. The seed then creates three active accounts with a password the operator's environment knows, one of them owning a "Demo household". They use example.com addresses, so no notification ever reaches anyone. That is a standing backdoor, invisible to the detective controls R-1 relies on.
- **Recommended fix:** the seed refuses to run unless `DATABASE_URL` resolves (F-42 helper) to a local or compose host, and `NODE_ENV !== "production"`. Also exclude `src/cli/seed.ts`, `src/seed/` and `src/testing/` from what ships. Two ways: a narrower `files` list, or ensure the image's db package carries only `dist` without seed (`tsconfig.build.json` exclude). Add a test that the seed refuses a non-local URL.
- **Owner:** data-engineer (ci-engineer if the Dockerfile has to change).

### F-44 Low (new, data layer): `app` can create temporary objects
- **Location:** db/roles.sql:55–67 (database grants; PUBLIC's default `CONNECT, TEMPORARY` on the database are never revoked); the verify block (no TEMPORARY check); db/src/migrations.test.ts:161 (`create table` is tested, `create temp table` is not).
- **Issue:** data-model.md "Roles" says `app` has no DDL. Through PUBLIC, it can still `CREATE TEMP TABLE` and `CREATE FUNCTION pg_temp.f()`. I found no escalation path: `purge_security_events()` pins `pg_temp` last, and functions are never looked up in pg_temp implicitly. It is still a contract deviation and extra surface for any SQL-injection foothold.
- **Recommended fix:** in the database-owner block, `REVOKE ALL ON DATABASE … FROM PUBLIC` (the explicit `CONNECT` grants to app and backup stay). In the verify block, fail if `has_database_privilege('app'|'backup', db, 'TEMPORARY')`. Add `create temp table` to the "DML only" test.
- **Owner:** data-engineer.

### Notes for the backend review (not findings)
- `completePasswordReset` trusts the caller to have verified MFA first (auth.md §8: reset never bypasses MFA). The backend test must prove that a reset for an MFA user without a factor gives `TOKEN_INVALID` or `MFA_REQUIRED`.
- `deleteSession(sessionId)` and `createSession({replacesSessionId})` do not filter by user. Pass them only IDs resolved from the caller's own cookie, and use `revokeSession(userId, id)` for `DELETE /me/sessions/{id}`.
- `updatePasswordHash` (rehash on login) has no F-01 side effects by design. Never use it for a password change.
- `transferOwnership` does not lock the target's user row. If a transfer races the target's own deletion request, the new owner can end up pending deletion. The purge re-check (F-35) catches this and fails the run, so it is safe. A `lockUser(target)` after the budget lock would close it earlier.

## Backend review 2026-11-14: `feat/backend-api`
Scope: all of backend/ (commit 9adc728 against `main`) and this branch's db/ changes. `make audit` passed (details in the report). Backend typecheck and 268 unit tests pass. `make check` currently fails only on shellcheck of `.github/scripts/lib.sh`, which ci-engineer is editing (uncommitted); it is not part of this branch.

### What was checked and holds
- **Pipeline order** (pipeline.ts, routes.ts) matches errors.md 0 to 10:
  - Host is checked before routing; only GET healthz and readyz are exempt.
  - The global limit runs before the session; CSRF and the writes limit come next, then pending deletion.
  - The JSON-only parser follows. I probed it: `application/jsonx`, `+json`, missing and `text/plain` types are all 415.
  - Then schema validation, the endpoint limit, membership (404), role (403) and re-auth.
  - `checkContract` refuses to start on a `{budgetId}` path that is not member or owner, and enforces `deleted_budget_owner` iff `{deletedBudgetId}`. An `/api` route without an op cannot be registered.
- **Non-member 404:** every member or owner route gets its scope only from `requireMembership`. The restore route gets it only from `requireDeletedBudgetOwnership`, and the DAL re-checks inside its own transaction. `removeMember` re-checks the role under the budget lock. Idempotent replays go back through `requireMembership`.
- **CSRF and cookies:**
  - Origin must match exactly; without Origin, `Sec-Fetch-Site: same-origin` is required.
  - The CSRF token is compared in constant time.
  - The cookie is `__Host-ss_sid` with `Secure; HttpOnly; SameSite=Strict; Path=/`, and `COOKIE_SECURE=false` is refused in production.
  - No CORS headers are sent.
- **Sessions:**
  - The token is 32 bytes and only its SHA-256 is stored.
  - The DAL filters expired rows. The sliding refresh runs hourly, capped by `absolute_expires_at`; pending sessions live 10 minutes.
  - Login, sign-up and MFA completion rotate the session. `completeMfaSession` is an atomic `DELETE … RETURNING`, so only one completion can win.
  - `deleteSession` and `replacesSessionId` are only ever given the ID resolved from the caller's own cookie (logout, login, sign-up). `DELETE /me/sessions/{id}` uses `revokeSession(userId, id)`.
- **Logging:**
  - The allowlist serializer has a pg fixture and a commit-time 23503 test (the data-layer deviation 1 condition is met).
  - There is one request line with the route template and opaque IDs, and no IP or user-agent.
  - The mailer logs kind and outcome only, and HIBP logs a metric only.
  - The console transport prints full mail, links included, but config refuses it in production for both the server and the admin CLI.
- **Test hooks:**
  - Only dev-server.ts imports them.
  - The guards are `TEST_HOOKS=1`, `NODE_ENV` development or test (config already refuses production), a localhost or `*.test` origin, and `DATABASE_ADMIN_URL`.
  - `NODE_ENV` is required and fails closed.
  - The sentinel is exported, and the dist tripwire matches `_test` as a word or the sentinel.
  - Residual: F-47.
- **TOTP:**
  - node:crypto only; AES-256-GCM with a 16-byte tag, a random 96-bit nonce, AAD = user ID and a per-row key ID.
  - The RFC 6238 vectors are tested. ±1 step is compared in constant time with no early exit.
  - Replay is rejected through `useTotpStep`.
- **Passkeys** (`@simplewebauthn/server@14.0.3`):
  - Exact RP ID and origin; the challenge is single-use and bound to the session or reset token and its purpose.
  - Credentials are restricted to the user's own.
  - The counter rule is the hand-written one: the library gets counter 0, then a regression is rejected unless the stored count is 0 and is recorded as `passkey_counter_regression`. Tested.
- **Recovery codes:** HMAC under the row's key and compared against every row (F-04 verified). The first-factor-only creation, the 409 on regeneration without a factor, and deletion with the last factor are all enforced in the DAL.
- **Password reset:**
  - The policy check comes before the factor, so a rejected password does not spend a factor.
  - A missing factor is 401 `MFA_REQUIRED` and nothing changes (test at recovery.test.ts:172).
  - Completion re-checks the token under `FOR UPDATE`, including the failure count.
  - The per-email login counters are cleared.
- **Email change:**
  - The request is padded to 1 s, with one change per 24 h (429).
  - Confirm needs the same user's active session and reissues the cancel link.
  - Cancel is public and emails both addresses.
  - The F-33 chain rule sits in the DAL (reviewed in the data-layer pass).
- **Other account flows:**
  - `/me/password` calls `dal.users.changePassword` (F-01 side effects) and never `updatePasswordHash`.
  - The account deletion request revokes everything and clears the cookie.
  - The CSV export prefixes user text that starts with `= + - @ TAB CR` and is served as an attachment with `nosniff`.
- **Admin CLI:**
  - Each command loads only the config it needs. The email budget's constant key is what lets `create-signup-invite` and `reset-mfa` run without `APP_KEYRING`.
  - Output is IDs, counts and DAL error codes only.
  - A comma in `--email` is rejected (exit 2) before any database access.
  - `--yes --expect-user-id` is required for `reset-mfa` and single-user `revoke-sessions`. `--restore` requires `--all`. The current key can't be retired.
- **Rate limits:**
  - Auth rows are in Postgres with HMAC keys. `hitThrottle` is an atomic upsert, so the `hitOrThrow` rows (login IP, sign-up IP, reset IP, email-change IP, export) are race-free.
  - The `assertUnder`-then-hit rows are not; that matters only for MFA (F-45).
  - Rotating the keyring's `current` key resets every auth counter, because keys are HMACs under the current key. Note for sre: rotate at a quiet time, and don't treat rotation as a way to clear a lockout.
- **Email budget deviation (constant key `SHA-256("email:daily\0app")` instead of an HMAC):** **accepted.** The key holds no PII, so an HMAC protects nothing. It lives in its own `scope`, so it cannot collide with HMAC keys. Unlike the HMAC keys it survives keyring rotation, which is better here. The check-then-hit race can overshoot the quota by the number of concurrent sends, which is negligible.
- **db/ race fixes:**
  - `transferOwnership` now locks the target user after the budget.
  - `requestAccountDeletion` re-checks shared ownership under the user lock (READ COMMITTED: the re-check is a new statement and sees the committed transfer).
  - Both orders are tested with lock-waiter gates.
- **`acceptInvitation` (data-engineer's question): not exploitable.**
  - Accept locks the budget row `FOR UPDATE` before it reads the owner's status.
  - The owner's deletion request starts with `lockOwnedBudgetsAndCheckShared`, which locks that same row. The purge re-check does too.
  - If accept goes first, the deletion's per-budget member query is a new statement, sees the new member and refuses with `OWNS_SHARED_BUDGET`. If the deletion goes first, accept reads `pending_deletion` and answers `INVITATION_INVALID`.
  - Nothing else changes an owner's status without that lock, so no fix is needed. Add a comment or test that pins the dependency: "the owner's status changes only under a lock on every budget they own".
- **Audit results:**
  - Semgrep `prototype-pollution-loop` at validation.ts:16 is a **false positive**: `valueAt` only reads, guards each step with `Object.hasOwn`, and never assigns. Suppress it inline (`// nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop` plus a reason) so the next warning stands out.
  - osv `glob@13.0.7` (GHSA-3g3m-2fjr-6pw4, abort signal ignored): this is a **production** dependency via `@fastify/static`, not dev-only. It is still **not exploitable**, because `@fastify/static` globs a fixed root once at startup and passes no signal.
  - `minimatch@10.2.6` (GHSA-g3hv-75wg-m249, pattern amplification): dev (eslint), plus `glob`'s fixed patterns. **Not exploitable.**
  - Bump both when releases pass the 7-day release age. `glob`'s fix is a major version (14.0.2), so it may need a pnpm override checked against `@fastify/static`.
- **Strict fake DAL in backend tests: adequate for the backend's own unit tests, and not a substitute for the cross-layer tests.**
  - The fakes do prove the route layer: it calls `requireMembership` or `requireDeletedBudgetOwnership` with the path ID before any handler, maps NOT_FOUND to 404 and FORBIDDEN to 403, follows the check order, and that handlers use the scope it hands them.
  - They cannot prove that the real DAL denies. The DAL's WeakSet, isolation suite and Semgrep cover that.
  - They also cannot prove the joint semantics: F-01 token deletion on each revocation event, the F-33 chain through the API, reset-without-factor against real tokens, and races such as F-45.
  - `tests/` is still empty. The contract-generated permission-matrix tests (auth.md §12, F-18, F-36) and the F-33 API regression test are what move F-18 and F-36 to verified, and they gate launch (R-7 condition), not this merge. Owner: test-engineer.

### F-45 Medium (new, backend): MFA failure limits can be overrun with parallel requests
- **Location:**
  - backend/src/services/mfa.ts:125–152 (`assertMfaBudget`, then `check`, then `rollingHit`).
  - backend/src/services/auth.ts:276–288 (pending-session failure recorded after the check).
  - backend/src/services/recovery.ts:131–142 (token failure recorded after the check).
  - backend/src/services/auth.ts:206–245 (reauth, same pattern).
- **Scenario:** the attacker has the password (R-1, the most likely attack) and the victim uses TOTP.
  1. They sign in once to get an `mfa_pending` session.
  2. They send about 120 `POST /auth/mfa/verify` requests in parallel, about the writes limit per instance per minute, and about 240 across two instances or a window edge.
  3. Every request runs `assertMfaBudget` (count 0 < 20) and `getTotpSecret` before any of them reaches `rollingHit` or `recordSessionMfaFailure`. The DB pool queues the requests FIFO, so all the reads land first.
  4. The request with the right code calls `useTotpStep` and then `completeMfaSession`. Those are queued with the failures' second round trip, before the failures' `recordSessionMfaFailure` deletes the session. So it signs in.
- **Effect:** one burst gives about 120–240 guesses where the design allows 5 per session and 20 per day. The burst then locks the budget for 24 h, so the rate becomes about 240 per day. That is roughly 7×10⁻⁴ per day (about 23% per year) against about 2% per year as designed. Recovery codes (about 2^52) are unaffected. The reset path has no writes limit, because there is no session; it is bounded only by 20 per hour per IP, so IP rotation helps there. Detective controls still fire (the `mfa_failures` and `mfa_locked` emails), which keeps this at Medium. It is my reading of the code, not reproduced.
- **Recommended fix:** reserve before checking, and refund on success.
  1. Per user: `rollingHit` first. If the new count is over 20, answer 429. On success, refund with `hitThrottle(key, window, -1)`; the `by` parameter already exists.
  2. Per session and per token: a DAL function that atomically increments `mfa_failed_attempts` only while it is below 5 and returns whether the attempt is allowed. Use one `UPDATE … WHERE mfa_failed_attempts < 5 RETURNING`, with a refund or reset on success. The kill switch then holds under concurrency.
  3. Apply the same pattern to reauth (5 per session per 15 min) and TOTP confirm.
  4. Add a test with a real database: 50 parallel wrong attempts on one pending session give exactly 5 `MFA_FAILED` and the rest 401 or 429, and the user budget never exceeds 20.
- **Owner:** backend-engineer (1, 3); data-engineer (2); test-engineer (4).

### F-46 Low (new, backend): in-memory limiter growth and per-request sweep
- **Location:** backend/src/http/rate-limit.ts:53–83 (`MemoryLimiter.hit` and `sweep`).
- **Scenario:**
  - Each new client key (an IPv4 address, or an IPv6 /64; a free tunnel /48 holds 65,536 of them) adds an entry. Entries are deleted only once they are a day old, although the window is one minute.
  - Past 10,000 entries, **every** `hit()` iterates the whole map and frees nothing.
  - About 12 requests per second from rotating /64s for a day gives about 1M entries. That is tens of milliseconds of synchronous CPU on every request, including legitimate ones, and hundreds of MB on a 512 MiB instance, ending in an OOM restart.
  - Rotating IPs already bypass per-IP limits; the amplification onto everyone else's requests is the new part.
- **Recommended fix:**
  - Store each entry's window and drop entries whose window has ended (`start + windowMs <= now`).
  - Sweep on a timer, or every N hits, instead of on every hit over the threshold.
  - Hard-cap the map (for example 50,000) by evicting the oldest.
  - Add a test that 20,000 distinct keys from one minute ago are freed.
- **Owner:** backend-engineer.

### F-47 Low (new, backend/ci): backend source, including the test hooks, ships in the production image
- **Location:** Dockerfile (committed version) `pnpm --filter ./backend deploy --prod --legacy --offline /out` with `COPY --from=build /out /app`; backend/package.json has no `files`. `npm pack --dry-run` lists `src/test-hooks.ts`, `src/dev-server.ts`, `src/test-support/*` and `scripts/*`.
- **Issue:** ADR-0009 and test-hooks.md promise the hooks are "physically absent" from the image, but the tripwire only scans `backend/dist`. Today this is not exploitable:
  - `node src/dev-server.ts` would fail to import `@shoestring/db/testing`, which is excluded from db's `files`.
  - Config refuses `TEST_HOOKS=1` in production.
  - The origin guard stays.

  Still, a later change that ships `db/src/testing`, or a hook that no longer needs it, would make the hooks one job-override (`--command`) away.
- **Recommended fix:**
  - ci-engineer's **uncommitted** Dockerfile change already copies only `package.json`, `dist` and `node_modules` into `/out`, and image-smoke asserts that allowlist. Merge it.
  - Belt and braces: `"files": ["dist"]` in backend/package.json (backend-engineer).
  - The image audit should grep the whole `/app`, not only `dist`, for the sentinel.
- **Owner:** ci-engineer (Dockerfile, image audit); backend-engineer (`files`).

### F-48 Low (new, backend): email defanging misses Unicode dots and bidi controls
- **Location:** backend/src/email/notifications.ts:23–39 (`safeUserText`); backend/src/http/validation.ts:95 (`text()` rejects only C0/C1 controls).
- **Scenario:**
  - A user (owner or co-member) names a budget, or sets their display name, to "Verify at shoestring-help。com".
  - U+3002 and U+FF0E are not replaced. Browsers map both to `.`; I checked with `new URL()`.
  - Clients that linkify Unicode domains, or a user who copies the text, reach the attacker's site from a genuine Shoestring priority email.
  - Bidi overrides (U+202A–U+202E, U+2066–U+2069) also pass both `text()` and `safeUserText`. They let a name render as different text in the mail and in the UI.
  - This needs a signed-in user (invite-only) and only affects mail to co-members.
- **Recommended fix:**
  - In `safeUserText`, NFKC-normalize first, then also replace U+3002, U+FF0E, U+FF61 and U+FE52, and strip U+200E, U+200F, U+202A–U+202E and U+2066–U+2069.
  - Architect: consider banning bidi controls in the data-model "Text" rule, so the UI is covered too.
- **Owner:** backend-engineer (architect for the text rule).

## Final pass 2026-11-14 (uncommitted tree against 9adc728)
Checked against the owner's rulings: fix F-45 in this PR; ban bidi controls at input as well as in mail; defer the restore race. `make audit` passed: Semgrep 0 findings; osv the same two moderates; gitleaks and zizmor clean. `make check` passes (db 141 tests in 12 files, including mfa-attempts and text-rule against Postgres; backend 283 tests). `make image-smoke` passed.

### F-45: fixed and verified
- **DAL**
  - `reserveSessionMfaAttempt` and `reserveTokenMfaAttempt` use one `UPDATE … WHERE mfa_failed_attempts < 5 AND open RETURNING`. Concurrent callers each re-evaluate after the other commits, so at most 5 checks ever run.
  - `fail*` deletes the row only once the count reaches 5 (`deleted`/`invalidated` is true for exactly one caller).
  - `release*` decrements and never goes below 0.
  - All of these refuse to run inside `dal.transaction`, because a rollback would refund the slot.
  - The 50-way tests on real Postgres pass.
- **Backend**
  - `verifySecondFactor` reserves the context slot, then charges the user budget first (hit, then sum).
  - The k-th concurrent charge sees at least k, so outstanding failures plus in-flight attempts can never exceed 20, and failures are never refunded.
  - Successes, refusals and errors refund both reservations into the window they were charged to.
  - `check()` returns false on every wrong-factor path: decrypt and verification errors are caught, and the TOTP length is fixed by the schema. So an attacker cannot turn a wrong guess into a refunded "error"; only DB failures throw.
  - Reauth (password and factor) and TOTP confirm now count the attempt first.
  - The `mfa_locked` notice is deduplicated with its own atomic counter.
- **Accepted trade-off:** in a parallel burst, the failure that brings the counter to 5 deletes the session or token while a correct attempt may still be in flight.
  - That attempt then gets 401 or `TOKEN_INVALID`, and its factor is consumed (a TOTP step, a passkey challenge, or a recovery code).
  - It fails closed, and only an attacker or a deliberate burst triggers it. A double-submitted single code uses 2 of the 5 slots and does not trigger it.
- **`completePasswordReset` without the count check:** correct and still cannot bypass MFA.
  - The 5th failure deletes the row, so a token with 5 real failures no longer exists.
  - The DAL still requires the token to be unused and unexpired, under `FOR UPDATE`.
  - The backend still requires a verified factor whenever `mfa.enabled`.
  - Enrolling a factor deletes open tokens (F-01), so the reset cannot complete with a stale "no MFA" read.

### F-46, F-47, F-48: fixed and verified
- **F-46**
  - Entries expire by window end. The sweep runs on an unref'd one-minute timer and never on a request. The map is capped at 50,000 by evicting the oldest.
  - Residual (accepted): with 50,000 or more distinct keys inside one window, eviction lets the evicted keys start again at zero. That is no worse than IP rotation already is. The F-45 fix no longer depends on the in-memory writes limit.
- **F-47**
  - Backend `files: ["dist"]`. The Dockerfile copies only package.json, dist and node_modules. The tripwire fails if an entry is missing or if grep errors.
  - `image-smoke.sh` scans all of /app for the sentinel with the image's own node, enforces the allowlist, checks the config refusals and probes `_test` (404).
  - Credentials reach containers as `-e NAME` only.
  - Caveat for ci-engineer, not a finding: `image_tag` reuses `<sha>-dirty` for any dirty tree. My smoke run reused an image built at 01:05, before the 09:13 backend edits. The structure checks are still valid, because that Dockerfile was in place; CI builds a clean tag per commit. Consider adding a tree hash to dirty tags.
- **F-48**
  - `text()` rejects U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069; ZWJ stays allowed.
  - Migration 20261114000100 adds the same rule to `is_clean_text`. It first refuses to run if existing rows would violate the rule, reporting counts only. Its down section is the original definition, which I diffed.
  - Mail text is NFKC-normalized first, bidi controls are stripped, and every dot look-alike becomes U+2E31, `/` becomes U+2215, `:` becomes U+02D0 and `@` becomes "(at)".
  - I checked that each replacement is NFKC-stable and that `new URL()` keeps the result as one punycode label: no dot and no path.

### Earlier image exposure (F-10, F-47)
- **Assessment:** the pre-fix image did contain `src/test-hooks.ts` and `src/dev-server.ts`, and Node 24 would start loading them. They could not have registered hooks, for three reasons:
  - The module graph needs `@shoestring/db/testing`, which db's `files` excludes.
  - The image sets `NODE_ENV=production`, under which config refuses `TEST_HOOKS=1`.
  - The origin guard requires a localhost or `.test` origin.

  Running it needed an operator override of both the command and the environment, and no image has been deployed yet.
- **Conclusion:** no exposure occurred, and the severity of F-10 and F-47 does not change. F-47 was exactly this gap and is now closed, and the image-level checks move F-10 to verified.

### Other fixes: verified
- `TRUST_PROXY_HOPS` must be at least 1 in production (config, plus the image-smoke refusal).
- Rolldown `UNRESOLVED_IMPORT` is fatal, so a silently externalized import can no longer crash the image at runtime.
- The inline `nosemgrep` with its reason is on validation.ts:19, and Semgrep now reports 0 findings.

### F-49 Low (new, deferred by the owner 2026-11-14): deleted-budget restore races the owner's deletion request
- **Location:** db/src/scope.ts `requireDeletedBudgetOwnership` (`u.status = 'active'` in the same statement as `FOR UPDATE OF b`); db/src/repos/budgets.ts `restoreDeletedBudget` (`lockUser(tx, id)` result not checked).
- **Scenario:**
  1. The owner (or someone holding their session) sends `POST /me/deleted-budgets/{id}/restore` at the same moment as `POST /me/deletion`.
  2. The deletion request locks every owned budget, including the soft-deleted one, and commits `pending_deletion`. The F-35 shared check ignores deleted budgets, so it succeeds.
  3. The restore was waiting on the budget lock. Under READ COMMITTED, the re-check after the wait re-reads only the locked `b` row. The joined `u.status` comes from the statement's original snapshot, so it still reads `active`.
  4. `lockUser` then returns `pending_deletion`, but nothing checks it, so the restore commits.
- **Effect:** a live budget, possibly shared, is owned by an account pending deletion, and its members regain access and get the restore notice. The daily purge then skips the user and fails its run (F-25), which alerts the owner, until the user cancels the deletion or ownership is fixed by hand. The race is self-inflicted (both requests come from the owner's own session), visible, and leaks no data.
- **Recommended fix:**
  - After `lockUser(tx, scope.userId)` in `restoreDeletedBudget`, require `status = 'active'`, else NOT_FOUND. This is the data-model.md lock-order rule.
  - Add a test in both orders with lock-waiter gates, like the transfer race tests.
- **Owner:** data-engineer. Status: deferred to a later PR by the owner (2026-11-14); fix before launch.
- **Fixed and verified 2026-11-16 (branch `fix/f49-restore-race`, on main 28cf5a1):**
  - **Fix.** db/src/repos/budgets.ts `restoreDeletedBudget` now locks every member's user row with `lockUser`, in ascending ID order after the budget row lock, *before* any limit check. It throws NOT_FOUND unless the owner's locked status is `active`. A missing owner row also gives NOT_FOUND, so it fails closed. `lockUser` is a separate `FOR UPDATE` statement on `users`, so its snapshot postdates any deletion request that committed while the restore waited.
  - **Lock order.** It holds, with no deadlock and no gap:
    - **Deletion first.** `requestAccountDeletion` locks every owned budget, *deleted ones included* (`lockOwnedBudgetsAndCheckShared` has no `deleted_at` filter on its `FOR UPDATE OF b`), then the user. The restore waits on the budget row, then sees `pending_deletion` and gets NOT_FOUND.
    - **Restore first.** The deletion request waits on the same budget row. After the wait, its separate shared-check statement sees the restored live, shared budget and returns OWNS_SHARED_BUDGET. `ownsSharedLiveBudget` after `lockUser` is a second net.
    - **Other members' deletion requests** never lock this budget (they lock only budgets they own), so a restore waiting on a member's user row cannot form a cycle.
    - **Everyone else** locks the budget before users, matching data-model.md.
  - **Leak check.** NOT_FOUND goes only to the owner's own session, about their own budget. It is already in the route's contract, and the same answer F-36 gives for every other non-restorable case. It reveals nothing new.
  - **Tests.** db/src/repos/budgets.test.ts runs both orders with gates and `waitForLockWaiters`, then asserts the end state: the member still gets 404 and the owner is `pending_deletion`, or the owner is `active` and the member is restored. The data-engineer's mutation check without the fix reproduces F-49.
  - **Sweep.** I agree with it for *status* reads: every other path that relies on a user's status reads it in a separate statement after its locks: after `lockUser` in `requestAccountDeletion` and `transferOwnership`, and after the budget lock in `acceptInvitation`, which the owner's deletion request also takes first. One related case is not a finding (Info). db/src/scope.ts `lockBudget` reads the caller's `m.role` in the same `FOR UPDATE OF b` statement, so after waiting on a concurrent transfer or removal that role can be stale. The only outcome is that the actor completes one action they were allowed to take an instant earlier:
    - a former owner's queued owner action, which is a self-race;
    - a just-removed member's queued `createCategory`.
    
    The one integrity break, an ownerless budget, is blocked by the deferred one-owner trigger at commit. Optional for data-engineer: re-read the role in a separate statement after the lock, to match the rule in data-model.md.

## Frontend review 2026-11-14: `feat/frontend` (commit 371b77c vs `main`)
Scope: the whole SPA (`frontend/`), the CSP change in backend/src/http/security-headers.ts, ARCHITECTURE "Security headers", and the already-merged PR #6 (db/src/repos/throttles.ts). `make audit` passes: gitleaks found no leaks (history and working tree), Semgrep found nothing, zizmor found nothing. osv-scanner reports only glob 13.0.7 and minimatch 10.2.6, both already ruled not exploitable. `make image` and `make image-smoke` pass on `shoestring:371b77c2be2b` (clean tree). I also ran the image by hand and probed the SPA responses.

### CSP style hashes: signed off
**Decision: sign-off given** for `style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='`, as the owner ruled.
- **The hashes are right.** I recomputed both from the shipped bundle (`/app/public/assets`), not from the test. `usePress` is `@layer { [data-react-aria-pressable] { touch-action: … } }`; `usePreventScroll` is `@layer { * { overscroll-behavior: contain; } }`. Both are fixed text with no interpolated data.
- **No other `<style>` source ships.** The only other `createElement('style')` in the bundle is React 19's `<style precedence>` hoisting, which the app never renders. Nothing uses `insertRule`, `adoptedStyleSheets` or `setAttribute('style')`.
- **Why it is safe.** An injected `<style>` matches a hash only if it holds that exact CSS, so injected markup cannot add attacker CSS (no CSS exfiltration). `'unsafe-hashes'` is absent, so `style="…"` attributes stay blocked. `script-src 'self'` is unchanged.
- **Guards hold.**
  - The backend test pins the directive and rejects `'unsafe-*'`, `'nonce-'`, `'strict-dynamic'` and a hash in any other directive.
  - Another test compares the backend hashes with frontend/src/security/csp.ts.
  - frontend/scripts/csp-style-hashes.test.ts recomputes the hashes from installed react-aria and react-aria-components.
  - If React Aria moves the injection to a package that test doesn't scan, it fails closed: the style is blocked and the UI breaks. It never fails open.
- **Every response carries it.** The header is set in the global `onRequest` hook (backend/src/http/pipeline.ts:117). On the built image, `/`, `/index.html`, a deep-link fallback, `/sw.js` and `/manifest.webmanifest` all carry the full CSP, HSTS, nosniff, XFO, COOP and CORP. A foreign `Host` gets 400 on SPA paths too. `/preview.html` returns 404. `/api/*` never falls back to index.html. The smoke script doesn't assert any of this: F-53.
- **Launch gates, not merge gates:**
  - the e2e `securitypolicyviolation` gate (C3.1);
  - the tests/ contract test that the backend `style-src` equals `style-src ` + `STYLE_SRC` (test-engineer);
  - `report-to` and the exact Sentry host once `SENTRY_DSN` is set (sre).

### What was checked and holds
- **CSRF token:** only in a module variable (src/api/session.ts). It is sent on POST, PUT, PATCH and DELETE only, replaced by every AuthState, and cleared on sign-out, 401 and bfcache restore. Requests use `credentials: "same-origin"` and `cache: "no-store"`. A unit test covers it.
- **Fragment tokens (F-06):**
  - The fragment is stripped with `replaceState` even when the token is malformed.
  - The token is format-checked and bound to the path it arrived on.
  - It is cleared after a successful use, and nothing persists it.
  - The service worker never sees the fragment.
  - The ordering guarantee is weaker than its comment says: F-50.
- **Return path:**
  - Memory only.
  - `safeReturnPath` rejects `//`, `/\`, schemes, controls and whitespace, then requires the same origin after URL parsing.
  - `navigate()` routes every target through it, and `pushState` cannot leave the origin anyway.
  - No `location.assign/href` sink takes data.
  - Unsafe targets go to `/`. Not an open redirect. One user-binding gap: F-54.
- **Auth guard and pending deletion:** auth routes need `signedIn`. An account pending deletion sees only the deletion screen on any auth route. Guest routes redirect signed-in users. The guard is UX only; the server enforces everything.
- **Re-auth:** every `x-reauth: true` operation the UI calls is wrapped (I compared against the OpenAPI list). The action is retried once, and a second `REAUTH_REQUIRED` propagates. The password stays in component state.
- **bfcache (F-32):**
  - `pageshow.persisted` clears the query cache and the CSRF token, sets `loading`, then re-checks.
  - Sign-out is only reachable from More, Sessions and the deletion screen, so a frozen document never shows a financial screen.
  - Account deletion and the reset/cancel flows use in-document `forget()`.
- **WebAuthn:** `@simplewebauthn/browser` is loaded lazily, server options are passed through, the browser enforces the RP ID, and cancels are handled.
- **TOTP QR:** drawn on the device as SVG paths from `uqr`'s matrix; no image URL and no third-party service. The secret and otpauth URI stay in component state, never in the query cache.
- **Recovery codes:** shown once from the confirm or regenerate response, held in component state, and dropped on Done or unmount. Copy and the `text/plain` blob download are user actions.
- **Storage:** localStorage holds only `shoestring.theme` (`light`/`dark`) and `shoestring.lastBudgetId` (UUID-validated on read and write). TanStack Query has no persister. Mutations never auto-retry. The lint gap is F-52.
- **Service worker:**
  - Shell only; the precache is fixed at build and never written at runtime.
  - `/api` and cross-origin requests are never intercepted.
  - Navigations are network-first, with a cached `index.html` only on network failure.
  - Old caches are deleted on activate; skip-waiting happens only on the Reload tap.
  - `updateViaCache: "none"`, and `sw.js`/`index.html` are `no-cache`.
  - check-dist fails on any `/api` path, `.map` file or missing file in the precache.
- **Stale code and CSP bypass.** Neither is possible while online:
  - Every online navigation gets the current deploy's `index.html`, with its CSP and asset names.
  - The new hashed assets aren't in an old worker's precache, so they come from the network.
  - An old worker only serves the offline fallback, and the cached `index.html` keeps the CSP headers it was cached with (Cache Storage stores headers).
  - A waiting worker activates when the user taps Reload or every client closes, so it is never stuck indefinitely.
- **XSS surface:**
  - There are no `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `eval` or `Function` sinks, and ESLint bans the first two.
  - Payee, memo, category, budget, display and passkey names render as React text.
  - `document.title` uses route titles only.
  - The only hrefs built from data are `/budgets/${id}` with server UUIDs. Route params are UUID-checked.
  - The CSV export is a blob with a fixed `download` name. Formula escaping is server-side (T35).
- **Production build:**
  - Only `index.html` is an entry.
  - check-dist flags preview files, the preview sentinel, `sourceMappingURL`, inline script or style, and unhashed assets.
  - On the image: 44 files under `/app/public`, 0 `.map`, 0 preview, no `sourceMappingURL`, no `VITE_*`, no key or DB URL patterns.
  - The only env read in client code is `import.meta.env.PROD`.
- **New dependencies:**
  - All are pinned exact, and the install needed no build scripts (`onlyBuiltDependencies: []` with `strictDepBuilds`).
  - The 7-day release age, `trustPolicy: no-downgrade` and `blockExoticSubdeps` are unchanged.
  - `playwright-core` is dev-only and uses a local Chrome.
  - No new advisories.

### PR #6 (merged): throttle refunds do not weaken F-45
- Charges still go through the single atomic upsert, so reserve-before-check is unchanged.
- Refunds (`by < 0`) are a plain `UPDATE … SET count = greatest(count + by, 0)` on the exact `(scope, key_hash, window_start)` and never insert. A refund into a cleared or purged window is a no-op, and the clamp means refunds can never bank credit below zero.
- Refunds still happen only on success, refusal or error, never on a wrong code.
- Before the fix, every refund raised 23514 and the request returned 500. That failed closed for limits, but it broke MFA sign-in. Now it works as designed.
- The new real-Postgres tests include the 50-way burst. **No change to F-45's verified status.**

### F-50 Low (new, frontend): the link-token capture does not run first in the built bundle
- **Location:**
  - frontend/src/main.tsx:1–2 and frontend/src/boot/capture-link-token.ts:1–6. The comment says it "runs before any other app module (error tracking included) is evaluated".
  - Built `assets/index-*.js`: the entry chunk statically imports shared chunks (`States-*`, `AppShell-*`, `useQuery-*` and others), and those evaluate first. For example, `States-*` runs `createApiClient()` (src/api/client.ts:84) at top level before `captureLinkToken` runs. Rolldown doesn't keep strict execution order across chunks.
  - Also: SignupScreen.tsx:32 (`queryKey: ["signup-preview", token]`) and ResetPasswordScreen.tsx:95 (`["reset-verify", token]`) copy the token into the query cache.
- **Scenario:**
  1. When Sentry is added (C16.3), `Sentry.init` may land in a module that ends up in a shared chunk, for example an `observability.ts` imported by both main.tsx and errors.ts.
  2. Init then runs while `location.hash` still holds `#token=…`.
  3. The pageload URL and the first navigation breadcrumb carry a live sign-up, reset or email-change token to a third party. Only the `beforeSend` scrub is left, and F-06 asked for two layers.
  
  Today nothing reads the hash before the capture, so there is no current exposure.
- **Recommended fix:**
  - Load the capture as its own first module script in index.html (`<script type="module" src="/src/boot/capture-link-token.ts">` before main). Module scripts run in document order, and the first one's graph finishes before the second starts. Alternatively, set rolldown `output.strictExecutionOrder: true`.
  - Add a check-dist assertion that the first module script in `dist/index.html` is the capture chunk, and that it imports only the link-token module.
  - Keep `Sentry.init` in main.tsx's body, after the imports.
  - Use fixed query keys with `gcTime: 0` for signup preview and reset verify, so the token lives in one place.
- **Owner:** frontend-engineer. Not blocking; fix before the Sentry integration.

### F-51 Low (new, frontend): sign-out reports success when the logout request fails
- **Location:** frontend/src/app/auth.tsx:129–137 (`catch {}`, then `clearAll()` and `location.replace("/signin")`).
- **Scenario:**
  1. On a shared phone, the user taps Sign out while offline or on a dropped connection.
  2. The logout `fetch` rejects, so the server session is not revoked, and the httpOnly cookie, which JavaScript can't clear, stays.
  3. The new document gets the cached shell and shows "Couldn't reach Shoestring", which looks like being signed out.
  4. Later, online, whoever opens the app is signed in as that user, with every shared budget readable for up to 30 days (sliding).
  
  Online with a 5xx, the boot check signs the user back in visibly, so the hidden case is the offline one. That is the F-32 shared-phone threat.
- **Recommended fix:**
  - Treat only a 2xx or a 401 `UNAUTHENTICATED` as signed out.
  - On any other failure, stay signed in, keep the screen, and show "Couldn't sign out. Check your connection and try again." Do not navigate.
  - Add a unit test with a rejected fetch and a 503.
- **Owner:** frontend-engineer. Not blocking; fix before launch.

### F-52 Low (new, frontend): the storage lint ban misses `window.*` and Cache Storage
- **Location:** frontend/eslint.config.js:56–72.
- **Problem:** `no-restricted-globals` reports references to the global *identifiers* `localStorage`, `sessionStorage` and `indexedDB`. It does not report property access such as `window.localStorage` (documented ESLint behaviour; ESLint points to `no-restricted-properties` for this). preferences.ts itself uses `window.localStorage`. Page-side `caches` (Cache Storage) is not listed at all.
  
  I could not run a probe file through the project's ESLint here (the scratch-copy run was not permitted, and the stdin run reported nothing for any input, so it proved nothing either way). The gap is based on the rule's documented semantics.
- **Scenario:** a later change persists a draft (payee, memo), a query result or a link token with `window.sessionStorage.setItem(…)` or `caches.open(…)`. `make check` stays green, and financial data lands on a shared phone, contrary to ADR-0002 and C3.4.
- **Recommended fix:**
  - Add `no-restricted-properties` for `window`, `globalThis` and `self` × `localStorage`, `sessionStorage`, `indexedDB`, `caches`, and for `document.cookie`.
  - Add `caches` to `no-restricted-globals`.
  - Exempt only src/lib/preferences.ts (localStorage) and sw/.
  - Add a lint fixture test that proves each form is rejected.
- **Owner:** frontend-engineer. Not blocking.

### F-53 Low (new, frontend/ci): image-smoke never checks the headers on the SPA document
- **Location:** .github/scripts/image-smoke.sh:182–187 (header loop on `/api/healthz` only), :199–202 (SPA checks assert status 200 only).
- **Scenario:** a later change serves the SPA another way, for example:
  - an encapsulated static plugin outside the pipeline hook;
  - a Cloudflare or static-host fallback;
  - a `reply.raw` send.
  
  `index.html` then ships without the CSP, and every check stays green. The JSON healthz response is where the CSP matters least, and the HTML document is where it matters most. I verified 371b77c by hand; nothing re-checks it.
- **Recommended fix:**
  - Run the same header loop against `GET /` with `Accept: text/html`, a deep link and `/sw.js`.
  - On the document, assert the exact `script-src 'self'` and the exact two-hash `style-src` directive.
  - test-engineer's C3.2 "every route" integration test should include a static route and the fallback.
- **Owner:** ci-engineer (smoke), test-engineer (C3.2). Not blocking.

### F-54 Low (new, frontend): the stashed draft and return path are not bound to the user
- **Location:** frontend/src/screens/budget/TransactionSheet.tsx:63–72 (`stashed`), :338; frontend/src/app/auth.tsx:157–163; frontend/src/lib/return-path.ts:28–40.
- **Scenario:**
  1. On a shared household phone, A's session expires or is revoked mid-entry. The quick-add draft (amount, payee, memo, category) is stashed, and A's path is remembered.
  2. B, a co-member, signs in in the same tab.
  3. B lands on A's path, and the sheet opens pre-filled with A's unsaved entry, which B can save as B's own.
  
  A non-member gets a 404, and the draft is discarded, but they learn A's last budget ID from the URL. The impact is low (co-members share the budget anyway), but unsaved text is shown to another person.
- **Recommended fix:**
  - Record `me.id` (from the last signed-in status) with the stash and the return path.
  - After sign-in, use them only if the new user matches; otherwise discard both.
  - Add a unit test with two users.
- **Owner:** frontend-engineer. Not blocking.

### Notes for the frontend-engineer (not security findings)
- PendingDeletionScreen has no export yet ("arrives in the next update"). auth.md §15 says the deletion screen offers "cancel deletion or export". Track it as a contract gap with the architect.
- `URL.revokeObjectURL(url)` right after `a.click()` (AccountScreen.tsx:208–213, SecurityScreen.tsx:97–104) can cancel the download in iOS Safari. Revoke it after a timeout instead.
- Tapping Reload activates the worker, and `clients.claim()` reloads *every* controlled tab through `controllerchange`. Unsaved input in other tabs is lost, against ADR-0002's "never reload on the person's behalf".
- Two concurrent `useReauth` calls overwrite `pendingRef`. The first promise never settles, so its spinner hangs.

## Test-suite review 2026-11-16: `feat/test-suite` (52a556a plus the uncommitted Phase B tree)
Scope: everything under tests/. ACCEPTANCE.md served as the index, and every claimed test was read against its finding or checklist item. `make audit` passes:
- gitleaks: history (22 commits) and working tree (574 files, including the untracked tests/ files and the 24 PNGs) are clean;
- Semgrep: 0 findings (audit.sh passes tests/ explicitly, untracked files included);
- osv-scanner: only glob 13.0.7 and minimatch 10.2.6, both already ruled not exploitable;
- zizmor: clean.

New dependencies are exact-pinned dev dependencies of `@shoestring/tests` only: `@playwright/test` 1.65.0 (matches the digest-pinned container), axe-core, fast-check, pg, ajv and yaml.

### Claims: verified
| Claim | Proof | Ruling |
|---|---|---|
| F-18 / C8.4 | `integration/isolation.test.ts`, the generated `permission-matrix.test.ts` | Verified. The HTTP half is in tests/; the DAL half is db's suite |
| F-36 / C8.9 | `permission-matrix.test.ts` "deleted-budget routes" | Verified |
| F-45 | `integration/security/f45-mfa-attempt-slots.test.ts` | Verified at the API (lock-held "in flight", not timing) |
| F-33 | `f33-email-change.test.ts` regression 1 and 2 | Verified; matches auth.md §9 |
| F-01 | `f33-email-change.test.ts` (attacker's revocation events, session-bound confirm), `password-reset-mfa.test.ts` (enrolment kills the open reset token) | Verified |
| F-34 | `notification-emails.test.ts` | Verified (same User-Agent each time) |
| Reset never bypasses MFA (auth.md §8) | `password-reset-mfa.test.ts`: a missing factor gets 401 and leaves the token usable; the policy check comes first and spends no slot; 5 failures kill the token; TOTP, recovery code and passkey from the token-bound challenge; sessions revoked | Verified |
| PR #6 regression | `mfa-success.test.ts`: TOTP confirm, MFA verify, recovery code, re-auth, passkey, all on real Postgres | Verified |
| F-23 / C3.1 | `headers-and-csp.test.ts` (drift), `e2e/csp-prod/csp-gate.spec.ts` | Verified; harden per F-55 |
| C3.2 (API half) | `headers-and-csp.test.ts`: 20 route classes plus 429 | API half verified; the document half is F-53 |
| C3.3 (dev half) | HttpOnly, SameSite=Strict, Path=/, 30-day Max-Age, no Domain; MFA-pending 600 s; logout Max-Age=0; tokens absent from bodies | Dev half verified; `Secure`/`__Host-` still need the image |
| C3.6 / F-06 (history half) | `sessions.spec.ts` and `j1-onboard.spec.ts` | Verified for reset, email-change undo and invite. Note: `history.length > 0` asserts nothing |
| F-48 | `f48-bidi-controls.test.ts` | Verified at the API |

### Claims: partial or downgraded
- **C3.4 (partial).** Storage is checked only after the overview and transactions screens are *read*. The plausible regression is a quick-add draft persisted to sessionStorage or localStorage on a failed save (see F-54), and no step covers it. Add J2 to the same assertion: a successful save, then a save that fails (route the request to a 500). With service workers blocked, the `caches` check proves nothing in e2e; the shell-only cache rests on frontend `check-dist` and RELEASE-CHECKLIST §2.
- **C3.5 / F-32 (downgraded).** See the F-32 row: the bfcache path is not proven.
- **F-09, F-21, F-22 (partial).** See their rows. F-21's core property (the (email, IP) key spares a victim on another IP) cannot be tested from a single loopback IP. Testing it needs the e2e stack to trust one proxy hop (`TRUST_PROXY_HOPS=1`), with the test setting `X-Forwarded-For`. That one stack setting also enables an F-08 test: forged leftmost XFF entries must not escape the per-IP limits.
- **F-08 (not tested in tests/).** The backend's unit test remains the only proof.

### Test infrastructure safety: holds
- **No production reach.**
  - Vitest's `global-setup.ts` aborts unless `POST /api/_test/reset` returns 204, and the hooks exist only in the dev entry with a localhost `APP_ORIGIN` (F-10, verified at image level).
  - Every Playwright test calls `resetStack()` in the page fixture before its body runs.
  - Pointed at production, the suites stop before any write *over HTTP*. The direct DB connections are the exception: F-56.
- **`prod-server.mjs` is test-only.**
  - It listens on 127.0.0.1 and serves only `tests/.prod-build` (path-normalised, `.map` refused).
  - It rewrites `Origin` only when it equals its own origin (`http://localhost:<port>`); any other Origin, a foreign one included, passes through unchanged and is refused by the backend.
  - The backend's Origin check is one function for every unsafe method (`backend/src/http/pipeline.ts`). The direct-API suites prove it on public endpoints (foreign Origin, absent Origin, and `Sec-Fetch-Site` cross-site vs same-origin; `check-order.test.ts`), the backend unit tests prove it everywhere, and the session-bearing calls are covered by the X-CSRF-Token tests.
  - So the rewrite cannot mask a CSRF gap. The suites that go through the proxy (csp-prod, visual) make no CSRF claims.
  - Optional hardening: one direct-API case with a valid session, a valid CSRF token and a foreign Origin, expecting 403.
- **Ignored files:** `tests/.prod-build/`, `playwright-report/` and `test-results/` are ignored by tests/.gitignore. `tests/.env.stack` (mode 600, throwaway credentials) is ignored by the root `.env.*` rule. All four were confirmed with `git check-ignore`.
- **CI failure artifacts** (public repo, 14 days) hold Playwright traces. These contain only synthetic data and the throwaway credentials of a CI stack that is torn down after the run. Acceptable.
- **Synthetic data only (C15.7):** every address in tests/ is `@example.test`, and names, payees and amounts are invented. Passwords and tokens are generated at run time. No key-shaped strings.
- **Visual baselines:** I viewed sign-in, overview, quick-add split and transactions on both devices and themes. They show only the fixed "Maple Street" household from `visual/screens.spec.ts` (Robin Visual, Corner market, Noodle bar, Payroll and so on) on a frozen clock. No email address or token is rendered.
- **axe exclusion:** `[data-live-announcer]` scopes out only React Aria's visually hidden announcer region (the same selector as frontend/src/test/axe.ts). axe and CSP are independent mechanisms, so the exclusion cannot hide a CSP violation; it can hide an a11y issue only inside library-owned markup. Accepted.
- **Visual-suite discard:** `snap()` fails on any violation recorded before the screenshot, then clears the list. It runs only in `playwright.visual.config.ts` (testDir `visual/`), never in the e2e CSP gate, so it cannot hide anything there. Within the visual suite it would also swallow a real app violation fired *during* `toHaveScreenshot`'s stability loop. The window is narrow; F-55 recommends a filter.
- **RELEASE-CHECKLIST.md** has the owner use a throwaway budget with made-up amounts on the deployed site. Fine.

### BUG-1: GET ignores request bodies. Not a security issue
`contract/routes.test.ts` pins this with `it.fails`. Fastify does not parse GET bodies, so no handler ever sees them. Node's HTTP parser still frames the message by `Content-Length`/chunking, so there is no desync or smuggling path, and Cloud Run's front end normalises framing anyway. GET never changes state, and browsers cannot send a GET body, so the 415 rule (a CSRF control for unsafe methods) is not bypassed. The body is not reflected or cached (`no-store`). **Severity: none (contract deviation only).** Recommendation for the architect: amend the contract to exempt GET and HEAD from the body rules. That is cheaper than adding a backend check, and either choice is fine for security.

### F-55 Low (new, tests): the CSP gate loses violations across navigations, and the visual suite clears them all
- **Location:**
  - tests/e2e/fixtures.ts:46–59 (an init script resets `window.__cspViolations` in every new document; teardown reads only the last one);
  - tests/e2e/csp-prod/csp-gate.spec.ts:60–89 (`goto('/signin')`, then `goto('/budgets/…')` for the quick-add sheet, then `goto('/budgets/…/transactions')`);
  - tests/visual/screens.spec.ts:27–34.
- **Scenario:**
  1. A future change breaks a style hash or adds a `<style>` only on the quick-add sheet or the sign-in page, for example a new React Aria component or a Sentry feedback widget.
  2. The production page loses that style, a functional break the CSP correctly blocks.
  3. The gate test still passes: it navigates to the transactions page before teardown, so the violation from the previous document is never read.

  Today both hashes are still exercised on the last page (the TransactionSheet modal triggers usePress, and on iOS usePreventScroll), so nothing is hidden *now*. The gate's coverage is accidental, though, and ACCEPTANCE.md's "every e2e test fails on a violation" is vacuous for the journeys: the Vite dev server sends no CSP.
- **Recommended fix (test-engineer):**
  - Collect violations outside the page: in the fixture, `page.exposeBinding('__cspViolation', …)` pushes each one into a Node-side array that survives navigations. Assert that array at teardown.
  - In `snap()`, drop only violations whose `sample` matches Playwright's own injected style (its caret/animation rules), not the whole list.
  - Reword ACCEPTANCE.md so the gate is credited to the csp-prod and visual projects only.
- **Owner:** test-engineer. Not blocking.

### F-56 Low (new, tests): no local-only guard on the test suites' database URLs
- **Location:** tests/support/env.ts:33–35 and 61–63; tests/support/dal.ts:13–18; tests/support/db-locks.ts:15–40.
- **Scenario:**
  1. The owner's shell has `DATABASE_URL` exported for something else. Neon is reachable from the internet, and the restore drill passes a URL by hand (docs/runbooks/restore.md:112).
  2. The owner runs one suite against a running local stack (`pnpm --filter ./tests run api …`).
  3. `env.ts` merges `{ ...stackFile, ...process.env }`, so the exported URL beats `tests/.env.stack`.
  4. The global setup succeeds against the *local* backend's hooks.
  5. The factories then insert synthetic users, budgets and transactions into the *other* database as `app`, and `adminQuery`/`holdExclusiveLock` would do the same with an exported `DATABASE_ADMIN_URL`. `LOCK TABLE auth_throttles IN EXCLUSIVE MODE` on a live database blocks every sign-in until it is released.

  No data is read out, which keeps this Low, but it is the one path from tests/ to a non-local database. db/ already has the right guard (F-42): `assertLocalDatabaseUrl` in db/src/conn.ts. It is used by migrate, seed and `@shoestring/db/testing`, but not here.
- **Recommended fix:**
  - test-engineer: in `env.ts`, run both DB URLs through that guard (pg's own parser, so `?host=` cannot bypass it). Require `APP_ORIGIN`, `API_URL` and `BASE_URL` to be http on localhost or 127.0.0.1.
  - test-engineer: when `APP_ORIGIN` is not exported, take the whole stack file, not a merge with stray process variables.
  - data-engineer: export `assertLocalDatabaseUrl` from `@shoestring/db/testing`, or add a `local-url` sub-export, so tests/ never imports `db/src` relatively.
- **Owner:** test-engineer, with data-engineer for the export. Not blocking; fix before launch.

### Notes for test-engineer (not security findings)
- `mfa-success.test.ts` "a challenge is single-use" never uses the assertion first. It proves an assertion is bound to its session's challenge, not that the challenge is single-use. Rename it, or add a true replay on the same session.
- The 429 loop in `headers-and-csp.test.ts` (`while (res.status !== 429)`) has no bound. If the limiter breaks, the test fails only at the Vitest timeout, so cap it the way `routes.test.ts` does (310).


## Hardening review 2026-11-16: `fix/pre-launch-hardening` (uncommitted tree on 48bbf3c)
Scope: the whole `git diff HEAD` plus the untracked files: the contract (`MFA_REQUIRED` on reauthenticate and completePasswordReset), frontend F-51/F-52/F-54 and extras, ci F-53, the e2e topology, the backend race fixes, the db explain test and the new tests. Also re-checked: F-32, F-55 and F-56 from #13.

**Verdict: approve with follow-ups.** No Critical or High findings. Nothing in this diff can leak financial data between budgets or into logs. The only new log line is the mailer's "dropped" warning, which carries `kind` and `outcome`, never an address.

`make audit`: I did not run it, because the tech lead was running it at the same time and both runs write `.audit/`. The reports on disk (11:57) predate the backend edits (13:23–13:38), so the tech lead's current run is the authoritative one. The 11:57 run showed: Semgrep 0 findings (2 partial-parse warnings, Dockerfile:52 and db/src/index.ts:49); osv only minimatch 10.2.6 GHSA-g3hv-75wg-m249 (dev-only, already ruled not exploitable); zizmor clean. A manual secret-pattern grep over the diff and the untracked files found nothing.

### Closures
| Finding | Ruling | Evidence |
|---|---|---|
| F-51 | verified | auth.tsx `signOut`; SignOutButton; SessionsScreen `revoked: true` only after the session's own DELETE succeeded; `auth.test.tsx`; e2e `sessions.spec.ts` (offline, then 503, then a retry whose old cookie gets 401 on the server) |
| F-52 | verified | eslint.config.js `STORAGE_BAN`; one `eslint-disable-next-line` in preferences.ts; fixture test 29/29 (run by me). The service worker's `caches` use is outside the ban's scope by design |
| F-53 | verified (CI image-smoke) | image-smoke.sh `check_headers` on healthz, `/`, a deep link and `/sw.js`; exact directives; hashes read from csp.ts with an exactly-two guard |
| F-54 | verified | draft-stash.ts, return-path.ts, auth.tsx `enter()`; unit tests for both users |
| F-08 | verified; **V26 open** | `f08-client-ip.test.ts` through the e2e edge. Production correctness depends on Cloud Run appending exactly one entry (V26), which sre sets in the pre-deploy pass |
| F-09 | verified (app); alert with sre | `f09-reset-request-limits.test.ts`; F-57 makes the limits race-safe |
| F-21 | verified | `f21-login-lockout.test.ts` ((email, IP) key, /64, a reset clears both counters). Concurrency residual: F-58 |
| F-22 | verified | `f22-enumeration-timing.test.ts` (reset and email-change requests), `invitations.test.ts` (invite create) |
| F-32 | verified | #13: `csp-prod/sign-out-back.spec.ts` asserts `pageshow.persisted === true` on the production build (Chromium) |
| F-55 | verified | #13: Node-side `exposeBinding` collector; `snap()` drops only Playwright's own style |
| F-56 | verified | #13: db-env.ts uses `parseDatabaseUrl`; env-guards.ts uses the stack file whole and makes conflicts an error |
| C3.4 | done | J2 added: storage is checked with an open unsaved draft and after a save. The failed-save case I suggested is not tested, but the F-52 ban now blocks the storage write it would catch, and the draft stash is memory-only |

### Checked and holding
- **Enumeration (requestPasswordReset).** The route still wraps the service in `try { … return 202 } finally { padUntil }`, so every branch, including a refusal, the unknown-address return and a thrown DB error, answers at the fixed 1 s. The per-address counters key on the submitted string, so they behave the same for addresses with and without accounts, and refusals refund identically.
- **Enumeration (email change and invitations).** `email_taken` and `created` both keep their slot and both answer 202. A refund happens only on refusals the caller already sees (400 own address, the DAL's 429, 429 caps). Invitation refunds on `ALREADY_EXISTS`/`LIMIT_REACHED` reveal nothing beyond what the contract already returns to the budget's owner. Reservations happen only after the scope (membership) and re-auth checks, so a non-member still cannot spend another budget's quota (the read-only pre-checks keep the 429 at errors.md step 7).
- **Reserve-first correctness.** Fixed windows use the atomic upsert's returned count, so N concurrent callers see distinct counts and at most `limit` pass. `reserveRolling` is upsert-then-sum, two statements. Concurrent callers can both see the higher sum and both refuse, but never both pass: it fails closed, which at worst delays a legitimate request when the address is already being flooded. Refunds go to the reservation's own window and clamp at 0 (DB and now the fake). A failed refund only over-counts.
- **Mailer.** At most `quota` sends pass (`over(slot.count - 1)`), and bulk mail never exceeds the 60% soft limit. Priority mail can still take the remaining slots during a bulk burst, because over-limit bulk reservations are refunded. A store error returns `failed` without sending (fails closed).
- **e2e edge proxy (test-only).** `.github/scripts/e2e-edge.mjs` is mounted only by docker-compose.test.yml (`profiles: [backend]`, ports bound to 127.0.0.1). `.github` is in .dockerignore, and the production Dockerfile copies only `/out` and `/public`. The backend has no knowledge of `X-E2E-Client-IP` (the header appears nowhere in backend/src), and docker-compose.yml (dev) still takes `TRUST_PROXY_HOPS` from the environment, defaulting to unset. Nothing in deploy/ or infra/ references either. So the spoofing primitive cannot reach production. The edge appends rather than replaces, validates the override with `net.isIP`, strips it, and drops hop-by-hop headers. Both e2e paths (API direct and browser through Vite's non-xfwd proxy) leave the edge's entry rightmost.
- **Contract.** `MFA_REQUIRED` added to the two operations whose errors.md prose already named it. The oracle now derives prose codes from errors.md instead of a side list. No behaviour change.
- **ResetPasswordScreen MFA fallback.** It only re-fetches the token check and shows the MFA step; the server still enforces MFA on complete (auth.md §8, `password-reset-mfa.test.ts`).
- **Shared re-auth prompt.** Two concurrent `REAUTH_REQUIRED` actions now share one prompt. Both were started by the user, and the server's re-auth window would let the second through without a prompt anyway, so this grants nothing new.
- **PendingDeletionScreen export.** `exportMyData` is `x-pending-deletion-allowed` and `x-reauth` in the contract (auth.md §11). Same endpoint, same scope.
- **saveBlob.** The object URL lives for 60 s in the same document only. Sign-out replaces the document, which revokes it.
- **CSRF.** New `check-order.test.ts` case: a valid session and X-CSRF-Token with a foreign, port-less, `null` or absent Origin (or cross-site/same-site `Sec-Fetch-Site`) gets 403 and writes nothing. This closes the optional hardening from the test-suite review.
- **CI.** Dirty image tags hash the diff and untracked non-ignored files (`.env*` are ignored, and the output is a 48-bit digest), and nothing is written to .git. `make e2e-up` writes tests/.env.stack with umask 077; `make e2e-down` deletes it. Dependabot's TypeScript-major ignore follows the owner ruling.

### F-57 Medium (new, fixed in this PR): read-then-increment limits beyond MFA
- **Location (before the fix):**
  - backend/src/services/recovery.ts `requestPasswordReset` (`count`/`rollingCount`, then `hit`/`rollingHit`);
  - backend/src/email/mailer.ts `send` (`count`, then `hit` after the decision);
  - backend/src/services/budgets.ts `createInvitation` (`hit` after the DAL insert, pre-check only via `assertUnder`);
  - backend/src/services/recovery.ts `requestEmailChange` (`hit` after the DAL call).
- **Scenario:**
  1. An attacker with many source addresses (IPv6 /64s are cheap) sends a burst of password-reset requests for every known user address.
  2. All requests read the per-address counter before any of them increments it. Each passes "3 per hour", and each reserves an email under a daily budget check that is itself read-then-write.
  3. The burst sends more than 60 mails in a day, exceeding the Resend free quota. Security notices, the R-1 detective control, then fail for everyone, and the provider may suspend the account (the F-09 scenario, which the limits were meant to stop).
  
  The same pattern let a member's parallel invites pass the 20-per-budget cap, and a user's parallel email-change requests mail more than 5 addresses a day.
- **Fix (done):** reserve with the atomic upsert, compare the returned count, refund on refusal (`Throttles.refundOnError`, `releaseAll`). The read-only pre-checks stay only to keep the 429 at errors.md step 7 and to avoid writes once a limit is spent.
- **Verified:** backend concurrency tests (12 parallel resets from 12 IPs send at most 3 mails, all 202s byte-identical; 25 parallel invites create at most 20; mixed mail bursts never pass the quota or 60% for bulk; 10 parallel email changes mail at most 5; refusals hold no slot). These run against the fake DAL, which now clamps like the DB. The atomic upsert itself is proven on real Postgres by the F-45 suites.
- **Note for test-engineer:** tests/integration/security/f09-reset-request-limits.test.ts:6–9 still says "the backend reads the count, then adds to it". Update the comment. An optional API-level burst test would prove F-57 end to end.
- **Owner:** backend-engineer.

### F-58 Low (new, open): login failure counters check before they increment, and the lock notice can be skipped
- **Location:** backend/src/services/auth.ts:47–48 (`assertUnder(k.pair)`, `rollingCount(k.email)` at errors.md step 7), :77–78 (`hit`, `rollingHit` after the argon2 verify), :84 (`failures === LOGIN_EMAIL_FAILURES`).
- **Scenario A (overshoot, accepted for launch):** a burst passes the pair and email checks before any failure is recorded.
  - The pair limit (10 per 15 min) is capped by the atomic per-IP `hitOrThrow` (20 per 15 min), so it overshoots by at most 10 per IP.
  - The per-email ceiling (100 per 24 h) can be overshot only by requests that are between the check and the hit at the moment of crossing. That window is the argon2 semaphore: 4 concurrent per instance, at most 2 instances, a 2 s queue and then 503 (no guess made). So one burst adds roughly a few dozen to about a hundred guesses, and only with dozens of /64s each spending its 20-per-15-minute IP budget. After the crossing every later request is refused.
  - Net effect: worst case about 2× the intended 100 online guesses per account per day. That does not change the password-guessing picture under R-1.
- **Scenario B (detective control skipped):**
  1. An attacker who has guessed close to 100 failures for a victim sends the next few concurrently.
  2. Two failures interleave as hit, hit, sum, sum: both read 101, neither equals 100, and `login_throttled` is never sent.
  3. The account is locked silently. The victim gets no warning that someone is guessing their password, which is the notice R-1 relies on (F-21's "429 **and** a notification email").
- **Recommended fix:**
  - **Before launch (small):** send the notice when `failures >= LOGIN_EMAIL_FAILURES` and a one-shot reservation `throttles.reserve(key("login:throttled_notice", userId), DAY)` returns `count === 1`. This is the pattern mfa.ts:219–225 already uses for `mfa_locked`. Add a unit test with two concurrent failures at 99.
  - **Later (optional):** make both failure counters reserve-first: reserve before the verify and refund on success, accepting the same trade-off ruled for F-45 (a correct password racing the crossing failure is refused).
- **Owner:** backend-engineer. Not blocking the PR; the notice fix is a launch item.

### Follow-ups (not findings)
- **Still before launch, outside this PR:** F-49 (restore race; owner-deferred; **fixed and verified 2026-11-16 on `fix/f49-restore-race`**), F-58 notice (fixed in #14), V26 / `TRUST_PROXY_HOPS=1` on Cloud Run (F-08), F-27 (SECURITY.md), F-39, F-03 (owner), branch protection. F-50 goes with the Sentry PR.
- **Owner question (4), the F-22 slow-mailer hook:** not needed. The pad floor plus the mailer's timeout unit test cover it, and a new hook would widen the test-hook surface (ADR-0009) for little gain.
- **Owner question (5), the login counters:** see F-58. Convert later; fix only the notice now.

### Follow-up re-review 2026-11-16 (PR #14, uncommitted follow-ups)
- **F-58 notice: resolved and verified.** backend/src/services/auth.ts:84–92. The trigger is now `>=`, so a burst that jumps past 100 still qualifies, and the one-shot `login:throttled_notice` reservation (HMAC-keyed by user ID, fixed UTC day) lets exactly one concurrent crosser send. auth.test.ts covers two concurrent failures at 99 (a count of 101 gives one notice), further failures and a re-lockout the same UTC day (no repeat), and the next UTC day (a new notice). The extra write happens only on failures at or above 100, and locked requests are refused at step 7 before reaching it.
  - Accepted behaviour change: a second lockout on the same UTC day is not announced. auth.md §14 and §15 say "when the limit is reached", which this satisfies.
  - Residual, accepted: a successful reset clears `login:email_day` but not the notice key. A renewed attack later the same UTC day therefore locks the account silently, but the user was already told that day, and the lock still fails closed.
  - Converting the counters to reserve-first is owner-deferred. The overshoot ruling above stands.
- **CodeQL #6 (js/remote-property-injection, .github/scripts/e2e-edge.mjs): not a finding (Info). Fixed anyway.**
  - Why not exploitable: before the fix, `out[k] = v` used client header names as keys on a plain object. Assigning a string to `__proto__` is a no-op, and `constructor` or `prototype` would only shadow a key on that one object. The process is a test-only proxy on 127.0.0.1, in docker-compose.test.yml only, and never in an image (T125).
  - The fix holds:
    - Headers travel as flat raw arrays and are never used as object keys.
    - `safeName` accepts only RFC 9110 tokens and drops `__proto__`, `constructor` and `prototype`.
    - `FIELD_VALUE` drops values with CR, LF, NUL or other controls, which also closes CRLF injection into the hand-built upgrade request line.
    - The status is clamped to 100–599, else 502.
    - X-Forwarded-For is still the client's own lines joined in order plus exactly one appended entry, and the override header is still stripped.
  - Nit (ci-engineer, optional): if the joined X-Forwarded-For ever failed `FIELD_VALUE`, the header would be dropped. The backend would then fall back to the edge's socket address instead of failing closed. Node's parser already rejects such values, so this is unreachable today; answering 400 there would make it explicit.
- **Docs:** ARCHITECTURE now records the F-51 rule and names the EXPLAIN row-count check as the p95 guard; both match the code. The checklist C3.5 remark is corrected (the `pageshow` rule is in ARCHITECTURE line 99).

## Loading tap-targets review 2026-11-16: `fix/loading-tap-targets` (uncommitted, on main 28cf5a1)
UX-only frontend change. **No findings; approve.**
- **Device storage (F-52, F-54 hold):** the diff adds no storage, cookie or Cache Storage use. The draft is still stashed only in memory, as `stashDraft(budgetId, me.id, …)`, and only after a save attempt. Save is blocked until the budget, categories and recent list are ready, so a sheet opened during loading cannot stash a draft without a date or budget.
- **404 while the sheet is open:** BudgetLayout returns `NotFoundScreen` before rendering the sheet, so the sheet unmounts and its state is dropped. Reads give non-members 404, never 403. Other budget errors show only "Couldn't load this budget" with a retry, and no data.
- **No cross-budget state:** every route mounts `<BudgetLayout key={id}>`, so the sheet, the draft and the frozen chip order cannot carry over to another budget. The prefetch uses the sheet's own key `["budget", budgetId, "transactions", {month, categoryId: null}, 50]`. It is disabled until that budget's `currentMonth` is known, and the query cache is still cleared at sign-out and on 401.
- **CSP and third parties:** no new origins, `<style>` elements, inline styles or HTML sinks.
- **Note, not a finding (frontend-engineer):** /more now renders Sign out only after `useBudgets` settles. With TanStack's default `networkMode: 'online'`, a phone that reports offline with no cached budget list sees a loader and no Sign out, so it never gets F-51's "Couldn't sign out" message. Nothing claims a false sign-out, and an offline sign-out can't succeed anyway, so there's no exposure. Consider showing Sign out while the list is pending too, for example in a fixed position.

## Sentry integration review 2026-11-17: `feat/sentry` (uncommitted tree on 9a1cd66)
**Approve.** No Critical or High findings. New Lows: F-59, F-60 and F-61. Closed: F-50. Verified: the Sentry halves of F-06 and F-07, the Sentry parts of F-23, and the F-09 alert code.

### `SAFE_MESSAGES` (frontend/src/observability/scrub.ts): rulings
The owner ruled in round 8 that known-safe browser messages may be kept. Each entry below is **signed off**: it is anchored, matches the whole string, and has no free-text part. `patternProblems()` enforces those rules lexically, and a test runs it over the list. Any change to the list needs a new sign-off.

| # | Pattern | Ruling | Why it is safe |
|---|---|---|---|
| 0 | Contract error code (`Object.hasOwn(ERROR_COPY, v)`) | **Signed off** | `ApiError`'s message is `body.code`. Only codes errors.md defines pass, and `hasOwn` blocks prototype keys. |
| 1 | `Unexpected response (HTTP \d{3})` | **Signed off** | Built only from the status (api/errors.ts). |
| 2 | Fixed app strings (`Network request failed` … `Script error\.?`) | **Signed off** | I checked every listed throw site: none interpolates anything. `lib/dates.ts` interpolates a date, so it is correctly *not* listed and gets redacted. |
| 3 | `Minified React error #N; visit https://react.dev/errors/N …` | **Signed off** | `stripReactArgs` drops the `?args[]=` values before matching (they are URL-encoded, so they hold no spaces), and `\1` pins the URL to the same number. What it removes is never sent. |
| 4 | `(Failed to fetch\|error loading) dynamically imported module: <own origin>/assets/<name>-<8 hex>.js` | **Signed off, and the chunk name stays** | See below. |
| 5 | `Importing a module script failed.` | **Signed off** | Safari's fixed text, with no URL. |
| 6 | `Failed to fetch` / `Load failed` / `NetworkError when attempting to fetch resource.` | **Signed off** | The browsers' fixed `fetch()` TypeErrors, with no URL. |
| 7 | `ResizeObserver loop …` (two forms) | **Signed off** | Fixed strings. |

**The chunk name (frontend-engineer's question): keep it.** Chunk names are fixed at build time from source module names: rolldown `[name]-[hash]`, for example `ResetPasswordScreen` or `esm` for the Sentry chunk. Nothing a user or the API sends can affect them. They are public in the bundle, and they reveal no more than the `route` tag already sends. They are also the useful part for diagnosing deploy skew. Conditions:
- `OWN_ASSET` stays bounded: `[A-Za-z0-9_-]{1,64}`, 8 lowercase hex, `.js`, with no `?` or `#` able to match.
- The `ownOrigin` check stays.
- If `output.chunkFileNames`/`entryFileNames` ever stops being `[name]-[hash]` (hex), this entry needs a new review.

### What was checked and holds
- **Server (backend/src/observability/error-tracker.ts):**
  - The raw error never reaches the SDK. `captureError` builds the event from `serializeError`, and the exception value is only `code=…`/`constraint=…`/`table=…`/`column=…` from SAFE_TOKEN values, or `details withheld (F-07)`.
  - `beforeSend` rebuilds every event from scratch, including those the uncaught-exception integration builds. It keeps only level, release, environment, fingerprint (token charset), the two fixed A6 messages, tags requestId/userId (UUID)/route (template), user.id (UUID), up to 3 exceptions and up to 50 cleaned frames. Machine paths become `app:///…`, `node_modules/…` or a base name.
  - The settings remove every other source: `defaultIntegrations: false` (so no http, requestData, context, console or local-variables integration), `dataCollection` all off, `includeLocalVariables: false`, `maxBreadcrumbs: 0` plus `beforeBreadcrumb: () => null`, `tracesSampleRate: 0`, `enableOpenTelemetrySetup: false`, `enableRuntimeChannelInjection: false`, `sendClientReports: false`.
  - Platform `node`: Relay does not infer an IP for it. Check-ins carry slug, status, duration, release, environment and monitor config only.
  - Only 5xx are captured (`sendError`, `internal`). The route comes from `req.routeOptions.url`, a template that ROUTE re-checks.
  - Without `SENTRY_DSN`, nothing loads. The dev entry, tests and the e2e backend never start Sentry: `createDeps` defaults to `NO_TRACKING`, and only server.ts and the admin CLI call `initErrorTracker`.
  - `SENTRY_DSN` fails closed in both configs, and the error message never echoes the value.
  - build.test.ts runs the *bundled* chunk under `--enable-source-maps` and checks the wire bytes: no `Pharmacy`, `4500` or `Failing row`.
- **Bundled SDK (dist/chunks/esm-\*.js, from the existing dist on 2026-11-16):** its source map lists only @sentry/core, node, server-utils, opentelemetry, server-runtime-injection, conventions and `@opentelemetry/api`. There is no bundler-plugins, `sentry` CLI, oxc, glob or dotenv. Entries reach it only through dynamic `import()`. Release age is covered by pnpm `minimumReleaseAge` (7 days) with no exclusion added; versions are exact pins with lockfile integrity; `strictDepBuilds` with an empty `onlyBuiltDependencies` means no install scripts.
- **Browser (frontend/src/observability/):**
  - `scrubEvent` rebuilds every event, and `scrubBreadcrumb` keeps only fetch/xhr (method, path, status) and navigation (route templates). Every other category is dropped before it is stored.
  - The integrations are an explicit list: global handlers, browser API errors, linked errors, dedupe, and breadcrumbs with `dom: false`, `xhr: false`, `sentry: false`. There is no session, replay, feedback, tracing or HTTP-context integration, and `sendClientReports: false`.
  - **v11 silent defaults checked in the SDK source:** `BrowserClient` sets `sdk.settings.infer_ip = userInfo ? "auto" : "never"`, and `_enhanceEventWithSdkInfo` merges it back in *after* `beforeSend`. The rebuilt `sdk {name, version}` therefore does not reopen IP inference. sentry-no-pii.spec.ts asserts `{infer_ip: "never"}`. `addAutoIpAddressToSession` is registered only when `userInfo` is on.
  - No API path carries a token or PII (I checked every OpenAPI path: only opaque IDs and `{month}`), so keeping the fetch breadcrumb path is fine. SPA query strings hold only `month` and a category UUID.
  - The transport has no credentials (the session cookie is `__Host-`, same-origin only), and the Referer is no more than the origin. The test asserts this.
  - The early buffer holds at most 10 errors and is armed only when a DSN was built in. Buffered errors are scrubbed when they are sent.
- **F-50 in the built bundle** (frontend/dist, built 2026-11-17 07:26): `boot-c7fb3811.js` is the first `<script type="module">`, ahead of `index-91d30ae9.js`. It holds only the capture code and exports the token accessors, and the main chunk imports it, so there is one copy of the in-memory token. No JS file carries `sourceMappingURL`.
- **SW fix (frontend/src/app/sw-register.ts `reloadOnTakeover`):** holds. No reload happens on the first install's `clients.claim()`, so the in-memory link token survives a first visit from an email, and nothing new is cached or exposed. Functional note for frontend-engineer, not a security issue: `hadController` is read once at `load`. A tab that got its first controller by a claim and later taps "Reload to update" will not auto-reload after `skip-waiting`. Consider calling `location.reload()` straight from `applyUpdate` once the waiting worker is activated.
- **Source maps:**
  - Vite builds `hidden` maps, and the Dockerfile moves every `.map` to the `sourcemaps` stage and fails if any is left in `/public`.
  - image-smoke checks that `/app/public` has no `.map` and no JS carries `sourceMappingURL`, and that `<script>.map` answers 404, or with `Accept: text/html` gives no `"mappings"`.
  - `.sourcemaps/` is git-ignored and docker-ignored. The maps hold only public-repo source.
- **`sourcemaps` CI job:**
  - It runs only on main (`if:`), and environment `sentry`'s branch policy is main only (bootstrap S6, `gh api` verify step). Token permissions are `contents: read`, with `persist-credentials: false`.
  - The secret is in step env only. It reaches only the docker CLI and the digest-pinned `getsentry/sentry-cli:3.8.2` container through `-e NAME`, never argv. BuildKit `RUN` steps can't see the runner's env, so no dependency code runs with the token. No artifact is uploaded.
  - The org token's `org:ci` scope is Sentry's minimum.
  - The 07:17 zizmor run reports no high finding on ci.yml, which hasn't changed since (23:10).
  - Nit (ci-engineer): the ci.yml header comment (line 5) still says "No job reads secrets".
- **e2e:** the fake DSN must be `https://<32 hex>@<host>.test/<n>` (env-guards.ts, RFC 6761). It reaches the bundle only through build-prod-frontend.mjs, and the browser intercepts its host, so no test event can reach a real project.
- **Canary (deploy/scripts/sentry-canary.sh):** it sends one synthetic event with `--data-binary` from `jq`-built JSON, accepts only `*.ingest.us.sentry.io`, has a dry run by default, uses environment `smoke` and level `info`, and touches no DB or Cloud Run. Two notes for sre:
  1. With `ip_address: "{{auto}}"`, it stores the operator's own IP if "Prevent storing IP" is off. That is acceptable: it is the point of the test, and the runbook deletes the issue.
  2. Line 62 (`note: "payee SSCANARY…"`) assumes Sentry also scrubs *values* that contain a sensitive word. If the canary fails on that field alone, re-check that claim in observability/README.md rather than treating it as a leak.
- **CSP reports**, a new live flow now that `SENTRY_DSN` will be set, go to the `shoestring-api` project. Browsers strip the fragment from `documentURL` (CSP3). The query keeps at most a month or a category UUID. There is no `'report-sample'`, so no script text is sent. IP storage off covers the reporter IP.

### F-59 Low (new, Sentry): frame-shaped message lines and unbounded frame text
- **Location:**
  - frontend/src/observability/scrub.ts:288 (`filename: stripUrl(f.filename)` has no character bound) and :54 (`FUNCTION_NAME` allows spaces).
  - backend/src/logging.ts:23 and :48. `FRAME` keeps any trimmed `error.stack` line shaped `at …:N:N`, including message lines after the first.
  - backend/src/observability/error-tracker.ts:98 (`FUNCTION` allows spaces) and :135.
- **Scenario:**
  1. V8's `error.stack` is `Name: message\n    at …`.
  2. Sentry's browser parser and `serializeError` both skip only the first line. A multi-line message with a line like `    at <text> (<file>:1:2)` therefore becomes a frame.
  3. On the web side its `filename` is copied with no charset limit. On both sides `function` may hold words with spaces.
  4. The text then reaches Sentry, while the message itself is redacted.

  I found no current trigger. Stored names, payees and memos reject control characters (`is_clean_text`). The app's own messages are fixed. JSON.parse snippets of API bodies can't hold raw newlines. 4xx (bad JSON bodies) are never captured. So this is missing defence in depth: a future error that quotes user text with a newline would bypass the message allowlist through the frames.
- **Recommended fix:**
  - **Web:** keep `filename` only if it matches the own origin plus `/assets/[A-Za-z0-9_-]{1,64}-[0-9a-f]{8}\.js`, or a short fixed set (`<anonymous>`, `native`). Otherwise replace it with `<external>`. Restrict `function` to identifier characters, with an optional `new `/`async ` prefix.
  - **Server:** in `serializeError`, skip the first `String(e.message ?? "").split("\n").length` lines of `stack` before applying `FRAME`. Tighten `FUNCTION` the same way.
  - Add a unit test with a message that embeds `\n    at Pharmacy copay (x.js:1:2)`, on both sides.
- **Owner:** frontend-engineer, backend-engineer. Not blocking.

### F-60 Low (new, Sentry): no owner alert at the 60% cutoff, where password-reset mail stops
- **Location:**
  - backend/src/email/mailer.ts:36–37 (A6 at 0.8 and 1.0) and :64/:71 (softLimit 60%; only a log line).
  - auth.md §14 email-budget row, changed in this PR from "first time the 60% threshold is hit … a warning-level event goes to Sentry" to 80% and 100%.
  - notifications.ts:215 (`password_reset` is non-priority) and :142 (`budget_invitation` is non-priority).
- **Scenario:**
  1. Non-priority mail stops at 60 per day. Only priority mail can raise the count past 60, so the 80% alert never fires on a non-priority flood.
  2. An attacker holding one beta account's password (R-1, the most likely attack) re-auths and sends 30 budget invitations to arbitrary addresses (the per-user cap). They add a few reset requests, or use a second account.
  3. The day's count reaches 60. From then until UTC midnight, every user's password-reset mail is dropped silently, the victim's included, and the owner hears nothing.
  4. An anonymous attacker alone stays at or under 50 (5 resets per address per day, under 10 users).

  Deviation 4 (2026-11-13) was accepted on the basis that "the owner gets the budget alert". observability README had already put A6 at 80%; this PR moved the contract to match it.
- **Recommended fix:** raise the `warning` at the 60% cutoff: set `share: 0.6` for `email:quota_warning`, or add a third one-shot. Keep the `error` at 100%. Update auth.md §14, observability/README.md A6 and email-quota.md to match. The tests change only in the threshold. Cost: at most one more alert email per day.
- **Owner:** architect (auth.md text), then backend-engineer and sre. Not blocking; recommended before launch. **Owner decision** if the architect prefers to keep 80% (then deviation 4 needs re-acceptance without the alert).

### F-61 Low (new, Sentry): a devDependency that ships as runtime code
- **Location:** backend/package.json:37 (`"@sentry/node": "11.10.0"` under `devDependencies`); backend/dist/chunks/esm-\*.js.
- **Scenario:**
  1. An advisory lands in `@sentry/core`, `@sentry/node`, `@sentry/server-utils`, `@sentry/opentelemetry` or `@opentelemetry/api`.
  2. GitHub labels the Dependabot alert "Development dependency", and `pnpm audit --prod` doesn't list it. Our own triage has dismissed dev-only advisories before (minimatch, 2026-11-13).
  3. The alert is dismissed, but the vulnerable code runs in production on every 5xx.

  osv-scanner reads the whole lockfile, so `make audit` still sees it. The risk is in the triage, not the scan.
- **Recommended fix:**
  - Record the rule in ADR-0008 or audit.sh output: anything bundled into `backend/dist` is runtime, whatever its dependency type.
  - Have build.test.ts assert the exact set of `node_modules` packages listed in the dist chunk maps against a checked-in list (for example `backend/scripts/bundled-runtime-packages.json`), so the list stays true and triage can rely on it.
  - Alternative: move `@sentry/node` to `dependencies` and keep it out of the image with a `pnpm deploy` filter. That is more moving parts, so not recommended.
- **Owner:** ci-engineer (audit/ADR note), backend-engineer (build test). Not blocking.

### Notes (not findings)
- **osv (07:17 run):** `glob@13.0.7` GHSA-3g3m-2fjr-6pw4 (AbortSignal cancellation bypass, below 7.0) is new in this PR. It comes through `@sentry/node` → `@sentry/bundler-plugins` and is never bundled or executed (not in the chunk map; we don't use the bundler plugin). It is not exploitable; it will go away when the Sentry SDK updates. The `sentry@0.45.0` npm package is getsentry/cli, a dependency of bundler-plugins: not executed, and no install scripts run.
- **Semgrep (07:17 run):** two WARNINGs, `unknown-value-with-script-tag` at frontend/scripts/dist-checks.test.ts:61 and :65. False positives: test fixtures build `<script>` strings for the check-dist parser, and the file never ships.
- **Load-shedding 503s go to Sentry:** passwords.ts:48 `UNAVAILABLE` is `internal`, so a login burst creates events. This is consistent with the owner's quota ruling (2026-11-16). The public browser DSN is a cheaper way to flood the org quota anyway, and the events group under `code=UNAVAILABLE`. A2 firing on a login flood is a useful signal.
- **Runbook false alarms (sre):** if Global Sensitive Fields do scrub *values* containing a word, fetch breadcrumb paths such as `/api/me/sessions`, `/api/auth/session`, `/api/me/email-change`, `/api/auth/password-reset/…` and `/api/me/mfa/recovery-codes` will show `[Filtered]`. sentry-data-check.md step 1 says to report every `[Filtered]` as an SDK leak. Add these expected paths so the owner isn't sent chasing them. **Done 2026-11-17 (`fix/sentry-followups`).**

## Sentry follow-ups review 2026-11-17: `fix/sentry-followups` (uncommitted tree on 704e2cd)
**Approve.** No Critical or High findings. F-60 and F-61 are verified. F-59 is verified for every case it named. New Low: **F-62** (F-59 residuals). The four open CodeQL alerts are not real issues (triage below).

**Verification.** The tech lead ran `make check`, `make e2e` (API 1423/1423, Playwright 76 passed with 2 skipped, visual 24/24) and `make audit`, all green. I ran no make target and didn't touch Docker. The `.audit/` reports on disk are from 10:25:
- osv: only glob 13.0.7 and minimatch 10.2.6, both already ruled not exploitable;
- Semgrep: only the two known dist-checks.test.ts fixture WARNINGs;
- zizmor: no high finding.

Those reports predate the last edits to logging.ts (10:27), build.test.ts (10:32) and scrub.ts (10:38). The edits change no dependency (no lockfile or package.json diff), so the osv and zizmor results still hold. CI's audit job covers Semgrep on the final tree. A manual secret-pattern grep over the diff and the untracked files found nothing.

I probed both halves directly: under Node 24 I ran the real `@sentry/browser` 11.10.0 `defaultStackParser` against `fromMessage`/`safeFrameFile`/`safeFrameFunction`, and I ran `serializeError` with crafted V8 errors.

### F-59: verified (residual F-62)
- **Server (backend/src/logging.ts:23–66, error-tracker.ts:146–155, :264–280):**
  - `frameLines` drops `lineCount(name) + lineCount(message) - 1` header lines. That handles an empty name or an empty message, and it fails closed (no frames) when either is not a string.
  - `FRAME` requires `FN` (identifiers, `.`, `#`, `<>`, an optional `new `/`async ` prefix and `[as x]`, no free spaces) or a bare location.
  - Checked by hand:
    - a multi-line message with `at Pharmacy (x.js:1:2)` gives no fake frame;
    - so does a multi-line `name`;
    - so does a class with a `name` getter;
    - a message set before the first `.stack` read is handled: V8 builds the header lazily.
  - `beforeSend` now ignores the SDK's own frames whenever `hint.originalException` is present. It re-derives the outermost frames from `serializeError` and gives the other values none. A non-Error original yields `[]`. `captureError` passes no hint, so its frames already come from the allowlist. `FILENAME` still has no spaces.
- **Web (frontend/src/observability/scrub.ts:56–145, :340–375):**
  - A frame's file is kept only when it is an own-origin `/assets/<name>-<8hex>.js` (anchored `OWN_ASSET`, own-origin check, `?`/`#` cut first) or one of the three pseudo-files. Anything else becomes `<external>`.
  - The function-name regex has no free spaces and no `@`.
  - `fromMessage` drops a frame whose file, `at fn `, `at fn(` or `fn@` is in a message tail. The tails come from every exception value and from the original's own message. The browser SDK sets no `maxValueLength` by default and we set none, so the values are not truncated.
  - Checked against the real parser:
    - a frame line inside the message is dropped;
    - spoofed own-chunk lines are dropped;
    - Safari-extension rewrites are caught by the `fn@` needle;
    - data-URI frames are caught by `at fn `/`at fn(`.
- The tests cover the cases in the finding on both sides (logging.test.ts, error-tracker.test.ts, scrub.test.ts with the real `defaultStackParser`).

### F-62 Low (new): F-59 residuals, a parser rewrite and a stale V8 header
- **Location:** frontend/src/observability/scrub.ts:127 (`fromMessage` compares parsed values against the raw tails); backend/src/logging.ts:51 (`frameLines` trusts the current `name`/`message`).
- **Scenario (a), web, reproduced:**
  1. @sentry/core `createStackParser` runs `line.replace(/\(error: (.*)\)/, "$1")` on each line before parsing it.
  2. Take a message line `    at Pharm(error: acy (/assets/fo)o:4500:2`. The parser turns it into a frame with `function: "Pharmacy"`, `filename: "/assets/foo"` and `lineno: 4500`.
  3. Neither `at Pharmacy ` nor `/assets/foo` occurs verbatim in the message, so `fromMessage` keeps the frame.
  4. What's sent: `{function: "Pharmacy", filename: "<external>", lineno: 4500, colno: 2}`.

  The same trick also produces an exact own-chunk URL, which is then kept as the file name.
- **Scenario (b), both sides, reproduced on Node 24:**
  1. V8 fixes the `stack` header at the first `.stack` read. Code then does `err.message = "short"`.
  2. The header-line count (server) or the message tails (web) now come from the new message.
  3. The old message's later lines are treated as frames. On the server, `serializeError` returned `at Pharmacy (x.js:1:2)`.
- **Ceiling and trigger:** the function bounds still hold. At most, one identifier-shaped word (≤128/200 of `[\w$.<>/#]`) and two integers get through per crafted line. I found no trigger:
  - stored text rejects control characters, so it can't hold a newline;
  - no app code and no prod dependency I checked (fastify, @fastify/error, pg, pg-pool, kysely) shortens a message after reading `.stack`. kysely appends to `stack` only after removing the header of its own error.
  - 4xx errors are never captured.
- **Recommended fix:**
  - **Web:** also put the `(error: …)`-cleaned form of each tail line in the haystack (`line.replace(/\(error: (.*)\)/, "$1")`, the SDK's own regex).
  - **Both sides, fail closed:** keep frames only when `stack` starts exactly with the current header (`${name}: ${message}\n`, or the one-part forms). Otherwise send no frames for that exception. On the web, apply this to V8-style stacks only: Firefox and Safari stacks never hold the message.
  - **Tests:** the `(error: …)` line above, and a message shortened after `.stack` was read.
- **Owner:** frontend-engineer (a, and b on the web), backend-engineer (b, server). Not blocking; fix when convenient.

### F-60: verified
- mailer.ts:31–53, :78–143. The non-priority refusal and the A6 warning both use `bulkCutoff(quota)`.
  - A non-priority send is kept only if `slot.count - 1 < cutoff`. So a bulk flood stops with the counter at exactly `cutoff`, and the send holding that slot runs `quotaAlerts(cutoff)`, which crosses the warning line.
  - The one-shot `reserve` plus `>=` keeps the F-58 pattern, and a failed provider send still counts.
  - `EMAIL_DAILY_QUOTA=1` gives cutoff 0: the warning fires on the first priority send. That's harmless.
- The contract, ARCHITECTURE, observability A6, email-quota.md (which now lists exactly what has stopped), bootstrap 13C and the cost sheet all say 60%. The alert rules match only the prefix and level, so no rule change is needed.

### F-61: verified
- Read from code:
  - build.test.ts walks every chunk's `map.sources` and takes the package after the last `node_modules/`, so nested `.pnpm` paths resolve correctly.
  - It asserts that at least one entry chunk has a map, so an empty list can't pass by accident.
  - It compares the result with the checked-in list.
- I checked the existing `backend/dist` maps myself: 21 packages, identical to `bundled-runtime-packages.json`.
- ADR-0008 and audit.sh state the triage rule for both artifacts. Frontend runtime libraries are already under `dependencies`, so nothing is mislabelled there.
- Known limit, not a finding: a package whose own source map rewrites its `sources` to a non-`node_modules` URL (such as `webpack://`) would not be listed. None of the 21 does this; re-check when a package is added.

### CodeQL alerts on main: triage (security-reviewer did not dismiss any)
| # | Rule / location | Ruling | Dismissal reason | Justification text for the owner |
|---|---|---|---|---|
| 1 | js/insufficient-password-hash, backend/src/auth/passwords.ts:161 | False positive | **False positive** | SHA-1 here is not password storage. It is the HIBP Pwned Passwords range-API protocol (k-anonymity): only the first 5 hex characters leave the server, with Add-Padding, and nothing is stored. Passwords are stored with argon2id (m=19 MiB, t=2, p=1; passwords.ts:13-15, rehash on weaker parameters). Reviewed by security-reviewer 2026-11-17. |
| 2 | js/insufficient-password-hash, backend/src/crypto/keyring.ts:75 (`hmacSha256`) | False positive | **False positive** | The inputs are not user-chosen passwords. One is server-generated recovery codes (about 51.7 bits of entropy each), HMAC'd with a secret HKDF subkey of APP_KEYRING (`recovery-code-v1`), as the security review required (F-04). The other is non-secret values keyed for throttling (user ID or email, `throttle-v1` subkey); the "findValidUserToken" source is the reset-token row, not a password. A keyed HMAC over high-entropy or non-secret values needs no slow hash, and attempts are rate-limited (F-45). Reviewed by security-reviewer 2026-11-17. |
| 3 | js/file-system-race, backend/scripts/test-hooks-tripwire.ts:19 (`statSync` then `readFileSync`) | Not a security issue | **Won't fix** | Build-time tripwire that only reads the local dist/ just produced by the same build; it writes nothing and acts on no file. A race needs someone who can already write the build output, which defeats any check. The production gate is the Dockerfile's own grep (Dockerfile:51-61), not this script. Reviewed by security-reviewer 2026-11-17. *Optional instead of dismissing:* backend-engineer can use `readdirSync(d, { withFileTypes: true })` and `entry.isDirectory()` with no `statSync`, which removes the pattern and the alert. |
| 4 | js/missing-origin-check, frontend/sw/service-worker.js:42 (`message` → `skipWaiting`) | False positive | **False positive** | A service worker's `message` event can only come from its own clients: a page needs a `ServiceWorker` object for this registration, and only same-origin documents and workers get one. Cross-origin pages cannot post to it. The only action, `skipWaiting` on the "skip-waiting" string, activates a worker that the same origin already installed. Navigations are network-first, so nothing stale or unsafe is served. Reviewed by security-reviewer 2026-11-17. |

None of these gets an F-number. If the owner prefers code to a dismissal for #4, an `if (event.origin !== self.location.origin) return;` guard is harmless, but it adds no security.

### Other changes checked
- **sw-register.ts (`updateRequested`):** no risk.
  - The flag is set only by `applyUpdate`, and only when a waiting worker exists (the person tapped "Reload to update"). A first-visit claim still never reloads, so the emailed link token kept in memory still survives (auth.md §4). That keeps the F-50/first-visit ruling.
  - Other tabs that had no controller at load and didn't ask stay put.
  - A reload is a network-first navigation, so it gets the current CSP and assets. `reloading` stops repeated reloads.
- **`randomPassword()` (tests/support/passwords.ts):** no risk.
  - It returns 18 bytes from `node:crypto` as base64url (144 bits, 24 characters), and it is test-only: tests/ never ships.
  - It meets auth.md §7, as the unit test shows.
  - The GitGuardian hits it replaces were run-time random templates, not real secrets, so nothing needs rotating.
- **Bootstrap runbook (public repo, owner's choice):**
  - The org slug, project IDs and ingest host are already public in the browser bundle's DSN, so the runbook exposes nothing new.
  - **GitHub environment auto-created without a branch policy (2026-11-17):** I checked that there was no exposure. The only deployment to `sentry` is from `main` (704e2cd, 14:18Z). `SENTRY_AUTH_TOKEN` was created at 15:11Z. The policy now allows `main` only (`custom_branch_policies: true`, one rule, `main`). The runbook now creates the environment before any workflow refers to it.
  - ci.yml header nit fixed.
- **Sentry CLI login on the owner's Mac (new operational credential, Info):** an OAuth session with `project:write` and `alerts:write`, until about 2026-12-15. Any local process, including agent sessions, could use it to turn project-level protections off (`scrubIPAddresses`, `scrapeJavaScript`, Allowed Domains) or silence the A2/A6 alert rules. It can't change org-level Security & Privacy (that needs `org:write`). The runbook already says to log out after step 13. **Recommendation: log out as soon as step 13 is done, and don't keep the session for convenience.** Re-run the canary (sentry-data-check.md) after any CLI write to project settings. Added to the threat model (T133).

### PR #20 audit: picomatch GHSA-fc5q-39xc-vjpf, time-boxed osv ignore: **signed off** (security-reviewer, 2026-11-17)
The advisory is picomatch@4.0.7, GHSA-fc5q-39xc-vjpf (CVE-2026-112366, CVSS 8.7): a ReDoS from attacker-supplied extglob patterns, affecting every version through 4.0.7, with no patched release. **I ruled it not exploitable here.** It is not an F-number.

**Reachability, checked by me:**
- **Who pulls it in:** in pnpm-lock.yaml, picomatch@4.0.7's only parents are `fdir@6.5.0`, `tinyglobby@0.2.17`, `vite@8.3.7` and `vitest@5.1.0`, all dev tooling. typescript-eslint comes in through tinyglobby.
- **Not in the production dependency tree:** `pnpm why picomatch --prod` is empty in backend/ and frontend/. The control query, `pnpm why pg --prod`, resolves, so the empty result is real.
- **Not imported by shipped code:** no file in backend/src, db/src, frontend/src or frontend/sw imports picomatch, tinyglobby, fdir or micromatch.
- **Not bundled:** picomatch, tinyglobby and fdir appear in none of the 34 frontend/dist maps and none of the 4 backend/dist maps, and no built JS file contains them. They are not in `bundled-runtime-packages.json`, so the F-61 rule doesn't make them runtime code.
- **Where the patterns come from:** only the repo's own configs (vite, vitest and eslint include/exclude lists). Nothing a user, the API or a fork PR sends reaches them at run time. A fork PR that edits those configs can only slow its own read-only CI run.

**The ignore (.github/osv-scanner.toml, .github/scripts/audit.sh), reviewed against osv-scanner v2.7.1 source (the pinned image):**
- **Exact ID only:** one `[[IgnoredVulns]]` with `id = "GHSA-fc5q-39xc-vjpf"`. `FindVulnIgnore` matches by equal ID, with no wildcards and no package-wide ignore.
- **Expiry fails again:**
  - In v2.7.1, `effectiveUntil` is the current key; `ignoreUntil` is deprecated.
  - `isInEffect` is `effectiveUntil.After(time.Now())`, so the date `2026-12-17` stops applying at 00:00 UTC that day. The advisory then reappears in osv.json and fails the gate.
  - `tryLoadConfig` rejects unknown keys. A misspelled key therefore fails the scan (exit > 1, audit FAIL) instead of quietly making the ignore permanent.
- **Visible:** audit.sh lists every entry with its state (active, expired, or NO EXPIRY), both after the osv step and in the final summary. It also reports unused entries taken from the osv log.
- **Thresholds unchanged:** still CVSS ≥ 7.0 or unscored fails. The `groups`/`high` jq logic is untouched. The only change to the scan is `--config`.
- **The `reason` text is accurate**, including "security-reviewer sign-off".

**Notes for ci-engineer (Info, not blocking):**
1. On 2026-12-17 itself, the summary still says "active until 2026-12-17", while osv has already stopped applying the ignore. The build fails correctly, but the label is a day late. Use `!(until > today)` for the "expired" test.
2. The ignore is keyed by advisory ID, not by package scope. If picomatch enters a *production* dependency tree before 2026-12-17 without being bundled, the ignore would hide it. build.test.ts catches it only if it gets bundled into the backend. Before extending or re-ignoring, re-run `pnpm why picomatch --prod` in backend/ and frontend/; any result there means the ignore must go.
3. The "unused" detection greps for osv's exact wording (`has unused ignores`). If a future osv version rewords it, the report goes quiet.

**Re-check:** when picomatch > 4.0.7 ships (bump it and delete the entry), or on 2026-12-17, whichever comes first. Any extension needs a fresh sign-off.

## Offline and F-62 review 2026-11-17: `fix/offline-and-f62` (uncommitted tree on a55786e)
**Approve.** No Critical or High findings. F-62 is verified and closed, with an accepted residual. New Low: **F-63** (web). The offline change adds no security risk.

**Verification.** The tech lead is running `make check`, `make e2e` and `make audit`, so I ran no make target and didn't touch Docker. The `.audit/` reports on disk are from 13:27, before this tree's edits (14:02–14:07):
- osv: clean apart from the signed-off picomatch ignore;
- Semgrep: only the two known dist-checks.test.ts fixture WARNINGs;
- zizmor: no high finding.

The diff changes no package.json or lockfile, so the osv and zizmor results still hold. CI's audit job covers Semgrep on the final tree. A secret-pattern grep over the diff and the two untracked files found only test fixtures.

I probed both sides under Node 24: the real `@sentry/browser` 11.10.0 `defaultStackParser` into `scrubEvent`, and `serializeError` with crafted V8 errors and real Node-coded errors (scripts in the session scratchpad, not committed).

### F-62: verified (residual accepted)
- **(a) Web, `(error: …)`** (scrub.ts `asStackParserSees`, `messageTails`):
  - It matches @sentry/core 11.10.0 `createStackParser` line for line: cut at 1024, then the same non-global `/\(error: (.*)\)/` replacement. The original line (`    at Pharm(error: acy (/assets/fo)o:4500:2`) is now dropped.
  - **Nothing new gets through.** The rewritten tails are only *added* to the haystack, so they can only drop frames. They never touch what is sent.
  - Every frame's file is a substring of the cleaned line, except data-URI and Safari-extension frames. For those two, the `at fn ` / `at fn(` / `fn@` needles come from the same cleaned line. Gecko's `fn(args)@` form drops the arguments from the function, but the file needle still matches.
- **(b) Web, stale header** (scrub.ts `framesTrusted`):
  - A cut mid-line, a replaced message, a renamed error, and a stale linked `cause` all send no frames.
  - Firefox and Safari are exempt. That is correct: their native stacks never hold the message.
  - The SDK walks `cause`, then `errors[]`, then SuppressedError, depth-first, up to limit + 1 = 6 values. `reachableErrors` follows the same order over a superset of keys. Cycles make `valueCount` larger than the set, which fails closed.
  - One gap in the cap is filed as F-63 (2).
- **(b) Server** (logging.ts `frameLines`):
  - A cut mid-line and a stale name both give no frames. A non-string name or message, and a stack that is only the header, give no frames.
  - Real Node errors keep their frames: `RangeError [ERR_OUT_OF_RANGE]`, plain `TypeError` with `code` ERR_INVALID_URL (Node 24 prints no `[CODE]` there), and `Error: ENOENT`.
- **The `[CODE]` header form adds nothing new.**
  - It is used only when the stack *literally* starts with `${name} [${code}]: ${message}\n`. It and the plain form differ at the character after `name`, so at most one can match.
  - A `code` that holds a newline with no mutation gives no fake frame.
  - The only way to abuse it is to change `name` *and* `message` after `.stack` was read, so that the coded header is a line prefix of the old one. I reproduced that; it is the residual below.
- **Tests:** scrub.test.ts "F-62" (a, b, linked cause, getters, other engines, the residual pinned as a test), logging.test.ts (stale, Node-coded, header-only, non-string), error-tracker.test.ts.

**Residual (accepted by security-reviewer, 2026-11-17; owner decision not needed).** On both sides, a stale header still passes when the current header is a whole-line prefix of the one V8 fixed. The reported case is a message cut exactly at a line break after the first `.stack` read. The same holds for any change to name, message or code that composes to such a prefix. Then the old message's frame-shaped lines survive, bounded by F-59: no filename on the web (`<external>` or an own chunk), and at most one identifier and two integers per line.

Why I accept it rather than keep F-62 open:
1. **There is no trigger.**
   - No code in backend/src, db/src or frontend/src assigns `.message` or `.name` on a caught error. The only `.name =` assignments are in constructors, before any `.stack` read.
   - No prod dependency checked earlier shortens a message after reading `.stack`.
   - Stored text can't hold newlines.
   - 4xx errors are never captured.
2. **The ceiling is low and already reviewed** (F-59).
3. **The full fix costs more than the risk.** A process-wide `Error.prepareStackTrace` hook changes `error.stack` for every library. It interacts with Node's source-map support and the Sentry SDK. It would itself be new code on every error path. I agree with both engineers not to do it.

It stays Low-class defence in depth, inside my remit for an accepted residual. It is not a dismissal: the fix asked for is in place. **Re-open F-62 if:**
- any code assigns `.message` or `.name` on an existing error (grep `\.(message|name)\s*=[^=]` outside constructors);
- a dependency or app code sets `Error.prepareStackTrace` or calls `captureStackTrace` on a reused error;
- an error message starts carrying multi-line user or API text.

### F-63 Low (new, web): header line, multi-line names, and the linked-error cap
- **Location:** frontend/src/observability/scrub.ts:166 (`messageTails`) and :486 (`scrubEvent` builds the tails). Separately, :236 (`reachableErrors`).
- **Scenario (1), reproduced with the real parser on V8:**
  - The SDK skips a stack line only if it contains `Error: `. With a name that doesn't end in `Error` (the app has `ReauthCancelled`), the header's first line is parsed.
  - Example: `name = "ReauthCancelled"`, message `Pharmacy@https://<origin>/assets/foo-12345678.js:777:9`. This went out as `{filename: <own chunk>, function: "<anonymous>", lineno: 777, colno: 9}`. A message like `Paid /rent:1200:31` would send the integers 1200 and 31 with `<external>`.
  - A multi-line `name` (`"X\n    at Pharmacy (…)"`) went out as `function: "Pharmacy"`.
  - The haystack holds only the message's later lines, so `fromMessage` misses both. The server is not affected: it slices off the whole exact header.
- **Scenario (2), reproduced:**
  - Set up an `AggregateError([stale], …)` whose `cause` is a chain of 40 plain objects. `framesTrusted(agg, 2, true)` returns `true`, while the control without the chain returns `false`.
  - This happens because the walk spends its 32 slots on the non-Error chain, which the SDK ignores. The SDK still reports `errors[0]`.
- **Trigger:** none.
  - Every error name in the app is a constant, and `ReauthCancelled`'s message is fixed text.
  - Browser DOMException names all end in `Error`.
  - Building such object graphs needs app code.
  - The ceiling is the same as F-59.
- **Recommended fix (frontend-engineer):**
  1. For each error checked on V8, also add to the haystack the lines of `asStackParserSees(v8StackHeader(name, message))` that the SDK does *not* skip (no `Error: ` in the line). This covers the header's first line and every line of the name. It can drop only frames.
  2. In `reachableErrors`, return "not trusted" when the cap is reached, instead of stopping quietly. Alternatively, count only values that pass the SDK's `isError`.
  3. Add tests for both scenarios above.
- **Owner:** frontend-engineer. Not blocking; fix when convenient, or together with the next scrub.ts change.

### Offline ("online to save"): no new risk
- **Duplicates and wrong target.** `networkMode: "always"` only removes the paused-mutation queue, so a write is never sent later "unseen". That *removes* the old path where a queued write could fire after reconnecting into a changed session.
  - **Same key on retry is safe.** The key is reused only by the same mounted sheet. The server scopes it by `(user_id, key)` and `request_hash`, which covers the method, route template, path params (`budgetId`) and body. So:
    - an edited body gives 422 `IDEMPOTENCY_KEY_REUSED`;
    - another user can never replay it;
    - a replay is loaded through the current `BudgetScope`, which re-checks membership (F-18);
    - a sheet whose `budgetId` changed under it gets 400 for foreign category IDs before any write.
  - **Edits and deletes carry `version`.** A retry after a lost response gives 409 or "Already deleted", never a second change.
  - **Other writes.** For writes without a key (invite, category), a browser-offline `fetch` never leaves the device. The lost-response case is unchanged from before this PR, and existing limits bound it.
  - The e2e tests prove one stored row and one key across the offline attempt and the Retry, including a 201 whose response was lost.
- **F-54 (user binding):** unchanged.
  - `stashDraft(budgetId, me.id, …)` is still the only stash, and only on `UNAUTHENTICATED`.
  - `enter()` still discards another user's stash and return path.
  - Offline sign-out fails honestly (F-51), so the cache isn't cleared while the same user is still signed in. That is correct.
- **F-52 (device storage):** nothing new.
  - The diff adds no storage, Cache Storage or IndexedDB use, and the service worker is untouched.
  - The query cache stays in memory (ADR-0002) and is cleared on sign-out, on 401 and on bfcache restore.
- **Stale data on the offline screens:** none.
  - `PendingSlot` renders only in the `isPending` branch (nothing cached) and shows fixed text.
  - Categories is gated on `isPending && isPaused` for each query.
  - No offline screen renders cached data that wasn't already shown before this PR.
- **Test-only changes:**
  - `page.routeWebSocket` (a mocked Vite HMR socket) and the `preloadAllScreens()` import are dev-server only.
  - `dal()` reads use the existing local-only test stack (F-56 is unchanged).
  - render.tsx now merges the app's defaults, so unit tests exercise the real `networkMode`.

### Notes (not findings)
- Pre-existing, Info: when a person signs out in one tab, other tabs drop their in-memory cache only on their next API request (a 401), or on focus when they refetch. A tab that is offline keeps showing what it already had. This is the same person's device and the same behaviour as before this PR. There is no cross-tab sign-out broadcast. Worth considering after launch; no F-number.

## Pre-deploy pass review (2026-11-17, `chore/pre-deploy`, uncommitted tree on 9b1f427)
Scope: ci-engineer's split into the migrate image and app image and its smoke checks, sre's runbook and infra changes, and the owner's ruling that the GHCR packages (app, migrate, backup) are public. `make audit` passed: gitleaks clean (55 commits plus the working tree), Semgrep 2 WARNINGs (the dist-checks.test.ts fixtures, Info since 2026-11-17), osv the two known moderates (glob@13.0.7, minimatch@10.2.6, both ruled before) with the picomatch ignore active until 2026-12-17, zizmor clean. I inspected the locally built images (`shoestring` and `shoestring-migrate`, tag `9b1f427675f3-dirty-aa577a0b239a`, built after the last Dockerfile edit) by hand: config, labels, layer history, a file list of `/app`, and string greps. The tree has changed since (the current dirty tag is different), but the Dockerfile and scripts I reviewed are the ones those images were built from. `make e2e` passed (tech lead).

### F-43 closed; F-47 stays closed
- **App image:** `/app` holds `dist/` (server, admin, three chunks plus `.map` files), `package.json`, `public/` and `node_modules/`.
  - `node_modules` holds no `@shoestring`, kysely, pg or dbmate, at the top level or in `.pnpm`.
  - Greps over `dist/` for `SEED_USER_PASSWORD`, `Demo household`, `DATABASE_ADMIN_URL`, `resetDatabase`, `TRUNCATE` and `dbmate` find nothing.
  - So neither the seed nor the testing code can be reached through a job command override any more, and the seed's own guard (production and non-local refusal) is still in `db/src/cli/seed.ts`.
- **Migrate image:** `dist/cli/migrate.js` and `dist/conn.js` only, with no maps, declarations or sources; the import walk pulls nothing else in. Also 3 migrations, roles.sql, `pg` (with pgpass and pg-cloudflare, both inert) and `dbmate` with one platform binary. kysely is gone. Its `package.json` is `{"private":true,"type":"module"}`.
- **F-47:** the app `/app` allowlist and the sentinel scan are unchanged and pass.
- **Smoke's root scans:** sound.
  - They walk `/` except `/proc`, `/sys` and `/dev`, and fail on unreadable directories and on fewer than 1,000 entries, so a quietly empty scan can't pass.
  - Symlinks aren't followed, but they are matched by name.
  - They run as root with `--network none` on our own throwaway image. Contrary to the brief, they don't use `HARDEN` (no `--read-only` or `--cap-drop`). That carries no risk; adding `"${HARDEN[@]}"` would make it match the description (Info).
- **Migrate run checks:** they cover the missing-URL and non-`verify-full` refusals, a bootstrap run, and a job-shaped run with `MIGRATOR_DATABASE_URL` only. No password appears in the output of any of them. The CLI prints SQLSTATEs and roles.sql's own messages only, and dbmate gets the URL through the environment, not argv.

### Migrate job: least privilege improved
- The job no longer runs the app image. Before, the migrator credential sat next to `admin.js` and the whole server, one `--command` override away. Now the image can only run `migrate.js`, and job overrides can't change the command.
- It has one secret (`MIGRATOR_DATABASE_URL`), no Sentry and no `DATABASE_ADMIN_URL`. If someone set the admin URL anyway, the F-42 guard refuses any non-local host.
- The image is distroless and nonroot, its code is root-owned, and the entrypoint is checked by `image-migrate.sh`. With 0 retries, a failed migration never re-runs unattended.
- Deployer rights over this job are unchanged (F-39 scoping). A deployer who can retag or override the job could already run code with the migrator credential, so this change adds nothing there.

### Public GHCR images: nothing beyond the public repo
- **Config and history:** env is `NODE_ENV`, `HOST`, `PORT`, `STATIC_DIR`, `APP_RELEASE` and `NODE_OPTIONS=--enable-source-maps` (app), or `NODE_ENV` and `APP_RELEASE` (migrate). The labels are title, source repo URL and revision.
  - Layer history shows only the final stage's `ARG APP_RELEASE`, `ENV`, `COPY`, `LABEL`, `USER` and `CMD`/`ENTRYPOINT` lines. Build-stage ARGs (`VITE_SENTRY_DSN`) and RUN lines don't appear.
  - The only build args are `APP_RELEASE` and `VITE_SENTRY_DSN` (validated shape, public by design). `SENTRY_AUTH_TOKEN` is never a build arg: sourcemaps-upload passes it to a separate `docker run` as `-e`.
- **Files:** the SPA (public anyway) and the backend dist plus its `.map` files. The maps' `sourcesContent` is public-repo and npm code; `STATIC_DIR=/app/public` means they are never served.
  - Also present: pnpm metadata (`.modules.yaml`, `.pnpm-workspace-state-v1.json`, `.pnpm/lock.yaml`) and the backend `package.json` with its script names. All of it is public in the repo.
  - `.dockerignore` keeps `.env*`, `.git`, `.github`, `.claude`, `docs`, `infra` and `deploy` out of the build context, and only the `/out`, `/public` and `/migrate` assemblies reach a final stage.
  - Migrations and roles.sql hold no passwords; production passwords are set with `\password`.
- **Integrity:** making the packages public changes who can *read* them, not who can *write* them. For the future publish workflow (not part of this PR), I'll check these when it lands:
  - `packages: write` only on the publish job;
  - pushes from `main` only, never from `pull_request` or forks;
  - actions pinned by SHA;
  - no secret ever passed as a build arg, because BuildKit `provenance: mode=max` records build args in a public attestation;
  - preferably `actions/attest-build-provenance` (free), checked with `gh attestation verify` before `crane copy`, so a re-pointed `sha-<sha>` tag is caught.
- Ruling: the owner's public-packages decision adds **no exposure**.

### Runbook credential handling
- **Command-line URLs:** `psql "$U&sslrootcert=system"`, `psql "$OWNER_URL"`, and `pg_restore --dbname "$RESTORE_URL"` put a credential URL in a local process's argv, as the accepted bootstrap pattern already did. Shell history records only the variable name. Using `PGSSLROOTCERT=system psql "$U"` would avoid the string concatenation (Info, optional).
  - The rule that the URLs node-pg reads must never carry `sslrootcert` is correct: node-pg reads it as a file path.
- **Admin default args `purge,--dry-run`:** safe. `runPurge({dryRun:true})` runs the deletes inside a transaction that always rolls back, only counts security_events, sends no email and starts no cron check-in (cli.ts:194). Running the job with no args is now harmless; before, `--help` exited 2. The V34 check passes no PII in `--args`.
- **Job command `/nodejs/bin/node,/app/dist/admin.js`:** fine. Admin, purge and rewrap keep their F-02 secret sets, and `shoestring-admin` still never mounts the keyring.
- **rotate-secret.md, throttle-v1 reset:** accurate and matches my earlier ruling. Stage 1 resets the HMAC-keyed counters and the once-a-day notices; the email budget and the per-session and per-token MFA slots survive. The 429 log query prints route and code only. The "not during an active attack, unless the keyring itself is exposed" guidance is right.
- **AR cleanup policy:** the keep rule for `prod-` tags covers every package, `migrate:prod-current` protects the job's image, and keep beats delete. Fine.
- **`RESTORE_OWNER_URL`:** read with `read -rs` and unset at cleanup. It is exported for no reason, and it stays in the shell for the whole restore. Folded into F-64.

### F-64 Low (new, sre): restore runs roles.sql as the database owner from an unvalidated SHA
- **Location:** docs/runbooks/restore.md path B steps 4–5 (`SERVING_SHA=$(… jq -r '.spec.template…APP_RELEASE…')`, `git cat-file -e`, `roles_sql() { git show "$SERVING_SHA:db/roles.sql" | psql "$1" … -f -; }`).
- **Scenario:**
  1. **Empty or missing value.** If `APP_RELEASE` is missing or the jq path returns nothing, `SERVING_SHA` is empty. `git cat-file -e ":db/roles.sql"` and `git show ":db/roles.sql"` then read the **index** copy of whatever branch the owner has checked out, including staged edits. I reproduced this: the guard passes, and the file prints.
  2. **A commit not on main.** Any fetched commit passes the check, including an unmerged feature branch. `APP_RELEASE` is plain env that the deployer identity can set. A restore is often incident response, which is exactly when the deploy path may be compromised, and roles.sql then runs as `neondb_owner`, the most privileged role.
     - Exploiting it needs repo write (to push a branch) plus the deployer. That is two compromises, hence Low.
  3. **The wrong release after a rollback.** `.spec.template` is the latest revision, not the one taking traffic.
     - That happens to match the migrate job's image, which is fine, but the comment "the SHA that is serving now" is wrong.
  4. **No pipefail.** If `git show` failed after the check, psql would read empty stdin and succeed. The migrate job's fail-closed verify is the backstop.
- **Recommended fix (sre, restore.md):**
  ```sh
  set -o pipefail
  [[ "$SERVING_SHA" =~ ^[0-9a-f]{40}$ ]] || echo "STOP: APP_RELEASE is not a full sha"
  git fetch origin && git merge-base --is-ancestor "$SERVING_SHA" origin/main || echo "STOP: not on main"
  git log -1 --format='%h %cs %s' "$SERVING_SHA"     # eyeball: a release you recognise
  ```
  - Reword the comment to say "the release of the latest revision, which is what the migrate job runs".
  - Don't `export RESTORE_OWNER_URL`, and `unset` it as soon as step 5 (and any `\password`) is done.
  - Optionally, read roles.sql from the job's own image instead (`crane export "$MIGRATE_IMAGE" - | tar -xOf - app/roles.sql`), which ties it to the digest that actually runs.
  - Same idea for bootstrap step 8 and the deploy precondition, which run roles.sql from a local checkout: add `git status --porcelain db/roles.sql` must print nothing.
- **Owner:** sre. Fix before the first restore drill.

### F-65 Low (new, sre; V26 gate): hop count measured on one of two public paths
- **Location:** docs/runbooks/bootstrap-production.md step 14 ("To check the domain-mapping path as well, map a temporary `xff-probe.<domain>`…").
- **Scenario:** the service answers on both the `run.app` URL and the custom domain, and `TRUST_PROXY_HOPS` applies to both. Step 14 measures only `run.app`; the path users actually take is optional.
  - **If the domain mapping appends one more entry** than `run.app` and the value stays 1, every custom-domain user shares the proxy's address. The per-IP login and global limits then become one shared bucket, which an attacker can fill to lock everyone out (D), and `security_events.ip` becomes useless for R-1 detection.
  - **If the operator then sets 2,** the `run.app` path trusts one attacker-supplied `X-Forwarded-For` entry, which is exactly F-08.
- **Recommended fix:**
  - Make the domain-mapping probe mandatory.
  - Record both counts in infra/CLAUDE.md "Client IP".
  - State the rule: if both paths give 1, keep 1. If they differ, **stop** and bring it to me. No single value is safe while both URLs are public; the options are a header-based edge identity or turning off the default `run.app` URL (verify the flag), and either one changes the deploy probes.
- **Owner:** sre. Part of the F-08 launch gate (V26); I sign it.

### Other checks: no issue
- **CI:** one added `make image-migrate` step. Permissions are unchanged, nothing is pushed, `persist-credentials: false` is kept, and zizmor is clean.
- **Lockfile:** the `@shoestring/db` move is consistent with backend/package.json.
- **Bootstrap 12 Verify:** now runs `shoestring-admin` and `shoestring-rewrap-mfa` with their default dry runs. Both are read-only.
- **Restore "After any restore" step 0** (the migrate job): it runs against the re-pinned migrator secret from step 9 and is fail-closed. Ops note: after a rollback, this applies the bad release's expand-only migrations to the restored database. That is correct for the job's image, but sre may want to say so in the text.

## Image publish review (2026-11-17, `feat/image-publish`, uncommitted tree stacked on `chore/pre-deploy`)
Scope: `git diff chore/pre-deploy`. That covers ci-engineer's `publish` job, the image-job handoff (`image-save.sh` plus a 1-day artifact), `--provenance=false --sbom=false` on every build, `Dockerfile.backup`, `make image-backup` and its smoke checks, and the bootstrap runbook text. `make audit` passed: gitleaks clean (57 commits plus the working tree), Semgrep 2 known WARNINGs, osv the two known moderates (picomatch ignore active until 2026-12-17), and zizmor v1.32.0 reported **no findings**. I checked the action pins against upstream tags: attest v4.2.2 `1e69f48…`, upload-artifact v7.0.2 `cf430e0…` and download-artifact v8.0.2 `9000827…` all match. The publish job has never run, because it runs only on main.

### The criteria I set in advance: all met
- **Main only:** `push` + `refs/heads/main` + not a fork, on both the save step and the job. `workflow_dispatch`, `pull_request` and tags are all excluded.
- **`packages: write` only on publish:** the workflow default is `permissions: {}`. Publish is the only job with any write permission and the only one with `id-token: write` (also true across codeql.yml).
- **No secret build args:** the args are `APP_RELEASE` and `VITE_SENTRY_DSN` (public), plus `APP_RELEASE` for the backup image. `--provenance=false` means no BuildKit attestation exists that could record them. The GitHub attestation records the workflow, ref, SHA and run, not build args.
- **Attestations:** yes, all three digests, signed by Sigstore. With no predicate input, actions/attest v4 generates build provenance by default. Verifying them is still optional in the runbooks (F-67).
- **zizmor:** clean.
- **Publish runs no repository code:** no checkout. Only pinned, GitHub-owned actions and inline shell from the workflow file run. Every `${{ }}` in the `run:` blocks goes through `env:`. The docker login uses `--password-stdin` and is logged out by an EXIT trap before the attest steps.

### Artifact handoff (poisoning / TOCTOU): sound
- **The trust anchor is the job outputs, not the artifact.** `app_id`, `migrate_id` and `backup_id` are written by the image job's own step after `make image-smoke`, and no other job can set them.
  - The image ID is the config digest, and the config lists every layer's diff_id.
  - `docker load` checks each layer against those diff_ids. So once the loaded ref's ID equals the output, layer contents are fixed too: you would need a SHA-256 collision to swap anything.
- **Poisoning path:** a compromised npm dependency in `check`/`e2e` on the same main run could read `ACTIONS_RUNTIME_TOKEN` from runner memory (hosted runners have passwordless sudo). It could then create or replace an artifact in this run.
  - If it uploads first, the name collision makes the image job's upload fail, so nothing is published (DoS only).
  - If it deletes and re-uploads the artifact, the publish ID check refuses the result.
  - Residual (Info): the attacker's archive is parsed by `dockerd` on the publish runner *before* the ID check. Exploiting that needs a daemon tar-handling CVE. It is out of scope for a Low.
- **TOCTOU in the image job:** smoke, save and the ID read run in order in one job, against the same tag. image-smoke rebuilds only when a tag is missing, so the ID that gets saved is the one that was smoked. `image-save.sh` refuses a dirty tree, `HEAD != GITHUB_SHA` and a wrong revision label, so a `-dirty` build can't be handed on.
- **Pull-back check:** checking the image ID again after pulling by digest is close to a tautology. The digest is content-addressed, and the layers are already in the local store. Its real value is proving the image can be read anonymously and that tag → digest holds. That's fine; leave it.
- **Public artifact (1 day):** it holds the same bytes as the public packages. The image job has no secrets. No exposure, and consistent with the owner's public-packages ruling.

### WIF: the deployer binding refuses publish's token (with a caveat, F-66)
- Publish's OIDC `sub` has no `environment` part. This repository uses **immutable subject claims**: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` returns `use_immutable_subject: true` and `sub_claim_prefix: repo:<owner>@<owner_id>/<repo>@<repo_id>`.
  - So publish's `sub` is `<prefix>:ref:refs/heads/main`. That matches neither the step 6 binding (`repo:$GH_REPO:environment:production`) nor its immutable equivalent. Impersonating the deployer is **refused**.
- **But the provider's attribute condition admits it.** The condition is repo ID + owner ID + `ref=='refs/heads/main'`, so STS will exchange publish's token for a federated token. That token has no grants today. See F-66.

### Rekor disclosure: Info, nothing new
- For a public repository, actions/attest writes to public-good Sigstore. The Fulcio certificate and the Rekor entry are permanent and can't be deleted. They hold: repository and owner names and numeric IDs, the workflow path and ref, the commit SHA, the run ID and attempt, the trigger event, `github-hosted`, and the three image digests.
- All of that is already public through the repo, its Actions runs and the public packages. The entries stay even if the repository later goes private or is renamed. Accepted as Info.

### Backup image OS CVE scan: **follow-up, not a launch blocker** (F-68)
- **Why not a blocker:**
  - The job has no listener. It runs once a night as a Cloud Run job.
  - It talks only to Neon (`verify-full` TLS), the metadata server and GCS. Its input is pg_dump of our own database.
  - Exploiting an OS CVE would need a malicious or impersonated TLS peer.
  - The apk packages come from Alpine's signed repositories, fresh on every CI build: the runners are fresh and the build uses `--pull`. The base is pinned by digest and Dependabot bumps it.
- **The real gap is staleness:** the *deployed* backup digest changes only when the owner runs bootstrap 12g, and nothing scans any of the three images for OS packages.
- Unpinned apk versions are accepted: the deploy is by digest and the repositories are signed.

### F-66 Low (new, sre): WIF step 6, the subject format and the attribute condition. **Fixed and verified 2026-11-17**
- **Location:** docs/runbooks/bootstrap-production.md:102 and :107; infra/CLAUDE.md:77.
- **Scenario:**
  1. The repository issues immutable subjects, so the legitimate deploy job's `sub` is `<prefix>:environment:production`, not `repo:<owner>/<repo>:environment:production`. The binding as written fails closed and deploy authentication will not work.
  2. The plausible failure mode is an operator, mid-deploy, "fixing" this by binding `principalSet://…/attribute.repository_id/<id>` or `…/attribute.ref/refs/heads/main`. That would hand the deployer to publish, the first main job that can mint an OIDC token. It would also reach any future main job with `id-token: write`.
  3. Separately, the attribute condition accepts any main-branch token from this repo. Publish's token now gets a federated token with no grants: harmless today, one stray `principalSet` grant away from a problem.
- **Recommended fix (sre):**
  - Build the member from the API value:
    ```sh
    SUB_PREFIX=$(gh api "repos/$GH_REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix)
    # --member "principal://iam.googleapis.com/$POOL/subject/$SUB_PREFIX:environment:production"
    ```
    If `use_immutable_subject` is false, keep `repo:$GH_REPO`.
  - Add `&& assertion.environment=='production'` to the attribute condition, so STS refuses non-environment tokens outright.
  - Update infra/CLAUDE.md:77 to say "exact subject, immutable form".
  - Add a runbook line: if deploy auth fails, never widen to a `principalSet`; stop and tell the tech lead.
- **Owner:** sre. Fix before bootstrap step 6 runs; it blocks the first deploy anyway.

### F-67 Low (new, sre): the deploy copies by tag, and attestation verification is optional. **Fixed and verified 2026-11-17**
- **Location:** docs/runbooks/deploy.md:38–42; bootstrap-production.md:377 and :384–388; bootstrap 12g (backup image).
- **Scenario:** `DIGEST=$(crane digest TAG)` is followed by `crane copy TAG …`, so a re-pointed `sha-<sha>` tag between the two commands (or before both) goes to production unnoticed.
  - Only publish (main code) and the owner's credentials can write the packages, so this needs a repo-write or owner-token compromise. That's defense in depth, hence Low.
  - The attestation exists to catch exactly this, but the runbook marks checking it "optional".
- **Recommended fix (sre):** for each of app, migrate and backup:
  ```sh
  DIGEST=$(crane digest "$GHCR_IMAGE")
  gh attestation verify "oci://${GHCR_IMAGE%:*}@$DIGEST" --repo "$GH_REPO" \
    --signer-workflow "$GH_REPO/.github/workflows/ci.yml" --source-ref refs/heads/main --deny-self-hosted-runners
  crane copy "${GHCR_IMAGE%:*}@$DIGEST" "$AR_REPO:sha-$SHA"
  ```
  Make the verification mandatory: STOP on failure.
- **Owner:** sre. Before the first deploy (it's cheap), but not a security launch gate.

### F-68 Low (new, ci-engineer; sre for the deployed digest): no OS-package scan of the published images. **sre half done 2026-11-17; the ci-engineer scan is still open (follow-up)**
- **Location:** .github/workflows/ci.yml `image` job; Dockerfile.backup:18.
- **Scenario:** a known CVE in alpine's openssl, libpq, curl or musl (backup image), or in the distroless base (app and migrate), ships and stays deployed without anyone noticing. For the backup image this is mostly a staleness problem, because it isn't redeployed with app releases.
- **Recommended fix:**
  - ci-engineer: add a free image scan in the image job before `image-save.sh`, failing on High+ with a fixed version available. `osv-scanner scan image <tag>` (already in the toolchain) or grype/trivy, pinned by digest.
  - sre: in the deploy runbook, add a rule to roll the backup job's digest when the scan or Dependabot flags its base or packages.
- **Owner:** ci-engineer (scan), sre (rollout rule). **Follow-up**, after the first tester.

### Other checks: no issue
- **Backup smoke:** the throwaway password goes through `ALTER ROLE` on stdin, and the URL reaches the container by env name, not argv. The age key is generated inside the container. `metadata.google.internal` is mapped to 127.0.0.1, so no runner metadata is reached. `no_secrets_in` covers both runs, and the round trip proves the read-only `backup` role can dump every public table.
- **Dockerfile.backup:** the build context is `deploy/backup/` only. `backup.sh` is root-owned 0755 and its sha256 is checked against the repo. The image runs as user 10001 with an exact entrypoint check and no CMD. It holds no keys; the recipient and URL arrive at runtime.
- **Process note:** this diff edits docs/runbooks/bootstrap-production.md, which sre owns. The content is accurate, apart from the "optional" wording in F-67.

### Re-check 2026-11-17 (sre fixes): F-66 and F-67 verified
- **F-66:** the bootstrap step 6 condition now adds `assertion.environment=='production'`. The binding uses `$SUB_PREFIX:environment:production`, taken from the API, with a `case` check on the owner and repo IDs. The "never widen to a `principalSet`" rule is in step 6, deploy.md and infra/CLAUDE.md:77. Verify now expects exactly one member and no `principalSet`.
  - Info: the `case` prints STOP but doesn't halt the paste. With a bad prefix, the binding names a subject no token carries, so it fails closed.
- **F-67:** every GHCR→AR copy is now `crane digest`, then `gh attestation verify oci://…@$DIGEST` (`--repo`, `--signer-workflow …/ci.yml`, `--source-ref refs/heads/main`, `--deny-self-hosted-runners`), then `&& crane copy …@$DIGEST`. That covers deploy.md step 1, bootstrap step 12 and 12g, and README.
  - An unattested digest is never copied, so the later `$AR_REPO@$DIGEST` deploy fails closed.
- **F-68 (sre half):** done, in "Rolling the backup image".
- **sre's question, binding to the commit:** the flags prove "built on main by ci.yml", not "built from `$SHA`". So someone with package write could re-point `sha-<X>` to an *older* attested main digest: a downgrade to a release with a known flaw, or app and migrate from different commits. That's the same precondition as F-67, so it is not a launch blocker.
  - But the fix is one flag: `gh` 2.97 supports `--source-digest`. **Recommended now, folded into F-67:** add `--source-digest "$SHA"` (`"$BACKUP_SHA"` in 12g, and the same in the future deploy.yml) to every verify.
  - That also binds app and migrate to the same commit. I'm not reopening F-67 for it.

## Review 2026-11-17: fix/ci-publish-handoff (apt .deb cache, SKIP_BROWSERS, image-save mkdir)

### F-69 Low (new, ci-engineer): cached .debs are trusted by size only, and the comments say otherwise. **Fixed and verified 2026-11-17 (same branch)**
- **Location:** .github/scripts/setup.sh:6-7 and `ci_apt_cache` (lines 16-25); .github/workflows/ci.yml:70-81 (cache step comment and `restore-keys`).
- **The comment is wrong.** apt 2.7.x (Ubuntu 24.04) `pkgAcqArchive::QueueNext` accepts a file already in `Dir::Cache::Archives` when its *size* equals the index's `Size`, and marks it done without hashing it (verified in apt 2.7.14 `apt-pkg/acquire-item.cc:3494-3507`). dpkg then installs it as root with no signature check. Only freshly downloaded .debs are checked against the signed index.
- **Scenario:** code running in any main-branch job can write a main-scoped cache entry, for example a compromised dev dependency in `check`'s `pnpm install` or unit tests (the runtime token is reachable with the runner's passwordless sudo, as in Cacheract). It saves `playwright-apt-Linux-<hash>` holding a same-size trojaned .deb, either before e2e saves the exact key or as a newer prefix match. Every later main e2e run installs that .deb as root. Because `restore-keys` restores it and the next save copies it forward, and `autoclean` keeps any filename the index still lists, the foothold survives lockfile changes and a revert of the bad dependency.
- **Not reachable:** PR and Dependabot caches are scoped to `refs/pull/N/merge`, and main never restores them, so a fork or Dependabot PR alone cannot poison main. The images don't cross either. `image` uses no actions/cache and builds in Docker, and `publish` loads the artifact and checks each image ID against the `image` job's outputs before pushing. e2e has `contents: read` and no secrets. The worst case is a forged e2e pass plus persistence for re-poisoning other main caches. The existing `~/.cache/ms-playwright` entry already gave the same code execution through unverified browser binaries, so the change adds little new exposure. That is why this is Low.
- **Recommended fix (ci-engineer):**
  - Correct the comments in setup.sh and ci.yml: say apt trusts cached .debs by size.
  - In `ci_apt_cache`, run `sudo apt-get update`, then delete every cached `*.deb` whose SHA256 doesn't match the signed index. Get the expected hash with `dpkg-deb -f <deb> Package Version Architecture`, then `apt-cache show "<pkg>:<arch>=<ver>"`, then the `SHA256:` field. Delete the file if it isn't in the index or the hash differs. That restores the property the comment claims, costs seconds, and leaves `restore-keys` safe.
  - Fallback if the check isn't wanted: drop `restore-keys`, so a poisoned entry dies at the next lockfile change, and fix the comments.
- **Owner:** ci-engineer.

### Other checks: no issue
- `SKIP_BROWSERS=1` only skips the browser install in `check`. `image-save.sh`'s `mkdir -p` targets `$RUNNER_TEMP/images`. No permission, action or pin changed, and the timeout rise is fine. The `/etc/apt/apt.conf.d/99-shoestring-ci` write and `chown` run on ephemeral runners only (Linux + `CI=true`).

### Re-check 2026-11-17: F-69 verified
- **The fix:** `ci_apt_cache` now runs these steps in order.
  1. Removes the cache dir if it's a symlink or not a directory.
  2. Deletes every top-level entry that isn't a regular `*.deb`. That covers symlinks, dirs, `partial/` and the lock. `find ! -type f` doesn't follow links.
  3. Writes the apt conf, then runs `sudo apt-get update`.
  4. Keeps a .deb only if `dpkg-deb -W` reads it, its filename is apt's canonical `<pkg>_<ver %3a>_<arch>.deb`, and its sha256 appears as an exact `SHA256:` line in `apt-cache show pkg:arch=ver`, which comes from the root-owned, freshly updated, signed lists. Every other file is deleted.
  
  Every failure path deletes the file and apt downloads it again, which is fail-closed. Nothing writes the dir between the check and playwright's install. The ci.yml and setup.sh comments are now accurate, so keeping `restore-keys` is fine.
- **Residual, not new and accepted as Low:** `~/.cache/ms-playwright` browser binaries are still restored without verification, as they were before this branch. Reaching them still needs code running in a main-branch job, and they can't reach the images because publish checks the image IDs.

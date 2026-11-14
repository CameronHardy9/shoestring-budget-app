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

## Summary
| ID | Sev | Owner → implements | Issue (first review) | Status | Note (re-review 2026-11-13) |
|---|---|---|---|---|---|
| F-01 | **High** | architect → backend, data | Open email-change and reset tokens survive recovery; confirm needed only the token; no cancel path | contract-fixed | Revocation deletes tokens, confirm is session-bound, cancel/revert link added; the chain is closed (F-33). Residual R-11 accepted by the owner on 2026-11-13 |
| F-02 | **High** | architect, sre → backend, ci | Admin CLI in public Actions; emails in output; secret sprawl | contract-fixed | Cloud Run jobs only, no emails in output, least config per job. Ops runbook confirms (two-step `--expect-user-id`, no retries, keyring never on `shoestring-admin`, private admin log). Note: the CLI must reject an email containing `,`, because `--args` is comma-joined, or `job_run` should use a custom gcloud delimiter such as `^;^` |
| F-03 | **High** | sre → **owner** | No MFA required on operator accounts | partially-fixed | ADR-0007 constraint 7; bootstrap step 1 checklist is good, but **it omits the account that syncs the passkeys** (Apple ID, iCloud Keychain, or the password manager if it stores them). That account is the root of every "phishing-resistant" factor. **Blocking for the ops PR: add that row** |
| F-04 | Medium | architect → data, backend | Recovery codes as unsalted SHA-256 | verified | HMAC with the `recovery-code-v1` HKDF subkey, constant-time compare. **Verified 2026-11-14:** backend/src/auth/recovery-codes.ts, per-row key ID, every row compared, tests in factors.test.ts |
| F-05 | Medium | architect → backend | MFA failure limits per endpoint | contract-fixed | One per-user budget, 20 per 24 h, across verify, reauth and reset; `mfa_locked` plus email |
| F-06 | Medium | architect → frontend, backend, sre | Fragment tokens leak | contract-fixed | `replaceState` before Sentry init, URL stripping, tracking off |
| F-07 | Medium | architect → backend, frontend, sre | Error paths bypass redaction | contract-fixed | Allowlist serializer with a DB-error fixture test; Sentry SDK and project settings specified. **Backend half verified 2026-11-14** (logging.ts serializer, fixture test, commit-time 23503 test); Sentry init and the frontend are still to come |
| F-08 | Medium | architect, sre → backend | Client-IP derivation | contract-fixed | Hop count, never `true`; IPv6 /64. `trustProxy = 1` must be confirmed by V26 before launch. **Backend half verified 2026-11-14** (hop-count trust function, `TRUST_PROXY_HOPS` required in production, forged-XFF test) |
| F-09 | Medium | architect → backend, sre | Email quota exhaustion | contract-fixed | 5 per 24 h per email, 60 per day app budget, priority mail, alert. Deviation 4 accepted |
| F-10 | Medium | architect → backend, ci, sre | Test hooks vs one image | verified | **Verified 2026-11-14** (build and image: hardened dist tripwire, `make image-smoke` /app allowlist plus sentinel scan over all of /app plus 404 probes); the post-deploy probe (sre) is still pending. ADR-0009; the tripwire matches the `__SHOESTRING_TEST_HOOKS__` sentinel and `_test`. If `_test` false-positives on bundled code, ci may narrow that half, but **never drop the sentinel** |
| F-11 | Medium | architect, sre → backend | Restore resurrects access | contract-fixed | restore.md follows the contract order (restore, `revoke-sessions --all --yes --restore`, purge, reopen, re-apply post-restore security actions, BCC notice). Note: after `db/roles.sql`, verify that `app` has only INSERT/SELECT on `security_events` and that `purge_security_events()` is owned by `migrator` |
| F-12 | Medium | architect → backend | Detective controls for optional MFA | contract-fixed | All notices are priority mail; the new-sign-in notice goes out on every sign-in (F-34) |
| F-13 | Medium | architect → backend, frontend | Invitations without re-auth | contract-fixed | `x-reauth: true` on invite and on ownership transfer |
| F-14 | Medium | architect → backend | No budget recovery path | contract-fixed | Replaced by self-service restore (OD-5, ADR-0010) with notices to members. Scope construction: F-36 |
| F-15 | Medium | architect, sre → backend | argon2id DoS / denial of wallet | contract-fixed | Semaphore of 4, 2 s queue, then 503; max 2 instances × 512 MiB |
| F-16 | Medium | ci-engineer, sre | Supply chain | contract-fixed | ADR-0008 (pnpm 10.34.9, blocked scripts, 7-day release age, no-downgrade) and the WIF pin in ADR-0007 constraint 6. ci implements |
| F-17 | Medium | sre → ci | Backup storage and credentials | contract-fixed | Cloud Run job, read-only role in Secret Manager, age public key, `objectCreator` create-only (`ifGenerationMatch=0`), separate project, lifecycle 34 d. The claim "a compromised deploy can't redirect the dump" does not hold yet: F-39 |
| F-18 | Medium | architect → data, backend, ci, tests | Isolation by convention | contract-fixed | Semgrep rules, explicit extensions plus the startup check, body-ID 400, replay and export scope, cursor MAC. Deleted-budget routes: F-36 |
| F-19 | Low | architect | No absolute session lifetime | contract-fixed | 90-day cap (OD-2) with DB `CHECK` constraints |
| F-20 | Low | architect → backend | Pending-session eviction; device labels | contract-fixed | Separate caps; fixed `DeviceBrowser`/`DeviceOs` enums |
| F-21 | Low | architect → backend | Login lockout DoS | contract-fixed | (email, IP) key, 100 per day per-email ceiling with notice, reset clears counters |
| F-22 | Low | architect → backend | Enumeration timing | contract-fixed | Deviation 1 accepted: inline send, 700 ms timeout, fixed 1 s |
| F-23 | Low | architect → frontend, backend | CSP and headers | contract-fixed | CORP, XFO, `report-to`, exact Sentry host, Host check, violation gate in e2e |
| F-24 | Low | architect → backend | Crypto details | contract-fixed | `APP_KEYRING` accepted; rotate-secret.md's three stages, roll-forward rule, candidate readyz gate and vault-B escrow are correct. The compromise-mode deletion of recovery codes is **not** covered: F-38 |
| F-25 | Low | architect → data, backend | Deletion/acceptance race | verified | Row locks and purge re-check. The two checks disagree on deleted budgets: F-35. **Verified 2026-11-13** (db tests: acceptance vs deletion request serialized; purge skip-and-fail) |
| F-26 | Low | architect → data, backend | Audit log | verified | INSERT/SELECT only, `SECURITY DEFINER` purge, new types, `budget_id`; `security-events` command (deviation 6 accepted). **Verified 2026-11-13:** roles.sql verify block plus tests (app cannot UPDATE/DELETE events, function owned by migrator, cascade on user purge) |
| F-27 | Low | ci, **owner** | Public disclosure | open | Decided (OD-6). SECURITY.md and private vulnerability reporting still to be added before launch |
| F-28 | Low | architect, ci, sre | Config hygiene | contract-fixed | Migrator URL only on the migrate job; `verify-full` refused otherwise; `.gitignore` still with ci |
| F-29 | Low | architect → backend, sre | Email content injection, DMARC | contract-fixed | Escaped plain text; DMARC ramps to `p=reject` |
| F-30 | Low | ci, backend | Hooks on the LAN | contract-fixed | The origin tripwire keeps hooks off LAN origins |
| F-31 | Low | architect | Invitation list bound | contract-fixed | 20 pending per invitee email; `maxItems: 20` |
| F-32 | Low | frontend | bfcache after sign-out | contract-fixed | ARCHITECTURE: re-check on `pageshow.persisted` before rendering |
| **F-33** | **High** | architect → backend, data | **New (rev 2):** cancelling with a *later* cancel token deleted the victim's earlier one | contract-fixed | auth.md §9 and §14, the OpenAPI descriptions and data-model: an earlier token wins, one change per 24 h (429), both addresses emailed, two regression tests (API, plus a DAL-seeded chain). Verified against the text 2026-11-13 |
| **F-34** | Medium | architect → backend | **New (rev 2):** new-sign-in notice skipped for a previously seen browser/OS | contract-fixed | auth.md §15: sent on every successful sign-in, no skip rule |
| F-35 | Low | architect → data | **New (rev 2):** deletion request and purge disagreed on soft-deleted budgets | verified | Same rule (non-deleted) in both; soft-deleted owned budgets are hard-deleted with the owner; the deletion email says so. **Verified 2026-11-13:** one shared function (`lockOwnedBudgetsAndCheckShared`) and tests for both paths |
| F-36 | Low | architect → data, backend, tests | **New (rev 2):** deleted-budget routes outside the scope machinery | contract-fixed | `x-budget-role: deleted_budget_owner` plus `DeletedBudgetScope` from `requireDeletedBudgetOwnership()`; startup check and permission tests cover it. The list route is user-scoped |
| F-37 | Low | architect → backend | **New (rev 3):** a restore can push other members past 10 budgets, but `BudgetList.maxItems` is 10 | open | Not blocking; see details |
| F-38 | Low | architect → backend, sre | **New (ops):** no way to retire recovery codes on a burned keyring key; stage 3 can't remove a compromised key until every user regenerates | open | Not blocking |
| F-39 | Low | sre | **New (ops):** project-level `roles/run.developer` lets the deployer execute (with env overrides) or delete `shoestring-backup`, undoing its isolation; the restore runbook picks the newest object without a provenance check | open | Not blocking; fix before launch |
| F-40 | Low | sre | **New (ops):** key material moves through the macOS clipboard (Universal Clipboard and clipboard history) and process arguments; a restore-drill note suggests running the app locally on a copy of production data | open | Not blocking |
| F-41 | Medium | data-engineer, ci-engineer | **New (data layer):** a scope can be minted outside `requireMembership`. `issueBudgetScope` is exported, and relative imports into `db/src` get around the package boundary and the Semgrep rules | verified | **Verified 2026-11-13 (re-check):** `issueBudgetScope` is module-private, with a test that it is not exported. New Semgrep rules: `shoestring-db-internal-import`, `shoestring-kysely-import-outside-db` and `shoestring-issue-budget-scope-outside-scope-module`. The DeletedBudgetScope cast rule no longer excludes the test. audit.sh now scans `tests/` |
| F-42 | Low | data-engineer | **New (data layer):** the "local host only" guards in the migrate CLI and `@shoestring/db/testing` can be bypassed with a `?host=` URL parameter; no `verify-full` check on a non-local migrator URL | verified | **Verified 2026-11-13 (re-check):** `db/src/conn.ts` takes the host from pg's own parser, refuses `host`/`hostaddr` and ambiguous hosts, and requires `verify-full` for a remote migrator URL. Used by migrate, seed and testing, with tests |
| F-43 | Low | data-engineer | **New (data layer):** the seed CLI has no environment guard and ships in the production image (`files: src, dist`) | verified | **Verified 2026-11-13 (re-check):** refuses `NODE_ENV=production` and non-local hosts (tested). `files` and `tsconfig.build.json` exclude the seed, `testing` and test support |
| F-44 | Low | data-engineer | **New (data layer):** `app` can still create temporary objects (PUBLIC keeps `TEMPORARY` on the database), contrary to "no DDL" | verified | **Verified 2026-11-13 (re-check):** `REVOKE ALL ON DATABASE … FROM PUBLIC` and `REVOKE TEMPORARY` from the three roles. The verify block fails on TEMPORARY, and a test shows temp tables and `pg_temp` functions are refused. Note for sre: on an existing database, run roles.sql as the owner before the next migrate, or the verify block stops the migrate job (it fails closed) |
| **F-45** | Medium | backend-engineer, data-engineer, test-engineer | **New (backend):** MFA failure limits are read before the factor check and written after it, so one parallel burst gets far more guesses than 5 per session or token and 20 per user per 24 h | verified | **Fixed in this PR (owner ruling 2026-11-14) and verified:** atomic slot reservation (DAL), reserve-first user budget with refunds, `AttemptGuard`; 50-way tests on real Postgres and in the backend |
| F-46 | Low | backend-engineer | **New (backend):** the in-memory limiter map grows without bound; above 10,000 keys every request runs a full sweep that frees nothing | verified | **Verified 2026-11-14:** windows expire by end time, unref'd timer sweep, cap of 50,000 (oldest evicted); rate-limit.test.ts |
| F-47 | Low | ci-engineer, backend-engineer | **New (backend):** the production image contains backend `src/` (test-hooks.ts, dev-server.ts, test support), because `pnpm deploy` copies the whole package | verified | **Verified 2026-11-14:** backend `files: ["dist"]`; the Dockerfile copies only package.json, dist and node_modules; `make image-smoke` passed (allowlist, sentinel absent from all of /app). The earlier exposure is assessed under Final pass |
| F-48 | Low | backend-engineer (architect for the text rule) | **New (backend):** plain-text defanging misses Unicode dot equivalents and bidi controls in budget and display names | verified | **Verified 2026-11-14:** bidi controls rejected by `text()` and by `is_clean_text` (migration 20261114000100), stripped in mail; NFKC, then replacements that survive NFKC and the URL parser; tests in db and backend |
| F-49 | Low | data-engineer | **New (final pass):** a deleted-budget restore racing the owner's own deletion request can succeed, because the owner's status is read in the locking statement and never re-read after `lockUser` | deferred | **Deferred by the owner (2026-11-14)** to a later PR; the architect's note is in data-model.md (lock order). Fix before launch |

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
- **Location:** ARCHITECTURE.md:72.
- **Notes and recommended change:**
  - React's `style={…}` writes through CSSOM, which `style-src 'self'` allows. Some Radix parts (Dialog's scroll lock through `react-remove-scroll-bar`, ScrollArea) inject `<style>` elements, which it blocks. Prefer React Aria for those primitives, or confirm each Radix part in an e2e test. Add an e2e assertion that **any `securitypolicyviolation` event fails the test**. If a style exception is unavoidable, the only acceptable relaxation is `style-src-elem 'self' 'unsafe-inline'`, and only with security sign-off. `script-src` never relaxes.
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


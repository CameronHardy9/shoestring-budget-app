# MVP security checklist (ASVS 5.0 Level 2 based)
Owner: security-reviewer. Each item has one **owning agent** who implements it and proves it. security-reviewer verifies it in the diff review, and test-engineer adds the regression test where the "Verified by" column says *test*.

This is a tailored subset of OWASP ASVS 5.0 at Level 2, grouped by ASVS chapter, plus project-specific items from the contracts. It is not a verbatim copy of ASVS. Chapters that do not apply: V9 Self-contained Tokens (no JWTs), V10 OAuth/OIDC (none), V17 WebRTC (none). V5 File Handling applies only to the CSV export.

Status: `todo` · `done` (with a PR or commit reference) · `n/a` (with a reason). `F-xx` refers to FINDINGS.md.

Revision: 2026-11-13 (ops review: F-38 to F-40). Updated for contract revision 2: ADR-0007 hosting, ADR-0008 pnpm, ADR-0009 test hooks, ADR-0010 lifecycle, and the new findings F-33 to F-36.

## V1 Encoding and sanitization
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C1.1 | All DB access is parameterized through Kysely. No string-built SQL; raw `sql` only inside `db/` with bound parameters | data-engineer | Semgrep rule in `make audit` (ci) | todo |
| C1.2 | React escaping only: no `dangerouslySetInnerHTML`, no `href`/`src` built from user data, no `eval`/`new Function` | frontend-engineer | ESLint rules (`react/no-danger`, `no-script-url`) in `make check` | todo |
| C1.3 | CSV export: every **user-text** cell (budget name, category, payee, memo, created_by) starting with `= + - @ \t \r` is prefixed with `'`; every field is RFC 4180-quoted; amounts are generated from integers and never negative | backend-engineer | unit test with a malicious-payee fixture | todo |
| C1.4 | Email templates escape user text (budget and display names), plain text, never linkified; links only from `APP_ORIGIN` (F-29) | backend-engineer | unit test | todo |
| C1.5 | Logs are JSON (pino); `X-Request-Id` is accepted only if it matches `^[A-Za-z0-9-]{8,64}$` (no log injection) | backend-engineer | unit test | todo |

## V2 Validation and business logic
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C2.1 | zod schemas for every path, query, header and body; unknown fields rejected; 64 KiB body limit; JSON only (415 otherwise) | backend-engineer | contract tests (Schemathesis-style) | todo |
| C2.2 | Text is trimmed, NFC-normalized, control characters rejected, lengths counted in code points, in the API and by DB `CHECK` | backend-engineer, data-engineer | unit + migration tests | todo |
| C2.3 | Money: integer cents only, range-checked in the API and the DB; splits sum enforced by a deferred trigger | data-engineer | 100% branch coverage gate | todo |
| C2.4 | Foreign IDs in bodies (`splits[].categoryId`) are validated within the budget before writing: 400 `invalid_value`, never an FK 500 (F-18) | backend-engineer | isolation test | todo |
| C2.5 | Idempotency: key bound to (user, method, route, params, body hash); replay goes through `BudgetScope` and hides soft-deleted rows (F-18) | backend-engineer | contract test | todo |
| C2.6 | Limits from data-model.md "Limits" are enforced under concurrency (budget-row lock on invitation acceptance and deletion request: F-25) | data-engineer | concurrency integration test | todo |
| C2.7 | Rate limits per auth.md §14 rev 2: the per-user MFA failure budget, 20 per 24 h (F-05); (email, IP) login key plus a per-email ceiling of 100 per day (F-21); IPv6 /64 keying (F-08); per-email reset limits of 3 per hour and 5 per 24 h; app email budget of 60 per day with priority classification and an owner alert (F-09); one email change per 24 h while a cancel token is open (F-33) | backend-engineer | integration tests with a frozen clock | todo |
| C2.8 | Password hashing behind a per-instance concurrency semaphore (F-15) | backend-engineer | load test | todo |

## V3 Web frontend security
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C3.1 | CSP exactly as in ARCHITECTURE.md (`script-src 'self'`, no `unsafe-inline`/`unsafe-eval`), exact Sentry ingest host, `report-to` (F-23) | backend-engineer (header), frontend-engineer (compatibility) | e2e fails on any `securitypolicyviolation` | todo |
| C3.2 | Headers on every response: HSTS (1 year, includeSubDomains), nosniff, `Referrer-Policy: no-referrer`, COOP same-origin, CORP same-origin, `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, Permissions-Policy | backend-engineer | integration test over every route | todo |
| C3.3 | Cookie: `__Host-ss_sid; Path=/; Secure; HttpOnly; SameSite=Strict`; the backend refuses `COOKIE_SECURE=false` in production | backend-engineer | integration test + config unit test | todo |
| C3.4 | Service worker precaches only the app shell; `/api/*` is network-only; no API data in Cache Storage, localStorage or IndexedDB (only theme and last budget ID) | frontend-engineer | e2e inspects storage after J2–J4 | todo |
| C3.5 | Sign-out clears in-memory caches, does a full `location.replace`, and handles `pageshow.persisted` (F-32; the pageshow part is not yet written into ARCHITECTURE) | frontend-engineer | e2e | todo |
| C3.6 | Fragment tokens are read and removed with `history.replaceState` before Sentry initializes or any route renders; the token is held in memory only (F-06) | frontend-engineer | e2e asserts `location.hash === ''` | todo |
| C3.7 | CSRF token held in memory only; sent as `X-CSRF-Token` on every unsafe request | frontend-engineer | unit test of the API wrapper | todo |
| C3.8 | Self-hosted fonts; no third-party scripts, styles or images; QR rendered client-side | frontend-engineer | CSP + network assertion in e2e | todo |

## V4 API and web service
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C4.1 | Same origin; no `Access-Control-Allow-*` headers on any response | backend-engineer | integration test | todo |
| C4.2 | CSRF on every unsafe method, before body parsing: exact `Origin` == `APP_ORIGIN`, or `Sec-Fetch-Site: same-origin` when Origin is absent; session-bound token for session-bearing routes | backend-engineer | generated permission tests (cross-origin, null origin, missing token) | todo |
| C4.3 | `Host` must equal the `APP_ORIGIN` host (F-23) | backend-engineer | integration test | todo |
| C4.4 | `Cache-Control: no-store` on every `/api` response, errors included | backend-engineer | contract test | todo |
| C4.5 | GET never changes state (the sliding-session `last_seen_at` touch is the only exception) | backend-engineer | review | todo |
| C4.6 | One `ErrorBody` everywhere; messages never echo values; 404 for non-visible resources | backend-engineer | contract tests | todo |

## V5 File handling (CSV export only)
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C5.1 | Export response: `text/csv; charset=utf-8`, `Content-Disposition: attachment` with a server-built filename, `no-store`, nosniff; streamed, not buffered | backend-engineer | integration test | todo |

## V6 Authentication
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C6.1 | argon2id ≥ m=19 MiB, t=2, p=1, PHC string, rehash on login when parameters change | backend-engineer | unit test | todo |
| C6.2 | Password policy 12–128 code points, no composition rules, not the email; HIBP with `Add-Padding`, 2 s timeout, bundled fallback; `HIBP_ENABLED` forced on in production (F-24) | backend-engineer | unit test + config test | todo |
| C6.3 | Login: same 401 for unknown email and wrong password; dummy-hash verify; same timing within noise | backend-engineer | integration timing test | todo |
| C6.4 | Sign-up only from an owner-created invite; email taken from the invite; invite consumed in the same transaction | backend-engineer | integration test | todo |
| C6.5 | Password reset: 30 min single-use token; MFA required when enabled; passkey challenge bound to the token; 5 failures invalidate it; all sessions revoked | backend-engineer | integration tests incl. MFA bypass attempts | todo |
| C6.6 | Every revocation event deletes open `user_tokens` except `email_change_cancel`. Email-change confirm requires the requester's own session. **Cancel tokens:** using one deletes only cancel tokens created *after* it; the cancel or revert notice goes to both addresses (F-01, F-33) | backend-engineer, data-engineer | regression tests: reset, then confirm, gives TOKEN_INVALID; the chain A→B→C where `cancel_B` leaves `cancel_A` working | todo |
| C6.7 | TOTP: RFC 6238, ±1 step, replay rejected (`last_used_step`), secret encrypted (AES-256-GCM, AAD user_id, key ID) (F-24) | backend-engineer | unit tests | todo |
| C6.8 | Passkeys: maintained library; RP ID = host; exact expected origin; `attestation: none`; explicit `allowCredentials`; counter regression handling; random opaque `user.id` handle (not the email) | backend-engineer | unit tests with library fixtures | todo |
| C6.9 | Recovery codes: 10 codes, ≥ 50 bits, single use, stored as HMAC-SHA-256 with an HKDF subkey (F-04); use triggers an email | backend-engineer, data-engineer | unit test | todo |
| C6.10 | Re-auth window of 10 minutes on every `x-reauth: true` route, including invitation creation (F-13) | backend-engineer | generated permission tests | todo |
| C6.11 | Notification emails per auth.md §15 rev 2, priority flags included. The **new-sign-in notice is sent on every successful sign-in**, with no same-browser/OS skip (F-34) | backend-engineer | e2e via the test outbox, including a second sign-in with the same User-Agent | todo |
| C6.12 | Enumeration-sensitive endpoints: identical responses, email queued after commit, padded to 1 s (F-22) | backend-engineer | timing test | todo |

## V7 Session management
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C7.1 | 32-byte CSPRNG token; only SHA-256 stored; never in logs, URLs or bodies | backend-engineer | unit test + log redaction test | todo |
| C7.2 | Rotation on sign-up, login and MFA completion; an existing cookie at login is revoked | backend-engineer | integration test | todo |
| C7.3 | Sliding 30-day expiry with an hourly touch, plus a 90-day `absolute_expires_at` (OD-2) enforced by DB `CHECK`s. `mfa_pending` sessions last 10 min, are not extended, and have their own cap of 5 (F-20) | backend-engineer, data-engineer | integration test with a frozen clock | todo |
| C7.4 | Device list: fixed-vocabulary label (F-20), revoke one, revoke others; others' session IDs give 404 | backend-engineer | integration test | todo |
| C7.5 | Logout and every revocation take effect on the next request (no session cache) | backend-engineer | integration test | todo |

## V8 Authorization
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C8.1 | Route table built from the contract; startup fails if any route lacks `x-session`, or if a `{budgetId}` path lacks `x-budget-role`; extensions stated explicitly (F-18) | backend-engineer | unit test that starts with a bad route table | todo |
| C8.2 | `BudgetScope` constructed only by `requireMembership`; Semgrep bans `as BudgetScope`, `db`/`sql` imports outside `db/`, and DAL functions that take a raw `budgetId` (F-18) | data-engineer (DAL), ci-engineer (rule) | `make audit` | todo |
| C8.3 | Non-member or deleted budget gives 404; role gives 403; sub-resources looked up within the scope | backend-engineer | generated permission matrix (anonymous, non-member, member, owner) | todo |
| C8.4 | Two-household isolation suite: every DAL function, and every endpoint, with budget A's scope against seeded budget B | test-engineer | `make e2e` | todo |
| C8.5 | Composite FKs `(budget_id, id)` on every child table | data-engineer | migration test that tries a cross-budget insert | todo |
| C8.6 | Budget invitation accept: pending, unexpired, budget not deleted, owner active, caller email matches, not a member, under 6 members, in one locked transaction | backend-engineer, data-engineer | integration test | todo |
| C8.7 | Pending-deletion accounts reach only `x-pending-deletion-allowed` routes | backend-engineer | generated permission tests | todo |
| C8.8 | Export builds one `BudgetScope` per membership through `requireMembership` (F-18) | backend-engineer | isolation test | todo |
| C8.9 | Deleted-budget list and restore use a branded `DeletedBudgetScope` from `requireDeletedBudgetOwnership()` (owner membership, deleted ≤ 30 days, row lock). Both routes are in the generated permission tests and the isolation suite (F-36) | data-engineer, backend-engineer, test-engineer | permission tests: other user, member and ex-member all get 404 | todo |
| C8.10 | Ownership transfer: owner only, re-auth, active-member target, row lock, demote then promote, deferred one-owner trigger, priority notice to all members (ADR-0010) | backend-engineer, data-engineer | integration + concurrency test | todo |

## V11 Cryptography
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C11.1 | Only Node `crypto` plus maintained libraries (argon2, SimpleWebAuthn, otplib-class); no custom primitives | backend-engineer | review | todo |
| C11.2 | Constant-time comparison for CSRF tokens, recovery-code HMACs and token hashes | backend-engineer | review + unit test | todo |
| C11.3 | `APP_KEYRING`: JSON with `current` and 32-byte keys per environment, validated at startup; HKDF subkeys `totp-v1`, `recovery-code-v1`, `throttle-v1`, `cursor-v1`; per-row `key_id`; `rewrap-mfa` runbook; readyz fails on a missing key ID without naming it; escrow in a separate vault (F-24) | backend-engineer, sre | config test + runbook + rotation drill | todo |

## V12 Secure communication
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C12.1 | TLS everywhere with platform-managed certificates; HSTS; HTTP redirects to HTTPS at the edge | sre | external scan before launch | todo |
| C12.2 | DB connections use `sslmode=verify-full`; outbound HTTPS (email provider, HIBP, Sentry) verifies certificates | backend-engineer, sre | config review | todo |

## V13 Configuration
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C13.1 | zod config validation at startup; fail closed if `NODE_ENV` is missing; refuse `COOKIE_SECURE=false`, `TEST_HOOKS=1`, `EMAIL_TRANSPORT≠provider` and `HIBP_ENABLED=false` in production | backend-engineer | unit test | todo |
| C13.2 | Test hooks live only in the dev entry (`src/dev-server.ts`; ADR-0009). The prod Docker target sets `NODE_ENV=production` and fails if `backend/dist/` contains `_test` or the hooks' sentinel string (F-10 note). Config fails closed without `NODE_ENV`. Origin tripwire. Prod-image smoke job and post-deploy probe: `/api/_test/reset` gives 404 | ci-engineer, backend-engineer, sre | `make audit` + smoke job + deploy probe | todo |
| C13.3 | `trustProxy` equals the exact hop count (Cloud Run domain mapping: 1, confirmed by V26) and is never `true`. The Cloudflare-proxy fallback trusts `CF-Connecting-IP` only with the shared-secret header, and needs security sign-off before the switch (F-08) | sre (value), backend-engineer | integration test with a forged X-Forwarded-For | todo |
| C13.4 | Secrets in Secret Manager; GitHub holds no secrets. `MIGRATOR_DATABASE_URL` only on `shoestring-migrate`. Admin commands only as Cloud Run jobs, each mounting only its own secrets; the CLI rejects `,` in emails. Deployer IAM scoped to the service and the jobs it manages (F-02, F-28, F-39). Operator handling: Handoff and clipboard managers off, or the password-manager CLI, for key material (F-40) | sre, backend-engineer | IAM and job definition review | todo |
| C13.5 | `.env.example` documents every variable with safe placeholders; `.gitignore` covers `.env.*` except `.env.example` | ci-engineer | gitleaks in `make audit` | todo |
| C13.6 | Container: multi-stage, non-root, base image pinned by digest, no dev dependencies or source maps in the prod image | ci-engineer | image scan in CI | todo |
| C13.7 | Cloud Run: max instances 2, concurrency 20, 512 MiB, no `--no-cpu-throttling`, min 0. Cloud Billing spend cap plus a $0.01 alert, with V0 verified (R-10, F-15). When the cap pauses Cloud Run, run `purge` manually after lifting it (deletions slip by the pause length; disclosed in the privacy notice) | sre | ADR-0007 + cost sheet + billing-alert.md | todo |

## V14 Data protection
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C14.1 | Data classification in data-model.md kept current, including the additions in THREAT_MODEL §2 | architect | review per contract change | todo |
| C14.2 | No Sensitive or PII values in URLs or query strings (only IDs, month, limit, cursor, flags) | architect, backend-engineer | contract review + log test | todo |
| C14.3 | Purge per data-model.md, idempotent, with `--dry-run`. Row locks on deletion request, acceptance and transfer. The purge re-check fails the run instead of deleting a shared budget (F-25). The deletion-request and purge checks use the **same** rule for soft-deleted budgets (F-35) | backend-engineer, data-engineer | integration test with a frozen clock, plus a concurrency test | todo |
| C14.4 | Backups (OD-4, ADR-0007): the Cloud Run job `shoestring-backup` (backup secret only, triggered by Cloud Scheduler after purge) runs `pg_dump` as the read-only `backup` role and pipes it through `age` to the owner's public key, into a private GCS bucket in a separate project (34-day lifecycle, `objectCreator` create-only with `ifGenerationMatch=0`, public access prevention enforced). The deployer has **no** project-level `run.developer` reaching the backup job (F-39). No cap on the backup bucket, alert only. Heartbeat plus the monthly execution-history check. The `age` key and the keyring escrow are kept in separate vaults (F-17) | sre, data-engineer | job and IAM review + restore drill record | todo |
| C14.5 | Restore runbook: ingress internal; choose the object only after a provenance check (its `timeCreated` matches a successful scheduled execution, F-39); `trap` removes the key file; after `roles.sql`, verify `app` has INSERT/SELECT only on `security_events` and `migrator` owns `purge_security_events()`; then `revoke-sessions --all --yes --restore`, `purge --yes`, reopen, re-apply post-restore security actions, BCC notice | sre, backend-engineer | drill | todo |
| C14.6 | Privacy notice for beta users covering: what is stored; co-member visibility and export; authored entries surviving a purge; third parties (Resend, Cloud Run logs, Sentry, HIBP, Neon, Cloudflare) and their retention; the 30 + 35-day deletion timeline; **admin-job records in GCP that may outlast it (R-12)**; the 24 h email-change revert (R-11) | security-reviewer | owner approval | todo |

## V15 Secure coding, architecture and dependencies
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C15.1 | pnpm 10.34.9 via `packageManager`; `--frozen-lockfile`; build scripts blocked except `onlyBuiltDependencies`; `minimumReleaseAge` 7 days; trust policy `no-downgrade`. Exclusions and allowlist additions are reviewed by security-reviewer (ADR-0008, F-16) | ci-engineer | CI config review | todo |
| C15.2 | `make audit`: gitleaks (full history), Semgrep CE (with the project rules C1.1, C8.2, C13.2), osv-scanner; fails on High. CodeQL in CI | ci-engineer | CI run | todo |
| C15.3 | Actions pinned by full SHA; `permissions: {}` by default; no `pull_request_target`/`workflow_run` running PR code; deploy only from the `production` environment on `main` with a narrow OIDC subject (F-16) | ci-engineer, sre | CI config review | todo |
| C15.4 | Dependabot weekly and grouped for npm, Actions and Docker; no automerge | ci-engineer | config | todo |
| C15.5 | Repo: branch protection on `main` (required checks check/e2e/audit), secret scanning and push protection on, private vulnerability reporting and SECURITY.md (F-27) | ci-engineer (checklist), **owner** (settings) | owner confirms | todo |
| C15.6 | Operator accounts (GitHub, Google/GCP, Neon, Resend, Sentry, Better Stack, Cloudflare, registrar, owner mailbox, password manager, phone) **and the passkey-sync account (Apple ID / iCloud Keychain)** use phishing-resistant MFA; no SMS-only recovery; recovery codes offline (F-03) | sre (checklist), **owner** | bootstrap step 1 table completed with dates | todo |
| C15.7 | Only synthetic data in seeds, fixtures, screenshots and CI artifacts | data-engineer, test-engineer | review | todo |

## V16 Security logging and error handling
| ID | Requirement | Owner | Verified by | Status |
|---|---|---|---|---|
| C16.1 | pino redaction config plus a unit test covering every item in ARCHITECTURE's "Never logged" list | backend-engineer | unit test (security-reviewer approves the list) | todo |
| C16.2 | Error serializer allowlist: no DB `detail`/`where`/`message`, no query parameters, no zod "received" values (F-07) | backend-engineer | unit test with a constraint-violation fixture | todo |
| C16.3 | Sentry: `sendDefaultPii: false`; no replay; DOM and console breadcrumbs off; URLs stripped of `#` and `?`; no request headers, cookies or bodies; project settings "Prevent storing IP addresses" and scrubbers on; inbound filters and a key rate limit (F-06, F-07) | frontend-engineer, backend-engineer, sre | event capture test + settings screenshot | todo |
| C16.4 | `security_events` written for every type in auth.md §15 rev 2, with `budget_id` on budget events. `app` has INSERT and SELECT only; rows purged through `purge_security_events()` (`SECURITY DEFINER`). The `security-events` admin command is read-only, prints no emails, and its output stays in the 30-day `_Default` bucket with no sinks (deviation 6) | backend-engineer, data-engineer, sre | integration test + log config review | todo |
| C16.5 | Admin CLI output and logs contain no emails or tokens (F-02) | backend-engineer | unit test of CLI output | todo |
| C16.6 | Alerts per ADR-0007: site down, error spike, missed backup, failed purge (including the F-25 skip), billing, email budget | sre | alert test | todo |

## Pre-launch gate (security-reviewer)
| ID | Requirement | Owner | Status |
|---|---|---|---|
| G1 | Every Critical and High finding is `verified`; Mediums are `verified` or `owner-accepted`. F-33 and F-34 are fixed in the contract before owner approval | security-reviewer | todo |
| G2 | Attacker-style pass on J1–J7, enumeration, rate limits, recovery and invitations, against a build that matches production | security-reviewer | todo |
| G3 | THREAT_MODEL "Open risks" all signed off with dates | owner | todo |
| G4 | Restore drill done, with the post-restore steps (C14.5) | sre | todo |
| G5 | External header, TLS and CSP scan of the production URL; `/api/_test/*` gives 404 | sre | todo |

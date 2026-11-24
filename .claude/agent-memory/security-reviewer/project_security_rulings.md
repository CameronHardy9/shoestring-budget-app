---
name: project-security-rulings
description: Security-reviewer rulings on Shoestring's MVP design and code reviews (2026-11-12 to 2026-11-17) and the reasons for each, so later reviews do not reopen or contradict them
metadata:
  type: project
---
Rulings I made in the 2026-11-12 contract review. The full text is in docs/security/THREAT_MODEL.md "Open risks" and FINDINGS.md.

- **Optional MFA** was accepted by the owner on 2026-11-12, against my recommendation (R-1). I still recommend requiring MFA for budget owners who share a budget (OD-1). Treat password compromise as the most likely attack and push detective controls (new-sign-in emails, notice on invitation acceptance).
  **Why:** owner chose beta friction over the risk. **How to apply:** don't re-argue the decision itself; judge each auth change by whether it stays safe when the attacker already has the password.
- **Backups in public-repo Actions artifacts: NOT accepted**, even encrypted (ADR-0007 constraint 7 needed my explicit acceptance; I declined).
  **Why:** any signed-in GitHub user can download them, public run logs leak, and there is a single key forever. **How to apply:** accept only private storage with a write-only credential and a read-only `backup` DB role.
- **RLS rejection (ADR-0006) accepted, on conditions.** Tooling must enforce the BudgetScope brand (Semgrep bans `as BudgetScope` and db/sql imports outside db/), foreign IDs in request bodies get a 400 before any FK fires, and idempotent replay and export go through the scope.
  **Why:** TS brands are compile-time only. **How to apply:** in every backend/db diff, check those rules exist and pass.
- **TOTP field encryption with MFA_ENCRYPTION_KEY: endorsed.** It does not conflict with the owner's "no field-level encryption"; it targets DB-only or backup-only leaks. Recovery codes must get the same protection (an HMAC with an HKDF subkey, not plain SHA-256).
- **security_events.ip kept 90 days:** recommended accepting it (R-6); app logs keep no IPs or UAs.
- **CSP:** `script-src` never relaxes. **Superseded 2026-11-14:** the owner ruled for `style-src 'self'` plus exactly two sha256 hashes (React Aria `usePress` and `usePreventScroll`), and I signed off in the frontend review. Any new hash, nonce, `'unsafe-hashes'` or `'unsafe-inline'` needs a fresh sign-off. Before signing, recompute hashes from the *shipped bundle* and grep the bundle for every `createElement('style')`. React 19's `<style precedence>` hoisting is the only other one; it is fine while unused.
  **CSSOM styles approved 2026-11-24:** React's `style` prop is fine (react-dom 19 `setValueForStyle` assigns `style[name]` / `setProperty`, which CSP does not govern; the SPA has no SSR, so no `style=""` in markup; check-dist bans `style=` in index.html). Values must be built from numbers/constants, never user text. Re-check if anything uses `setAttribute('style')`, `cssText` from user data, or SSR is added.
- **Frontend review 2026-11-14 (`feat/frontend`): OK to merge**, no Critical or High findings. New Lows F-50 to F-54. Ruled: the service worker can't serve stale code or drop the CSP while online, because navigations are network-first and the cached shell keeps its headers. PR #6 refund clamp does not weaken F-45.

- **Re-review 2026-11-13 deviation rulings (all accepted):**
  1. F-22 inline send with a 700 ms timeout and a fixed 1 s response (Cloud Run throttles CPU after the response).
  2. The cancel link reverts confirmed changes within 24 h. Residual R-11; F-33 must be fixed first.
  3. Admin arguments stay in private GCP records (R-12; Admin Activity logs may keep them ~400 days).
  4. Reset mail is non-priority.
  5. Ownership transfer has no acceptance step.
  6. `security-events` IPs in 30-day logs (under R-6).

  OD-1 kept MFA optional for owners too; OD-7 accepted R-4, R-5, R-6, R-8 and R-10; OD-8 left legal unassessed.
  **Why:** these are settled, so don't relitigate them. **How to apply:** in code review, check the conditions attached to each ruling instead.

- **Clearance 2026-11-13 (third pass):**
  - Contracts **cleared for owner approval**; F-33 and F-34 fixed; R-11 and R-12 owner-accepted 2026-11-13.
  - Accepted the single `APP_KEYRING` (HKDF subkeys, per-row key_id, rewrap job), `LIMIT_REACHED` on restore, and `deleted_budget_owner` + `DeletedBudgetScope`.
  - Backups moved to a Cloud Run job, so no DB credential or app key enters GitHub.
  - Open Low: F-37 (BudgetList maxItems 10 vs restore overflow).
  - `make audit` became real (gitleaks, semgrep, osv-scanner, zizmor); the project-specific Semgrep rules (BudgetScope cast, `_test` sentinel) still need code to exist.

- **Data-layer code review 2026-11-13 (`feat/db-data-layer`): OK to merge**, no Critical or High findings.
  - Accepted three data-engineer deviations. The split→category FK is `NO ACTION DEFERRABLE INITIALLY DEFERRED`, with `deleteCategory` setting it IMMEDIATE (condition: the F-07 serializer covers a commit-time 23503). Expired invites are deleted on re-invite. A transfer to a pending-deletion member gives NOT_FOUND.
  - Accepted the Semgrep file-exact exclusions (`db/src/scope.ts`, `db/src/isolation.test.ts`) for the scope-cast rules, on these conditions: no globs, the per-function narrowing rule stays, and F-41 gets fixed. An inline `nosemgrep` on the forging line is preferred.
  - Accepted the ESLint relaxations for tests and test-support (type-hygiene rules only), but never for `src/testing/**`, which is shipped code.
  - `purge_security_events()` with `search_path = pg_catalog, public, pg_temp` and the DB clock is fine as is; don't reopen it.
  - The osv advisory for minimatch 10.2.6 (dev-only, via eslint) is not exploitable; just bump it.

- **Backend code review 2026-11-14 (`feat/backend-api`): OK to merge**, no Critical or High findings. New F-45 (Medium, fix before launch) and F-46 to F-48 (Low).
  - Accepted: the email daily budget keyed by a constant SHA-256 instead of an HMAC. It holds no PII, has its own scope, and survives rotation.
  - Ruled not exploitable: the `acceptInvitation` owner-status read, serialized by the budget row lock.
  - Ruled false positives: Semgrep `prototype-pollution-loop` on `valueAt` (suppress inline), and osv glob/minimatch. glob is a *prod* dependency via @fastify/static, but its patterns are fixed and no signal is passed.
  - The strict fake DAL is fine for backend unit tests. F-18 and F-36 stay `contract-fixed` until test-engineer's generated permission-matrix tests exist (a launch gate, not a merge gate).
  - Rotating keyring `current` resets every HMAC'd throttle counter. This is a note for sre, not a finding.

  - **Final pass 2026-11-14:** the owner ruled F-45 fixed in this PR and bidi controls banned at input (API plus DB `is_clean_text`). F-45 to F-48 are verified, and F-10 is verified at image level (post-deploy probe pending sre).
    - Accepted trade-off: in a parallel burst, the failure that reaches 5 deletes the session or token while a correct attempt is in flight. It fails closed and burns that factor.
    - **F-49 (Low): restore vs the owner's deletion race, deferred by the owner 2026-11-14.** Fix: re-check status after `lockUser` in `restoreDeletedBudget`. Fix it before launch.
    - The earlier image shipping `src/` was ruled no exposure: the `db/testing` import is missing, `NODE_ENV=production` refuses `TEST_HOOKS`, and nothing was ever deployed.
- **Test-suite review 2026-11-16 (`feat/test-suite`): nothing blocks.** New Lows F-55 and F-56.
  - Verified by tests: F-01, F-18, F-23 (except the SPA document, F-53, and Sentry), F-33, F-34, F-36; also C2.4, C3.1, C3.6, C8.4, C8.7, C8.8, C8.9.
  - Partial: F-06, F-09, F-21, F-22; C3.2–C3.5, C15.7. Downgraded: F-32 (bfcache unproven). Not tested in tests/: F-08.
  - Ruled OK:
    - the prod-server Origin rewrite (only its own origin; loopback);
    - the axe `[data-live-announcer]` exclusion;
    - the visual `snap()` discard (visual suite only; filtering recommended);
    - public CI failure traces (throwaway stack).
  - **BUG-1 (GET bodies ignored) is not a security issue.** I recommended the architect exempt GET/HEAD in the contract.
  **How to apply:** don't reopen these. Flip F-09/F-21/F-22/F-32 only when the missing cases listed in FINDINGS land.

- **Hardening review 2026-11-16 (`fix/pre-launch-hardening`): approve with follow-ups.** Closed F-51 to F-54. F-08 (V26 still open), F-09 (app side; the alert is sre's), F-21 and F-22 verified by integration tests. F-32, F-55 and F-56 verified from #13. New F-57 (Medium, the read-then-increment class, fixed in the PR) and F-58 (Low, open).
  - Ruled that the login failure counters' check-then-increment overshoot is **acceptable for launch**: about 2x at worst, bounded by the per-IP `hitOrThrow` and the argon2 semaphore. **But the `login_throttled` notice (`=== 100` on a rolling sum) must become one-shot before launch.**
  - Ruled the F-22 slow-mailer test hook **not needed**: it would widen the hook surface.
  - The e2e `edge` proxy and its `X-E2E-Client-IP` header are test-only and cannot reach the image (`.github` is dockerignored, and the backend has no code for the header). Re-check this if a Dockerfile COPY or the deploy config changes.
  - `reserveRolling` (upsert, then sum) fails closed under concurrency. Accepted.
  - Follow-up (same day): the F-58 notice was fixed in #14 (one-shot per UTC day; no repeat for a same-day re-lockout or after a reset, accepted), and the counter conversion is owner-deferred. CodeQL #6 (remote-property-injection in e2e-edge.mjs) was ruled Info, not an F-number: test-only, and assigning a string to `__proto__` is a no-op. It was fixed anyway with raw header arrays and token/value validation.
  - I did not run `make audit` because the tech lead was running it at the same time (both write `.audit/`). Check `.audit/` timestamps against the edit times.

- **F-49 fixed and verified 2026-11-16 (`fix/f49-restore-race`).** The owner's status is now re-checked after `lockUser`, and all member locks are taken before the limit checks. `lockOwnedBudgetsAndCheckShared` locks *deleted* owned budgets too, which is what makes restore-first safe. Ruled Info, not a finding: `lockBudget` reads `m.role` in its locking statement, so the role can be stale after a wait. The deferred one-owner trigger blocks the only integrity break, and otherwise the actor gains only an action they could have taken an instant earlier.

- **Sentry review 2026-11-17 (`feat/sentry`): approve.** F-50 closed. Verified: the Sentry halves of F-06 and F-07, the Sentry parts of F-23, and the F-09 alert code. New Lows F-59 to F-61.
  - **`SAFE_MESSAGES` signed off** (7 patterns plus the contract-code passthrough). The dynamic-import pattern **keeps the chunk name**, on three conditions: OWN_ASSET stays bounded, the own-origin check stays, and file names stay `[name]-[hex hash]`. Any list change needs a fresh sign-off.
  - Owner rulings I work under (round 8, 2026-11-16): spike protection only, no per-key DSN limit, and quota exhaustion = blind until the 1st is accepted. Don't re-raise the public-DSN flood. Load-shedding 503s going to Sentry is Info under that ruling.
  - Ruled Info: glob@13.0.7 (via @sentry/bundler-plugins, never bundled or run), the `sentry` npm CLI package, and the two Semgrep WARNINGs in dist-checks.test.ts (test fixtures).
  - The SW first-visit no-reload fix holds; the `hadController` staleness is only a UX issue.

- **Sentry follow-ups 2026-11-17 (`fix/sentry-followups`): approve.** F-59, F-60 and F-61 verified. New F-62 (Low, F-59 residuals: SDK `(error: …)` rewrite and stale V8 header; not blocking).
  - CodeQL triage on main (not F-numbers): #1 HIBP SHA-1, #2 HMAC of recovery codes and throttle keys, and #4 the SW `message` origin check are **false positives**. #3, the tripwire stat/read race, is **won't fix**; `withFileTypes` is the optional cleanup. The owner dismisses them; I never do.
  - sw-register `updateRequested` and the `randomPassword()` test helper add no risk.
  - The owner keeps the Sentry org slug and project IDs in the public repo (they are already public through the DSN). The auto-created GitHub `sentry` environment had no exposure (the secret was created after the only deploy, which was from main).
  - Info (T133): the Sentry CLI OAuth login on the owner's Mac has `project:write` and `alerts:write`. Recommend logging out after step 13.

- **osv ignore policy (PR #20, 2026-11-17).** I signed off on `.github/osv-scanner.toml` ignoring picomatch GHSA-fc5q-39xc-vjpf until 2026-12-17: dev tooling only, not in the prod tree, not bundled.
  - osv-scanner v2.7.1 uses `effectiveUntil` (`ignoreUntil` is deprecated) and rejects unknown keys, so a misspelled expiry fails the scan instead of becoming permanent.
  - Ignores are keyed by advisory ID, not package scope. Before any extension, re-run `pnpm why <pkg> --prod` in backend/ and frontend/. Any extension needs a fresh sign-off.

- **Offline and F-62 review 2026-11-17 (`fix/offline-and-f62`): approve.** F-62 verified and closed with an **accepted residual (my call, no owner decision)**: a stale V8 header that is a whole-line prefix of the current one (message cut at a line break after the first `.stack` read). Reasons: no trigger, F-59 bounds, and an `Error.prepareStackTrace` hook is worse. Re-open if code mutates `.message`/`.name` on existing errors, sets `prepareStackTrace`, or messages start carrying multi-line user text. The `[CODE]` header form adds nothing. New F-63 (Low, web, open). Offline "online to save": no new risk.

- **Pre-deploy pass 2026-11-17 (`chore/pre-deploy`): approve.** F-43 closed, F-47 still closed (checked on the built images). New Lows F-64 (restore roles.sql SHA provenance) and F-65 (V26 must measure both public paths), both for sre.
  - **Owner ruling: the GHCR packages (app, migrate, backup) are public.** I ruled it adds no exposure: no secret build args, and the backend maps are public code and never served. Re-check when the publish workflow lands (main only, scoped `packages: write`, no secret build args because of `provenance: mode=max`, attestations preferred).
  - The separate migrate image is accepted as a least-privilege improvement. Admin job default args `purge,--dry-run` are read-only (the transaction rolls back), so that is fine.
- **Image publish review 2026-11-17 (`feat/image-publish`): approve.** All my pre-set criteria were met, and zizmor is clean. New Lows: F-66 (WIF subject format and condition, sre), F-67 (copy by digest and make `gh attestation verify` mandatory, sre) and F-68 (OS image scan; **follow-up, not a launch blocker**).
  - Ruled: the artifact handoff is sound, because the image IDs come from job outputs and `docker load` checks diff_ids; artifact poisoning is DoS only. The Rekor disclosure is Info. Unpinned apk versions are accepted (signed repos, deploy by digest).
  - Same day: F-66 and F-67 verified after sre's fixes, and the F-68 sre half is done. Ruled that `--source-digest "$SHA"` is recommended now (one flag) but doesn't reopen F-67.
  - **The repo uses immutable OIDC subjects** (`sub_claim_prefix` `repo:<owner>@<id>/<repo>@<id>`), so any `repo:<owner>/<repo>:…` binding fails closed.

Related: [[project-review-hotspots]]

- 2026-11-23: V26/F-65 signed off. Both public paths (run.app and domain mapping) measured 1 hop (`forged,<client>`); app trustProxy is `hop < TRUST_PROXY_HOPS` (=1) so rightmost XFF wins. Re-measure only if the edge changes (e.g. Cloudflare proxy on).
- 2026-11-23: F-10 production control is now (a) the Dockerfile tripwire re-run on the exact deploy digest via `crane export` (pre-traffic) plus (b) the 404 probe on the custom domain post-shift. run.app can never 404 (checkHost 400s first). Accepted.
- 2026-11-23: Neon only takes plaintext passwords (`\password` hash rejected). Plaintext ALTER ROLE via psql variable accepted as Low residual (Neon already holds the data); runbooks must not claim it stays out of Neon's logs.

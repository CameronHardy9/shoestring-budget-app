---
name: phase-a-status
description: Backend status after the 2026-11-14 fix round (F-45 to F-48): all 63 operations implemented; what is still open and the deliberate choices to re-check
metadata:
  type: project
---

As of 2026-11-14 all 63 contract operations are implemented, and the F-45 to F-48 fix round is done on feat/backend-api (not committed; the tech lead commits).

- **F-45:** MFA limits are reserve-first everywhere: the per-user budget via atomic `hitThrottle` (refunded into the charged window), the per-session and per-token slots via the DAL's `reserve*/fail*/release*MfaAttempt`, and the reauth and TOTP-confirm rows via `throttleGuard`. Unit tests cover parallel attempts; a real-DB parallel test belongs to test-engineer.
- **Contract rev 4 ratified** the backend's notification kinds, `LINK_PATHS`, `email:daily` with a constant SHA-256 key, the reset-counter clearing, and TRUST_PROXY_HOPS ≥ 1 in production.
- **CSP style hashes (owner decision 2026-11-14):** `style-src` allows React Aria's two `<style>` hashes, with no `'unsafe-inline'` and no nonce. The architect may switch this to `style-src-elem` plus a strict `style-src-attr`; only `STYLE_DIRECTIVES` would change. A backend test reads frontend/src/security/csp.ts as text to catch drift.
- **2026-11-16 (hardening PR):** reserve-first (+ refund on refusal via `Throttles.refundOnError`/`releaseAll`) now covers reset-request per-email, `mailer.send` email:daily (pre-read kept so dropped mail costs no write; provider failure keeps the slot), invites, email-change. Read-only pre-checks at step 7 remain only as cheap filters. `fakeThrottles` matches the db refund clamp; `slowThrottles()` in the harness makes races reproducible. Known fail-safe effect: in-flight reservations can briefly over-refuse near a cap.
- **Owner ruling 2026-11-16:** login failure counters (pair/email-day) stay check-then-hit (overshoot bounded by the atomic per-IP limit and the argon2 semaphore). F-58: the `login_throttled` notice is one-shot per UTC day via `reserve(key("login:throttled_notice", userId), DAY).count === 1`, like `mfa:locked_notice`.
- **Sentry (feat/sentry, 2026-11-16):** `src/observability/error-tracker.ts`. Only server.ts and the admin CLI (purge + mail commands) start it; createDeps defaults to NO_TRACKING, so tests and dev/e2e never send. Events are built from serializeError and `beforeSend` rebuilds every event from an allowlist. A6 one-shot keys are `email:quota_warning|error`; no slot is spent while tracking is off.
- **Sentry follow-ups (fix/sentry-followups, 2026-11-17):** F-60 owner ruling: the A6 warning line is `bulkCutoff(quota)` (floor 60%), the same count where bulk mail stops, not a share (ceil of a share missed odd quotas). F-59: serializeError skips the V8 header (name + message line count) before matching frames, and `FUNCTION_NAME` (logging.ts) allows identifiers only; beforeSend re-parses SDK-built frames from `hint.originalException`. F-61: scripts/bundled-runtime-packages.json pins the npm packages in dist/ source maps (Sentry SDK + pg family via @shoestring/db); a new bundled package fails build.test.ts.
- **F-62 (fix/offline-and-f62, 2026-11-17):** frameLines keeps frames only when `stack` starts with exactly the current header (`name: message`, one-part forms, or Node's `name [code]: message`); else none. Known residual: a message cut at a line boundary after the first `.stack` read still matches (undetectable from the string).
- **Still open:** the common-password list is a placeholder; `@shoestring/db` moves to devDependencies in the pre-deploy pass; glob/minimatch moderate CVEs wait for releases past the 7-day age.

**Why:** the next round starts here. **How to apply:** re-check each item against the code and contracts before relying on it.

Related: [[backend-gotchas]]

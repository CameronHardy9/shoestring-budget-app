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
- **Deliberately not converted:** login failure counters (pair/email-day) are still check-then-hit; overshoot is bounded by the atomic per-IP limit and the argon2 semaphore. Would need reserve + refund-on-success like MFA.
- **Still open:** the common-password list is a placeholder; Sentry is not wired; `@shoestring/db` moves to devDependencies in the pre-deploy pass; glob/minimatch moderate CVEs wait for releases past the 7-day age.

**Why:** the next round starts here. **How to apply:** re-check each item against the code and contracts before relying on it.

Related: [[backend-gotchas]]

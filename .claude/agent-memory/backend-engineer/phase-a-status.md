---
name: phase-a-status
description: Backend status after the 2026-11-14 fix round (F-45 to F-48): all 63 operations implemented; what is still open and the deliberate choices to re-check
metadata:
  type: project
---

As of 2026-11-14 all 63 contract operations are implemented, and the F-45 to F-48 fix round is done on feat/backend-api (not committed; the tech lead commits).

- **F-45:** MFA limits are reserve-first everywhere: the per-user budget via atomic `hitThrottle` (refunded into the charged window), the per-session and per-token slots via the DAL's `reserve*/fail*/release*MfaAttempt`, and the reauth and TOTP-confirm rows via `throttleGuard`. Unit tests cover parallel attempts; a real-DB parallel test belongs to test-engineer.
- **Contract rev 4 ratified** the backend's notification kinds, `LINK_PATHS`, `email:daily` with a constant SHA-256 key, the reset-counter clearing, and TRUST_PROXY_HOPS ≥ 1 in production.
- **Still open:** the common-password list is a placeholder; Sentry is not wired; `@shoestring/db` moves to devDependencies in the pre-deploy pass; glob/minimatch moderate CVEs wait for releases past the 7-day age.

**Why:** the next round starts here. **How to apply:** re-check each item against the code and contracts before relying on it.

Related: [[backend-gotchas]]

---
name: phase-a-status
description: Backend status after Phases A and B (2026-11-13): all 63 operations implemented; open gaps reported to the tech lead and deliberate deviations to re-check
metadata:
  type: project
---

Phases A and B are done on feat/backend-api (2026-11-13): all 63 contract operations are registered, the admin CLI is real, and 100% coverage is enforced on src/domain plus the TOTP and recovery-code modules.

Open items reported to the tech lead (verify their status before relying on them):
- DAL `getMfaDetail` lacks the TOTP `confirmedAt`; `/me/mfa` returns `null` for it (services/account.ts `getMfa`).
- The email-budget counter key is SHA-256 of a constant, not an HMAC (deviates from data-model.md), so the admin job sends mail without `APP_KEYRING`.
- A password reset clears `login:email_day` and the (email, *current IP*) pair only; HMAC'd pair keys for other IPs can't be enumerated.
- The notification `kind` vocabulary and the non-token link paths are backend-chosen; with the architect for confirmation.
- The bundled common-password list is a placeholder; Sentry is not wired.

**Why:** the next backend round starts from these. **How to apply:** check each against db/ and the contracts first; drop items once resolved.

Related: [[backend-gotchas]]

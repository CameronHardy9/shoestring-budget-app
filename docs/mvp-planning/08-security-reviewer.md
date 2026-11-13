# Meeting 8: security-reviewer
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP security baseline (non-negotiable)
- Per-user data isolation in the data-access layer, with automated tests that try to read another user's data. This is the most likely serious bug.
- A proven auth library or provider, never custom crypto. If passwords are stored: argon2id plus breached-password checks.
- Secure HttpOnly, SameSite cookies; server-side sessions that can be revoked; CSRF protection; "log out everywhere".
- HTTPS with HSTS, a strict CSP and security headers. API responses use `Cache-Control: no-store`. No financial data in localStorage or the service-worker cache.
- Rate limits on login, signup, password reset and MFA; responses that don't reveal whether an account exists.
- Schema validation at every boundary; parameterized queries only.
- Secrets only in env or a secret manager. CI runs secret scanning, dependency audit and SAST, with SHA-pinned actions and a least-privilege token.
- No amounts, payees or PII in logs, plus a separate audit log for security events.
- Encryption at rest, encrypted backups, a tested restore.
- Never collect card numbers, SSNs or bank credentials.

### Decisions for the owner
1. **Who uses the MVP:** (a) just you, (b) an invite-only beta, (c) public. *Recommended: (a) or (b).*
2. **How bank data gets in:** (a) manual or CSV *(recommended)*, (b) a Plaid-style aggregator (later, under its own ADR), (c) storing users' bank logins (never)
3. **Sign-in:** (a) a managed identity provider, (b) library-based email and password, (c) passkeys first, (d) magic links. *Recommended: (a) or (b) with passkey support.*
4. **MFA:** required for everyone except the owner; passkeys count as MFA; account recovery must not bypass it *(recommended)*
5. **Mobile session lifetime:** (a) 15-minute idle timeout, (b) a 30-day rolling session with re-authentication for sensitive actions and a list of devices you can revoke *(recommended)*, (c) indefinite
6. **Encryption at rest:** (a) the provider's disk encryption *(recommended now)*, (b) plus field-level encryption with a key management service (if bank sync arrives), (c) end-to-end encryption
7. **Retention:** (a) hard delete immediately, (b) a 30-day grace period then purge, with backups expiring within 35 days, plus self-service export *(recommended)*, (c) keep indefinitely
8. **Where users live:** (a) US only, (b) including the EU or UK, (c) unknown. *Recommended: build to a GDPR-level baseline now.*

### Draft task list
1. THREAT_MODEL v1 (assets, data classification, boundaries, STRIDE on the journeys)
2. Review auth.md and data-model.md (PII)
3. An MVP security checklist based on ASVS Level 2, with an owner for each item
4. A `make audit` and CI-hardening spec for ci-engineer
5. Review every change set; keep FINDINGS.md current
6. Review CSP, headers, cookies, caching, and service-worker and PWA storage
7. Review logging and backups with sre; input for a breach runbook
8. An attacker-style pass on the journeys before launch

### Dependencies
architect (stack, PWA, auth.md, ADRs) · backend (auth library) · data (scoping, PII) · ci (`make audit`, git repo) · sre (hosting, key management, backups, logs) · tests (tests that try to read another user's data) · frontend (CSP, storage)

### Risks and open questions
- Account recovery is the usual way around MFA, so its design needs your sign-off
- Bank-sync scope creep needs a gate
- Whether the FTC Safeguards Rule (GLBA) or state privacy laws apply needs legal advice
- With only one human reviewer, automation has to carry more of the load
- There's no git repo yet, so diff reviews and history scans aren't possible

## Owner decisions (2026-11-12)
| Decision | Choice |
|---|---|
| Who uses the MVP | Invite-only beta, under 10 users, US only (meeting 1) |
| Bank data | Manual entry only; no bank credentials or tokens (meeting 1) |
| Sign-in | Email + password (argon2id) with passkey or TOTP available (meeting 1) |
| **MFA** | **Optional for all users** (owner chose this over the recommendation to require it for everyone). **Accepted risk**: record it in THREAT_MODEL.md "Open risks" with the owner's sign-off. Mitigations: owner admin actions (create invites, reset MFA) run as server-side commands, not as web-UI privileges; re-authentication for sensitive actions; rate limits; breached-password checks. Recovery codes plus an owner-assisted reset for users who do enable MFA. |
| Sessions | 30-day sliding sessions, re-authentication for sensitive actions, a revocable device list |
| Encryption at rest | The provider's disk encryption plus encrypted backups (no field-level encryption needed without bank tokens) |
| Retention | 30-day grace period then purge, backups expire within 35 days, self-service CSV export |
| Region and privacy | US only; a short privacy notice for beta users |
| New exposures from other meetings | **Public repo** (secrets and history scanning, push protection, synthetic data only) · **shared budgets** (cross-budget isolation, invite abuse) · free-tier third parties (Sentry, email provider, host) |

## Agreed tasks (approved as listed)
1. THREAT_MODEL v1, including cross-budget leaks, invite abuse (guessing, reuse, expiry), MFA recovery and the owner's reset command, the public repo, and optional MFA as an accepted risk
2. Review the architect's auth.md and data-model.md (PII) **before the owner approves the contracts**
3. MVP security checklist based on ASVS Level 2, with an owner for each item
4. `make audit` and CI-hardening spec for ci-engineer
5. Review every feature diff; keep FINDINGS.md current
6. Review CSP, headers, cookies, caching, and what the PWA stores on the device
7. Review log redaction (no amounts, payees or memos), backups and the breach runbook with sre
8. Pre-launch attack pass: auth, authorization, enumeration, rate limits, recovery
9. Draft a privacy notice for beta users

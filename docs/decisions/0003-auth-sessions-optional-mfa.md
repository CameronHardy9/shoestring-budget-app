# ADR-0003: Auth, sessions and optional MFA
- Status: Accepted (owner, 2026-11-12); revised 2026-11-13 with the owner's contract-review rulings (OD-1, OD-2, R-11) and security findings F-01, F-04, F-05, F-12, F-13, F-15, F-19 to F-21, F-24, F-33, F-34. MFA being optional, **including for owners of shared budgets**, is accepted risk R-1, signed off by the owner on 2026-11-12 (OD-1).
- Date: 2026-11-12
- Areas affected: backend, frontend, data, tests, security, sre

## Context
Invite-only beta (< 10 US users), $0 cost, same-origin SPA. Phones need long sessions; financial data needs revocable sessions and step-up for sensitive actions. Security recommended mandatory MFA; the owner chose to make it optional for everyone.

## Decision
- **Sign-up:** invite-only. Only the owner creates sign-up invites, with a server-side admin command (no web-UI privilege). The emailed token both authorizes sign-up and verifies the email.
- **Credentials:** email + password, argon2id (≥ 19 MiB, t=2, p=1), 12–128 characters, breached-password check (HIBP range API with a bundled fallback list).
- **Sessions:** server-side rows keyed by `SHA-256(token)`; cookie `__Host-ss_sid`, HttpOnly, Secure, SameSite=Strict, Path=/; 30-day sliding expiry **capped at 90 days absolute** (OD-2); rotation on sign-in and MFA completion; at most 20 active and 5 MFA-pending per user; device list (fixed browser/OS vocabulary) with per-session and "everywhere else" revocation. Every revocation-class event also deletes open one-time tokens (F-01).
- **CSRF:** SameSite=Strict + exact `Origin` check on every unsafe request + per-session `X-CSRF-Token` held in memory by the SPA + JSON-only bodies.
- **MFA (optional):** TOTP and passkeys (WebAuthn as a second factor). Ten single-use recovery codes stored as HMACs with an app-held key (F-04). One per-user budget of 20 failed second-factor checks per 24 h across sign-in, re-auth and reset (F-05). When enabled, MFA is required at sign-in, at re-auth and at password reset; **email reset never bypasses MFA**. Owner-assisted `reset-mfa` admin command (Cloud Run job) as the last resort.
- **Detective controls for optional MFA (F-12, F-34):** emails for **every** new sign-in (no skip rule), repeated MFA failures, every security change, invitation acceptance, budget deletion/restore, member removal and ownership transfer.
- **Email change (F-01, F-33):** confirm needs the token plus a session of the same user. The old address gets a 24-hour "this wasn't me" link that cancels or reverts the change and revokes every session. An earlier cancel link always wins over later ones, at most one change can be started per 24 h, and cancel/revert emails both addresses. The residual risk that the old mailbox can undo a real change for 24 h is accepted as R-11 (owner, 2026-11-13).
- **Re-authentication:** 10-minute window for change password/email, MFA changes, export, account deletion, budget deletion, **budget invitations** (F-13) and **ownership transfer**.
- **Password hashing** runs behind a per-instance semaphore (4 concurrent, 2 s queue, then 503) to bound memory and cost (F-15).
- **Rate limits** persisted in Postgres for auth endpoints; enumeration-resistant responses and timing.
- Full rules in docs/contracts/auth.md.

## Alternatives considered
- **Mandatory MFA for everyone (security's recommendation):** rejected by the owner for beta friction. Accepted risk: a phished or reused password gives full access to that user's budgets. Mitigations: invite-only, breached-password checks, rate limits, re-auth for sensitive actions, notification emails on security changes, revocable sessions, admin powers not reachable from the web.
- **JWT bearer tokens:** not revocable without a server store, and token storage in JS is exposed to XSS.
- **Managed identity provider (Auth0, Clerk, Supabase):** free tiers exist but add a third party holding PII, a cross-origin flow, and lock-in; the beta is small enough for a well-reviewed library-based design.
- **Magic links only / passkeys only:** email deliverability on a free provider is a single point of failure; passkey-only is not yet universal for the target users.
- **SameSite=Lax:** Strict works for an SPA whose HTML needs no cookie and blocks more cross-site requests.
- **Signed double-submit CSRF cookie:** equivalent strength; the session-bound token is simpler with server-side sessions.

## Consequences
- Backend implements sessions, CSRF, MFA, recovery and re-auth; data adds the auth tables; frontend adds MFA setup, recovery-code display, re-auth dialog, and device list.
- WebAuthn binds passkeys to the RP ID `shoestring.<domain>`: changing the host later invalidates every passkey (constraint recorded in ADR-0007).
- TOTP secrets are encrypted (and recovery codes HMAC'd) with subkeys of the versioned `APP_KEYRING`, so a database or backup leak alone does not defeat MFA. The keyring is a production secret, with an offline escrow copy in a separate vault and rotation through `rewrap-mfa` (sre runbook).
- security-reviewer records the accepted risk in THREAT_MODEL.md "Open risks" and reviews the owner's MFA-reset runbook.
- The 90-day absolute cap means every user signs in again at least quarterly; installed iOS PWAs therefore re-prompt periodically.
- Revisit: require MFA for budget owners, or for everyone, before any wider beta (OD-1 was decided against the security recommendation).

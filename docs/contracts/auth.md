# Auth
Owner: architect. Consumers: backend (implements), frontend, tests, security-reviewer, sre (admin runbooks).
Decision records: ADR-0003 (auth), ADR-0006 and ADR-0010 (budget authorization and lifecycle). Entities: data-model.md. Error codes: errors.md. Endpoints: api.openapi.yaml.
Revision 2 (2026-11-13) applies the owner's rulings in mvp-planning/10 and security findings F-01 to F-31. Revision 3 (2026-11-13) applies F-33 to F-36 and the owner's round-2 rulings.

## 1. Model in one paragraph
Email + password (argon2id) with invite-only sign-up. Server-side sessions are identified by an opaque random token in an httpOnly cookie, with a 30-day sliding expiry and a **90-day absolute cap**, and users can list and revoke them. CSRF is blocked by SameSite=Strict, a strict Origin check, a Host check, and a per-session CSRF token header. MFA (TOTP or passkey) is **optional** for every user, including owners of shared budgets (accepted risk R-1, OD-1). When MFA is enabled it is required at sign-in, at re-authentication, and at password reset. Sensitive actions require re-authentication within the last 10 minutes. Because MFA is optional, the design leans on detective controls: notification emails for new sign-ins and for every security or sharing change. Owner admin actions are CLI commands run as Cloud Run jobs, never web endpoints. Authorization is deny by default and based on budget membership; non-members get 404.

## 2. Sessions
- **Token:** 32 bytes from a CSPRNG, base64url. Only `SHA-256(token)` is stored (`sessions.token_hash`). The token never appears in logs, URLs or response bodies.
- **Cookie (production):** `__Host-ss_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<seconds until expires_at>`. The `__Host-` prefix pins it to the exact host with no Domain attribute, so other subdomains of the owner's shared domain can neither read nor set it.
- **Cookie (local http dev only):** `COOKIE_SECURE=false` switches to `ss_sid` without `Secure` (and without the prefix). The backend refuses to start with `COOKIE_SECURE=false` in production.
- **States:** `mfa_pending` (password verified, second factor outstanding; lifetime 10 minutes, not extended) and `active`.
- **Expiry:** `absolute_expires_at = created_at + 90 days` (OD-2, F-19), never extended. `expires_at = min(last_seen_at + 30 days, absolute_expires_at)`. On an authenticated request, if `last_seen_at` is more than 1 hour old, update `last_seen_at`/`expires_at` and re-send the cookie with a fresh `Max-Age`. After 90 days the user signs in again, whatever their activity.
- **Rotation:** a new token (new session row) on sign-up, on login, and on MFA completion (`mfa_pending` → `active` replaces the row and the cookie, and the 90 days count from the new row). Logging in while a session cookie is present revokes that old session.
- **Caps (F-20):** at most 20 `active` sessions per user (sign-in evicts the least recently seen active one) and, separately, at most 5 `mfa_pending` sessions (the oldest pending is evicted). A pending session never evicts an active one.
- **Device list:** each session stores `device_browser` and `device_os` from a **fixed vocabulary** (API `DeviceBrowser` and `DeviceOs`) parsed from the User-Agent at sign-in. Unrecognized values map to `other` or `unknown`. The raw User-Agent and IP are not stored on the session.
- **Revocation:** deleting the row. Logout revokes the current session. `DELETE /me/sessions/{id}` revokes one; `POST /me/sessions/revoke-others` revokes all but the current one. Password change and email-change confirm revoke all other sessions. Password reset, email-change cancel, owner `reset-mfa`, owner `revoke-sessions` and account deletion revoke all sessions.
- **One-time tokens die with revocation (F-01):** password change, password-reset completion, revoke-others, admin `revoke-sessions` (one user or `--all`), admin `reset-mfa`, any MFA factor added or removed, the account-deletion request, email-change confirm and email-change cancel each **delete every open `user_tokens` row of the user except `email_change_cancel`**, in the same transaction. Revoking the session that requested an email change deletes that change's token (FK cascade).

## 3. CSRF, origin and host
Applied by the backend in `onRequest`, before body parsing:
1. **Host (F-23):** the `Host` header must equal the host of `APP_ORIGIN`; otherwise 400 `VALIDATION_FAILED` (`header.Host`). This blocks DNS rebinding, Host-header poisoning, and direct use of the platform's `*.run.app` URL. The only exemptions are `GET /api/healthz` and `GET /api/readyz`, which platform probes and the deploy gate call with other hosts. Every link in every email is built from `APP_ORIGIN` only, never from request headers. The check applies in local development too.
2. **Origin (every unsafe method, public endpoints included):** `Origin` must equal `APP_ORIGIN` exactly. If `Origin` is absent, `Sec-Fetch-Site` must be `same-origin`. Otherwise → 403 `CSRF_FAILED`.
3. **Token:** if the request carries a valid session cookie and the endpoint's `x-session` is not `none`, `X-CSRF-Token` must equal `sessions.csrf_token` (constant-time compare); else → 403 `CSRF_FAILED`. Public (`x-session: none`) endpoints ignore any session cookie.
4. **Content type:** bodies must be `application/json` (415 otherwise), so HTML forms cannot submit.
- The SPA gets `csrfToken` from `AuthState` (`GET /auth/session`, login, signup, MFA verify) and keeps it **in memory only**. A new session means a new token.
- No CORS: the API never sends `Access-Control-Allow-*` headers. GET requests never change state.

## 4. Invite-only sign-up and emailed links
- Only the app owner creates sign-up invites, with the `create-signup-invite` admin command (admin-commands.md). It stores a hashed token with a 7-day expiry, revokes any earlier open invite for that email, and **emails** the link. The command never prints the token.
- **Links:** `<APP_ORIGIN>/signup#token=…`, `/reset-password#token=…`, `/confirm-email#token=…`, `/cancel-email-change#token=…`. The token is in the URL **fragment**, so the server never receives it in a URL, it never appears in access logs, and it is never sent as a Referer.
- **Fragment hygiene (F-06):** the SPA's first module, **before the Sentry SDK initializes and before any route renders**, reads the token into memory and calls `history.replaceState` to remove the fragment. The token is never persisted. The Sentry `beforeSend`/`beforeBreadcrumb` hooks also strip `#…` and `?…` from every URL (ARCHITECTURE "Error tracking"). Click and open tracking are disabled at the email provider, so links are delivered as plain links.
- Sign-up uses the invite's email, not user input. Holding the token therefore proves control of the address, and `email_verified_at` is set at sign-up. The invite is consumed in the same transaction that creates the user.
- If an account already exists for the email, the admin command refuses. The owner sees this; it is not exposed over HTTP.
- **Budget invitations** (a budget owner invites an existing or future user) are a separate mechanism with no token: see §12 and data-model.md `budget_invitations`.

## 5. Sign-in
1. `POST /auth/login {email, password}`. An unknown email and a wrong password give the same 401 `INVALID_CREDENTIALS`. For unknown emails, an argon2id verify against a dummy hash runs through the same hashing queue (§7), so timing matches.
2. **No MFA:** the session is `active` and the response is `AuthState{state: authenticated}`, with `reauth_at = now` (a fresh login counts as re-authentication). The user is sent a **new sign-in notice** (§15).
3. **MFA enabled:** the session is `mfa_pending` and the response is `AuthState{state: mfa_required, mfaMethods}`. Any other endpoint returns 401 `MFA_REQUIRED`. The client calls `POST /auth/mfa/verify` with a TOTP code, a passkey assertion (challenge from `POST /auth/webauthn/challenge {purpose: mfa}`), or a recovery code. Success rotates to an `active` session with `mfa_verified_at = reauth_at = now` and sends the new sign-in notice. After 5 failures the pending session is deleted. The 5th consecutive failure after a correct password emails the user (§15).
4. Every factor check counts toward the per-user **MFA failure budget** (§6).
5. Accounts pending deletion can sign in, to cancel or export (§11).

## 6. MFA (optional; accepted risk R-1)
- **Factors:** TOTP (at most one) and passkeys (up to 10). MFA is "enabled" iff at least one factor is active. Any active factor can satisfy any MFA prompt.
- **TOTP:** RFC 6238, SHA-1, 6 digits, 30-second step, accept ±1 step. Reject any step ≤ `last_used_step` (no replay). 160-bit secret. At rest it is encrypted with AES-256-GCM using the HKDF subkey `totp-v1` of the current `APP_KEYRING` key, a random 96-bit nonce per encryption and **AAD = user_id**. The row stores the key ID, so the keyring can rotate and `rewrap-mfa` can re-encrypt (F-24, data-model.md "Application keyring"). Enrollment: `POST /me/mfa/totp` returns the secret and an otpauth URI (the QR code is rendered client-side, with no third-party QR service), then `POST /me/mfa/totp/confirm {code}`.
- **Passkeys (a second factor, not passwordless):** WebAuthn via a maintained library (e.g. SimpleWebAuthn).
  - RP ID = the host of `APP_ORIGIN` (`shoestring.<domain>`); expected origin = `APP_ORIGIN`.
  - Options: `attestation: none`, `userVerification: preferred`, `residentKey: discouraged`, explicit `allowCredentials`.
  - Verify and store `sign_count`. A counter regression is logged as a `passkey_counter_regression` security event, and the assertion is rejected unless the stored count is 0.
- **Recovery codes (F-04):** 10 codes of 10 characters (`xxxxx-xxxxx`, 50 bits each), generated when the first factor is enrolled and on regeneration, and shown once.
  - Stored as `HMAC-SHA-256(recovery-code-v1 subkey of the row's key ID, normalized code)`. Normalized = lowercase with the hyphen removed. Compared in constant time. These hashes cannot be rewrapped, because the plaintext is not kept: a key stays in the keyring until no recovery code references it.
  - Single-use. Using one sends a notification email. Removing the last factor deletes them.
- **Per-user MFA failure budget (F-05):** one counter of 20 failed second-factor checks per user per rolling 24 h, shared by `/auth/mfa/verify`, `/auth/reauth` and `/auth/password-reset/complete`. TOTP setup confirm and passkey registration are exempt, because they are the user's own enrollment.
  - When the budget is exhausted, every factor check for that user answers 429 `RATE_LIMITED` until the window ends.
  - A `mfa_locked` event is recorded and the user is emailed once per window.
  - Per-session and per-token limits (5) still apply on top.
- **All MFA changes** (enroll, remove, regenerate codes) require re-authentication, delete open one-time tokens (§2), and send a notification email.
- **Owner-assisted reset:** the `reset-mfa` admin command, run as a Cloud Run job after identity verification by the owner (runbook requirements in admin-commands.md). It deletes all factors, recovery codes and open one-time tokens, revokes all sessions, records `admin_mfa_reset`, and emails the user.
- **Accepted risk (OD-1, 2026-11-12):** MFA is not required for anyone, including the owner's own account and owners of shared budgets. Mitigations:
  - Admin powers are not reachable from the web.
  - Re-auth is required for sensitive actions, including sharing (F-13).
  - Rate limits, and breached-password checks.
  - Notification emails for new sign-ins, security changes and sharing changes (F-12).
  - Revocable sessions with a 90-day cap.
  - Self-service budget restore (ADR-0010).

## 7. Passwords
- **Policy:** 12–128 characters (code points), any characters, no composition rules, not equal to the email, not in a breached corpus. Violations are 400 `VALIDATION_FAILED` on the password field with issue `too_short`, `too_long`, `invalid_value` or `breached_password`.
- **Breached check (F-24):** the Have I Been Pwned "Pwned Passwords" range API (free, k-anonymity: only the first 5 hex characters of the SHA-1 leave the server).
  - Requests send `Add-Padding: true`, verify TLS, use a 2-second timeout, and cap the response at 1 MiB.
  - If the API fails, fall back to a bundled list of the 100,000 most common passwords and log a metric (no password data).
  - `HIBP_ENABLED=false` is refused at startup in production: an outage falls back to the list, but a misconfiguration cannot silently disable the check.
- **Hashing:** argon2id, at least m = 19 MiB, t = 2, p = 1 (OWASP baseline). Parameters live in the PHC string so they can be raised later; rehash on a successful login when parameters change. Login password fields accept 1–128 characters; the policy applies only when setting a password.
- **Hashing queue (F-15):** every argon2id operation (login, including the dummy hash; signup; reauth; password change and reset) runs behind a per-instance semaphore of **4 concurrent** operations. A request that waits more than **2 s** for a slot answers 503 `UNAVAILABLE` with `Retry-After: 2`. With Cloud Run at max 2 instances and 512 MiB each (ADR-0007), memory and cost stay bounded.

## 8. Password reset (never bypasses MFA)
1. `POST /auth/password-reset/request {email}` → always 202. If the account exists and is within the limits (§14), a token is emailed: 30-minute expiry, replacing any open reset token.
2. `POST /auth/password-reset/verify {token}` → `{mfaRequired, mfaMethods}`, or 400 `TOKEN_INVALID`.
3. If MFA is enabled, the client collects a TOTP code, a recovery code, or a passkey assertion (challenge from `POST /auth/password-reset/webauthn-challenge {token}`).
4. `POST /auth/password-reset/complete {token, newPassword, mfa?}`. With MFA enabled:
   - missing `mfa` → 401 `MFA_REQUIRED`
   - a wrong one → 401 `MFA_FAILED`
   - 5 failures invalidate the token, and failures **count toward the per-user MFA failure budget** (§6).

   Success consumes the token, sets the password, **revokes all sessions**, deletes the user's other open one-time tokens (except `email_change_cancel`), clears the user's per-email login counters (§14), records events, and emails a notice. The user then signs in normally (password + MFA).
- A user who has lost every factor and every recovery code cannot reset by email alone; they ask the owner for `reset-mfa`.

## 9. Email change (F-01)
1. `POST /me/email-change {newEmail}` (re-auth) → 202 (same response whether the new address is free or taken). **At most one email change per 24 h (F-33):** while the user has any open `email_change_cancel` token, the request is refused with 429 `RATE_LIMITED` and `Retry-After` = seconds until the latest of those tokens expires. The caller is authenticated, so this reveals nothing about other accounts.
   - **If the new address is free:** create an `email_change` token (24 h) bound to the requesting session (`requested_by_session_id`) and email the new address a confirmation link. Create an `email_change_cancel` token (24 h, holding the old address) and email the old address a notice with a **"this wasn't me"** link.
   - **If the address is taken:** email the new address that an account already exists, and create no tokens.
2. `POST /auth/email-change/confirm {token}` requires **an `active` session of the same user** plus the token. A token presented by another user's session, or whose requesting session was revoked, is 400 `TOKEN_INVALID`. Confirming does the following:
   - Swaps the email, with a unique check again at commit, and sets `email_verified_at`.
   - Deletes the user's other open one-time tokens (cancel tokens survive).
   - Revokes every session except the confirming one.
   - Emails both addresses; the old one gets the cancel link again. The backend may reissue for this: confirm then creates a **fresh** `email_change_cancel` token (24 h from the confirm, holding the old address) next to the original one, which stays open. Both revert to the same address, and the earliest still wins (F-33). The 24 h block in step 1 therefore lasts until the reissued token expires.
3. `POST /auth/email-change/cancel {token}` is public: the cancel token is the authorization, valid 24 h after the request.
   - **The outcome is decided by one comparison: does the account's current email equal the address this cancel link was sent to** (the address stored on the token)?
     - **Equal → `cancelled`:** the email is unchanged. Any pending change is abandoned (its `email_change` token is deleted with the other open tokens below).
     - **Different → `reverted`:** a change away from that address was confirmed (possibly followed by later ones), so the email is set back to the address the link was sent to and `email_verified_at` is set (400 `TOKEN_INVALID` if another account now holds it).
   - Either way, all sessions are revoked.
   - Every open one-time token that is not a cancel token is deleted.
   - **Among cancel tokens, only those of the same user created *after* the one being used are deleted. Cancel tokens created *before* it stay valid until they expire: an earlier cancel token always wins (F-33).**
   - `email_change_cancelled` is recorded.
   - **Both** addresses are emailed: the address restored or kept, and the address reverted away from or abandoned. Both mails advise resetting the password and checking MFA.
- Cancel tokens are excluded from the "revocation deletes tokens" rule (§2); the only exception is `revoke-sessions --all --restore` after a database restore (admin-commands.md), where a restored cancel token could otherwise be replayed. An attacker who has taken over the session therefore cannot erase the victim's way back by resetting the password, changing the email again, or using a later cancel link.
- **Accepted residual R-11 (owner, 2026-11-13):** whoever holds the old mailbox can undo a legitimate change for 24 h. The notice to both addresses makes that visible at once.
- **Regression tests (F-33):**
  1. **API:** the user changes A → B and confirms. Requesting B → C within 24 h answers 429 `RATE_LIMITED` with `Retry-After`. `cancel_A` then reverts the email to A, revokes every session, and emails both A and B.
  2. **Chain (seeded through the DAL, because the API refuses to build it):** the user's email is B, with a confirmed A → B and an open `cancel_A`, plus a pending B → C and a newer open `cancel_B`. Using `cancel_B` cancels B → C, leaves the email as B, and **leaves `cancel_A` open**. Using `cancel_A` afterwards reverts to A, revokes every session, and deletes every cancel token created after `cancel_A`.
- Like every one-time token, change and cancel tokens are stored only as SHA-256 hashes (`user_tokens.token_hash`); the raw token exists only in the emailed link.
- Pending budget invitations addressed to the old email are not transferred.

## 10. Re-authentication
- **Window:** 10 minutes from `sessions.reauth_at`. Set by login (including MFA completion) and by `POST /auth/reauth {password, mfa?}`. `mfa` is required when the user has MFA; without it the answer is 401 `MFA_REQUIRED`.
- **Endpoints that require it** (`x-reauth: true`):
  - change password, request email change
  - every MFA enrollment or removal, recovery-code regeneration
  - CSV export, request account deletion
  - delete a budget, **invite to a budget** (F-13), **transfer budget ownership** (ADR-0010)
- Missing or stale re-auth → 403 `REAUTH_REQUIRED`. The SPA shows a re-auth dialog and retries once. Passkey re-auth uses `POST /auth/webauthn/challenge {purpose: reauth}`.

## 11. Account pending deletion
- `POST /me/deletion` requires re-auth. It is blocked by `OWNS_SHARED_BUDGET` until the user transfers ownership of, empties, or deletes every shared budget they own.
- On success, all sessions and open one-time tokens are revoked and the account has `status = pending_deletion` for 30 days.
- The user may still sign in (password + MFA). `Me.deletion` is then non-null and only endpoints marked `x-pending-deletion-allowed` work: session, logout, MFA verify, WebAuthn challenge, reauth, `GET /me`, export, cancel deletion. Everything else → 403 `ACCOUNT_PENDING_DELETION`.
- `DELETE /me/deletion` restores the account. Otherwise the daily purge deletes it after 30 days (data-model.md).

## 12. Budget authorization (deny by default)
- **Every operation declares** `x-session`, `x-budget-role` (`none` | `member` | `owner`) and `x-reauth` (`true` | `false`) explicitly. The backend builds its route table from the contract and **fails at startup** in either of these cases:
  - a route lacks any of these declarations
  - a path containing `{budgetId}` is not `member` or `owner` (F-18)

  Test-engineer generates permission tests from the same extensions.
- For `/budgets/{budgetId}/…`, membership is resolved with one query on `budget_members` joined to non-deleted `budgets`.
  - No row → 404 `NOT_FOUND`, the same as a missing budget.
  - Role insufficient → 403 `FORBIDDEN`.
  - The resulting `BudgetScope {budgetId, userId, role}` is the only way to call budget DAL functions (ADR-0006).
- **Within a scope:**
  - Sub-resources in the path are looked up with `WHERE budget_id = scope.budgetId AND id = $id`, so an ID from another budget is 404.
  - IDs in a **body** (`splits[].categoryId`) that are not in the budget are 400 `VALIDATION_FAILED` (`invalid_value`), checked before any write, so the composite FK never fires.
  - Cursors carry a MAC (`cursor-v1` subkey) over budget ID, filters and position.
  - Idempotent replays and the CSV export go through `requireMembership` (F-18).
- **Tooling enforcement (F-18, conditions for accepting no RLS, R-7):** Semgrep/lint rules in `make check` and `make audit` ban the following:
  - type assertions to `BudgetScope` outside `requireMembership`
  - Kysely `db`/`sql` imports outside `db/`
  - budget DAL functions that take a raw `budgetId`

  The two-household isolation suite runs every DAL function with a scope for budget A against a database seeded with budget B.
- **Roles:**
  - **member:** can view and edit everything in the budget (transactions, splits, categories, plan entries, copy plan, summary) and can leave.
  - **owner:** can additionally rename the budget or change its timezone, delete and restore it, invite people and revoke invitations, remove members, and **transfer ownership** to another member (ADR-0010). The owner cannot leave (`OWNER_CANNOT_LEAVE`) until they have transferred ownership.
- **Deleted budgets (F-36):** invisible to every `/budgets/{budgetId}` route.
  - **Restore route** (`POST /me/deleted-budgets/{deletedBudgetId}/restore`): declares `x-budget-role: deleted_budget_owner`. Its handler obtains a branded **`DeletedBudgetScope`** only from `requireDeletedBudgetOwnership(userId, budgetId)` in `db/`. That function confirms, with a row lock, an `owner` membership on a budget soft-deleted no more than 30 days ago, and whose owner account is not pending deletion. It is the only constructor, and the restore DAL function accepts nothing else.
  - **List route** (`GET /me/deleted-budgets`): a user-scoped query that returns only budgets on which the caller holds the owner membership.
  - **Startup check:** treats `{deletedBudgetId}` like `{budgetId}`; it must declare `deleted_budget_owner`, and only such paths may.
  - **Tests:** generated permission tests cover both routes (other user, current member, former member, owner after the window → 404), and the isolation suite includes them.
  - Anything else is 404.
- **Budget invitations:**
  - The owner invites by email, with re-auth.
  - Acceptance is authorized by `invitation.email == caller.email` (verified). Invitations not addressed to the caller are 404.
  - The create response is identical whether or not an account exists for that email.
  - The owner is emailed when an invitation is accepted.

## 13. Permission matrix
Legend:
- ✓ allowed
- **R** allowed with re-auth in the last 10 min (else 403 `REAUTH_REQUIRED`)
- 401 `UNAUTHENTICATED` (or `MFA_REQUIRED` for an `mfa_pending` session)
- 403 `FORBIDDEN`
- 404 `NOT_FOUND`
- PD = pending-deletion account (✓ if allowed, else 403 `ACCOUNT_PENDING_DELETION`)

### Account-level endpoints
| Endpoint | Anonymous | MFA-pending session | Signed-in user | PD |
|---|---|---|---|---|
| GET /healthz, GET /readyz | ✓ | ✓ | ✓ | ✓ |
| GET /auth/session | 401 | ✓ (`mfa_required`) | ✓ | ✓ |
| POST /auth/login | ✓ | ✓ (replaces session) | ✓ (replaces session) | ✓ |
| POST /auth/logout | ✓ (no-op 204) | ✓ | ✓ | ✓ |
| POST /auth/mfa/verify | 401 | ✓ | 403 | ✓ |
| POST /auth/webauthn/challenge | 401 | ✓ `purpose: mfa` only | ✓ `purpose: reauth` only | ✓ |
| POST /auth/reauth | 401 | 401 `MFA_REQUIRED` | ✓ | ✓ |
| POST /auth/signup/preview, /auth/signup | ✓ | ✓ (session ignored; signup replaces it) | ✓ (same) | ✓ |
| POST /auth/password-reset/request, /verify, /webauthn-challenge, /complete | ✓ | ✓ (session ignored) | ✓ (session ignored) | ✓ |
| POST /auth/email-change/confirm | 401 | 401 | ✓ same user as the token; else 400 `TOKEN_INVALID` | 403 |
| POST /auth/email-change/cancel | ✓ | ✓ (session ignored) | ✓ (session ignored) | ✓ |
| GET /me | 401 | 401 | ✓ | ✓ |
| PATCH /me | 401 | 401 | ✓ | 403 |
| POST /me/password, POST /me/email-change | 401 | 401 | R | 403 |
| GET /me/sessions, POST /me/sessions/revoke-others | 401 | 401 | ✓ | 403 |
| DELETE /me/sessions/{id} | 401 | 401 | ✓ own; others' 404 | 403 |
| GET /me/mfa | 401 | 401 | ✓ | 403 |
| POST /me/mfa/totp, POST /me/mfa/totp/confirm, DELETE /me/mfa/totp | 401 | 401 | R | 403 |
| POST /me/mfa/passkeys/options, POST /me/mfa/passkeys, DELETE /me/mfa/passkeys/{id} | 401 | 401 | R (own passkeys only; others' 404) | 403 |
| POST /me/mfa/recovery-codes | 401 | 401 | R | 403 |
| GET /me/invitations | 401 | 401 | ✓ (addressed to my email) | 403 |
| POST /me/invitations/{id}/accept, /decline | 401 | 401 | ✓ if addressed to my email; else 404 | 403 |
| GET /me/deleted-budgets | 401 | 401 | ✓ (budgets I own, deleted ≤ 30 days ago) | 403 |
| POST /me/deleted-budgets/{id}/restore | 401 | 401 | ✓ if I hold the owner role and it is within 30 days; else 404 | 403 |
| POST /me/export | 401 | 401 | R | R |
| POST /me/deletion | 401 | 401 | R | 403 |
| DELETE /me/deletion | 401 | 401 | 404 (nothing to cancel) | ✓ |
| GET /budgets, POST /budgets | 401 | 401 | ✓ | 403 |

### Budget-scoped endpoints (`/budgets/{budgetId}/…`)
All require an `active` session and an account that is not pending deletion (else 401 / 403 as above).
| Endpoint | Anonymous | User, not a member | Member | Owner |
|---|---|---|---|---|
| GET /budgets/{b} | 401 | 404 | ✓ | ✓ |
| PATCH /budgets/{b} (rename, timezone) | 401 | 404 | 403 | ✓ |
| DELETE /budgets/{b} | 401 | 404 | 403 | R |
| POST /budgets/{b}/transfer-ownership | 401 | 404 | 403 | R |
| GET /budgets/{b}/members | 401 | 404 | ✓ | ✓ |
| DELETE /budgets/{b}/members/{userId} | 401 | 404 | self only (leave); others 403 | others ✓; self 409 `OWNER_CANNOT_LEAVE` |
| GET /budgets/{b}/invitations | 401 | 404 | 403 | ✓ |
| POST /budgets/{b}/invitations | 401 | 404 | 403 | R |
| DELETE /budgets/{b}/invitations/{id} | 401 | 404 | 403 | ✓ |
| GET, POST /budgets/{b}/categories | 401 | 404 | ✓ | ✓ |
| PATCH, DELETE /budgets/{b}/categories/{c} | 401 | 404 | ✓ | ✓ |
| GET /budgets/{b}/months/{m}/plan | 401 | 404 | ✓ | ✓ |
| PUT /budgets/{b}/months/{m}/plan/{c} | 401 | 404 | ✓ | ✓ |
| POST /budgets/{b}/months/{m}/plan/copy-previous | 401 | 404 | ✓ | ✓ |
| GET /budgets/{b}/months/{m}/summary | 401 | 404 | ✓ | ✓ |
| GET, POST /budgets/{b}/transactions | 401 | 404 | ✓ | ✓ |
| GET, PUT, DELETE /budgets/{b}/transactions/{t} | 401 | 404 | ✓ | ✓ |

There is no "admin" column: no HTTP endpoint grants admin powers. Test-only endpoints (test-hooks.md) do not exist in production builds.

## 14. Rate limits
Auth limits and the email budget are stored in Postgres (`auth_throttles`, keys are HMACs with the `throttle-v1` subkey of the current keyring key), so they survive restarts and scale-to-zero. The global and write limits are kept in memory per instance. Every limit answers 429 `RATE_LIMITED` with `Retry-After`, except rows marked "silent", where the response stays 202 so nothing is revealed.

**Client IP (F-08):** the client IP is the address appended by the platform edge. Fastify `trustProxy` is set to the platform's **exact hop count** recorded in ADR-0007, never `true`, so a client-supplied leftmost `X-Forwarded-For` entry is ignored. Per-IP keys use the full IPv4 address, or the **/64 prefix** for IPv6. A test asserts that a forged leftmost `X-Forwarded-For` does not change the derived IP.

| Row (`x-rate-limit`) | Key | Limit |
|---|---|---|
| global | IP | 300 requests / minute |
| writes | user | 120 unsafe requests / minute |
| login | IP | 20 attempts / 15 min |
| login | (email, IP) | 10 failures / 15 min → 429 for that pair for 15 min, identical for unknown emails (F-21) |
| login | email | 100 failures / 24 h → 429 for that email and a notification email to the account. A successful password reset clears both email counters. |
| mfa-verify | session | 5 failures → pending session deleted (sign in again) |
| mfa-failures | user | 20 failed second-factor checks / rolling 24 h across mfa/verify, reauth and password-reset/complete → every factor check 429 until the window ends; `mfa_locked` event and email (F-05) |
| reauth | session | 5 failures / 15 min |
| signup | IP | 10 / hour (preview and signup combined) |
| password-reset-request | IP | 5 / hour (429) |
| password-reset-request | email | 3 / hour and 5 / 24 h (silent, F-09) |
| password-reset-complete | IP | 20 / hour (verify, webauthn-challenge and complete combined); 5 MFA failures per token invalidate it |
| email-change-request | user | 5 / day; and refused while the user has any open `email_change_cancel` token, so at most one change per 24 h (429, `Retry-After` until that token expires, F-33) |
| email-change-confirm | IP | 20 / hour (confirm and cancel combined) |
| budget-invitations | budget / user / invitee email | 20 per budget / day; 30 per user / day; ≤ 20 pending, unexpired per invitee email (`LIMIT_REACHED`, F-31) |
| export | user | 10 / hour |
| email-budget | app-wide, UTC day | `EMAIL_DAILY_QUOTA` is the provider's daily limit (100 on Resend free). Non-priority mail stops at 60% of the quota (60 per day); beyond that only **priority** mail is sent (§15), and the rest is dropped silently. All mail stops at the quota itself. The first time the 60% threshold is hit in a day, a warning-level event goes to Sentry, which alerts the owner (F-09). |

**Enumeration timing (F-22):** `password-reset/request`, `me/email-change` and `budgets/{b}/invitations` POST commit their database work, then send their email inside the request with a provider timeout of **700 ms**. Each response goes out at a fixed **1 s measured from the start of the request**, whether or not an account exists and whether or not the send succeeded. A slow provider therefore cannot stretch the response. A failed send is logged (counts only) and not retried; the user can ask again.

## 15. Security events and notification emails
**`security_events.type` values:**
- Sign-up and sign-in: `signup`, `login_succeeded`, `login_failed`, `mfa_succeeded`, `mfa_failed`, `mfa_locked`, `recovery_code_used`, `reauth_succeeded`, `reauth_failed`, `logout`.
- Sessions: `session_revoked`, `sessions_revoked_others`.
- Password and email: `password_changed`, `password_reset_requested`, `password_reset_completed`, `email_change_requested`, `email_changed`, `email_change_cancelled`.
- MFA: `mfa_enabled`, `mfa_factor_added`, `mfa_factor_removed`, `mfa_disabled`, `recovery_codes_regenerated`, `recovery_codes_retired` (owner retired codes on a burned key, F-38), `passkey_counter_regression`.
- Data rights: `data_exported`, `account_deletion_requested`, `account_deletion_cancelled`.
- Budgets: `budget_invitation_created`, `budget_invitation_accepted`, `budget_invitation_revoked`, `budget_member_removed`, `budget_ownership_transferred`, `budget_deleted`, `budget_restored`.
- Admin: `admin_signup_invite_created`, `admin_mfa_reset`, `admin_sessions_revoked`.

`login_failed` for an unknown email is recorded with `user_id NULL`. Budget events carry `budget_id` (F-26).

**Notification emails** (plain text only). **P** marks priority mail, which is still sent after the daily email budget is reached (§14).
- **Account:**
  - sign-up invite (P)
  - **new sign-in**, with browser, OS, time and a link to the device list (P, F-12). Sent on **every** successful sign-in (password-only, or after MFA completion), with no skip rule (F-34).
  - **5 failed MFA attempts after a correct password** (P), MFA locked (P)
- **Password and email:**
  - password reset link
  - password changed (P)
  - email-change confirmation (to the new address)
  - email-change notice with the cancel link (to the old address, P)
  - email changed (both addresses, P), email change cancelled (P)
- **MFA:** MFA factor added or removed (P), recovery code used (P), recovery codes regenerated (P), **recovery codes retired by the owner because of a key compromise; regenerate them now** (P, F-38), MFA reset by owner (P).
- **Budgets:**
  - budget invitation (only when the invitee has an account)
  - **invitation accepted** (to the budget owner, P)
  - **budget deleted** (to all members, P)
  - **budget restored** (to all members, P)
  - **member removed** (to the removed member, P)
  - **ownership transferred** (to all members, P)
- **Account deletion and restores:**
  - account deletion scheduled (P). It states that every budget the user owns, **including deleted budgets still awaiting restore**, is permanently deleted at purge, and that the restore window for those ends then (F-35).
  - account deletion cancelled (P).
  - After a database restore, the owner sends the notice to all users **manually by BCC** until a CLI command for it exists (owner ruling, round 2).

**Email content rules (F-29):**
- No financial data.
- User-controlled text (budget names, display names) is escaped, never linkified, and capped at its schema length.
- The only links are built from `APP_ORIGIN`.
- Click and open tracking are off.
- The sending subdomain publishes SPF, DKIM and DMARC, ramping to `p=reject` (ADR-0007).

## 16. Owner admin commands
admin-commands.md defines `create-signup-invite`, `reset-mfa`, `revoke-sessions` (one user, `--all`, or `--all --restore`), `security-events` (read-only), `rewrap-mfa` (including `--retire-recovery-codes`) and `purge`. They are CLI commands run **only as Cloud Run jobs** in the private production project (OD-3), never in GitHub Actions.

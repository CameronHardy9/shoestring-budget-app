# Errors
Owner: architect. Consumers: backend (produces), frontend (maps codes to copy), tests (asserts).
Every non-2xx response from `/api` uses `ErrorBody` from api.openapi.yaml. No other error shape exists, including for 404 on unknown routes, 413 and 415 from the framework, and 500.

## ErrorBody
```json
{
  "code": "VALIDATION_FAILED",
  "message": "Some fields are invalid.",
  "requestId": "4f6c1a2e-8a0b-4c55-9a51-0d3e2b7f9c10",
  "details": [
    { "in": "body", "field": "splits.1.amountCents", "issue": "too_small", "message": "Must be at least 1." }
  ]
}
```
| Field | Required | Rules |
|---|---|---|
| `code` | yes | One value from the registry below. Clients switch on `code`, never on `message` and never on HTTP status alone. |
| `message` | yes | Safe English fallback. Never contains submitted values, emails, amounts, payees, memos, names, SQL, stack traces or internal IDs other than the request ID. |
| `requestId` | **yes** | Same value as the `X-Request-Id` response header. |
| `details` | no | `FieldError[]`, max 50. **Always present, with at least one item, for `VALIDATION_FAILED`.** Optional for 409/422 domain codes to point at the offending field. Absent otherwise. |

`FieldError` = `{ in, field, issue, message }`:
- `in`: `body` | `query` | `path` | `header`.
- `field`: dotted path inside `in`. Array indexes are numbers (`splits.0.categoryId`). Header names use their canonical case (`Idempotency-Key`). The empty string means the location as a whole (e.g. a missing body).
- `issue`: a code from the issue registry below.
- `message`: safe fallback text. It never echoes the submitted value.

## Request IDs (`X-Request-Id`)
- The SPA sends `X-Request-Id: <uuid v4>` on every API request (a new one per attempt; a retry of the same intent reuses its Idempotency-Key, not its request ID).
- The backend accepts the incoming value if it matches `^[A-Za-z0-9-]{8,64}$`; otherwise it generates a UUIDv7. It returns `X-Request-Id` on **every** response and puts it in every log line for that request and in `ErrorBody.requestId`.
- The frontend keeps the last requestId for "Copy diagnostics" and tags Sentry events with it. The backend tags Sentry events with it.

## Code registry
One code always maps to one HTTP status.

| HTTP | code | When | `details` |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Path, query, header or body failed the schema (incl. unknown body fields, **unknown query parameters** (`in: query`, `unknown_field`), a body other than `{}` on an operation without a request body, bad UUIDs, missing Idempotency-Key, password policy, unknown timezone, date out of range); a cursor whose MAC fails or that was issued for another budget or other filters (`query.cursor`, `invalid_value`); a body `categoryId` that is not a category of this budget (`splits.N.categoryId`, `invalid_value`); ownership transfer to yourself (`userId`); an email change to the account's current address (`body.newEmail`, `invalid_value`); a `Host` header that is not exactly `URL(APP_ORIGIN).host`, port included (`header.Host`, `invalid_value`; health endpoints exempt) | always |
| 400 | `INVITATION_INVALID` | Sign-up invite token unknown, expired, used or revoked; budget invitation no longer pending (accepted, declined, revoked or expired). One code for all of these, so token existence is not revealed. | no |
| 400 | `TOKEN_INVALID` | Password-reset, email-change or email-change-cancel token unknown, expired, used, deleted by a revocation event (auth.md §2), or invalidated after 5 MFA failures; an email-change token presented by a different user's session or whose requesting session was revoked; a revert whose previous address is now used by another account | no |
| 401 | `UNAUTHENTICATED` | No session, or session expired or revoked. **The only code that means "you are signed out".** | no |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password at login; wrong password at re-auth. Same response for an unknown email. | no |
| 401 | `MFA_REQUIRED` | A second factor is needed and was not supplied: an `mfa_pending` session calling anything except the MFA endpoints; `/auth/reauth` or `/auth/password-reset/complete` without `mfa` for a user with MFA | no |
| 401 | `MFA_FAILED` | TOTP code, passkey assertion or recovery code is wrong, expired or replayed (also on TOTP setup confirm and passkey registration verification) | no |
| 403 | `CSRF_FAILED` | Unsafe method with a bad or missing `Origin`/`Sec-Fetch-Site`, or a session-bearing request without a matching `X-CSRF-Token` | no |
| 403 | `FORBIDDEN` | Signed in and a budget member, but the role does not allow it (member doing an owner action); also a session in the wrong state for the endpoint (e.g. `active` session calling `/auth/mfa/verify`) | no |
| 403 | `REAUTH_REQUIRED` | Sensitive action without re-authentication in the last 10 minutes | no |
| 403 | `ACCOUNT_PENDING_DELETION` | Account is in its deletion grace period and the endpoint is not `x-pending-deletion-allowed` | no |
| 404 | `NOT_FOUND` | Missing, soft-deleted, or **not visible to the caller** (any budget-scoped resource for a non-member, other users' sessions or invitations), a deleted budget the caller does not own or that is past its 30-day restore window, an ownership-transfer target who is not a member, an idempotent replay of a resource that is now deleted or out of scope, unknown route (see "Unknown routes") | no |
| 409 | `VERSION_CONFLICT` | `version` does not match the current row (optimistic concurrency), or `version: null` on a plan entry that now exists | optional: `{in: body, field: version}` |
| 409 | `ALREADY_EXISTS` | Unique rule hit: category name in the budget, pending invitation for that email, invitee already a member, TOTP already enabled, passkey already registered | optional (`duplicate`, `already_member`, `invitation_pending`) |
| 409 | `CATEGORY_IN_USE` | Deleting a category that any split references. Archive it instead. | no |
| 409 | `OWNER_CANNOT_LEAVE` | Owner tries to remove themself from their budget. Transfer ownership first. | no |
| 409 | `OWNS_SHARED_BUDGET` | Account deletion while still owning a non-deleted budget with other members (transfer ownership, remove the members, or delete the budget first) | no |
| 409 | `MFA_NOT_ENABLED` | Regenerating recovery codes or requesting a passkey challenge when the user has no such factor | no |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KiB | no |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body present without `Content-Type: application/json` | no |
| 422 | `SPLITS_DO_NOT_SUM` | Split amounts do not add up to `amountCents` | `{in: body, field: splits, issue: sum_mismatch}` |
| 422 | `CATEGORY_ARCHIVED` | New use of an archived category: a new split, or a plan entry | `{field: splits.N.categoryId or "", issue: archived}` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same `Idempotency-Key` sent with a different method, path or body within 24 h | `{in: header, field: Idempotency-Key}` |
| 422 | `LIMIT_REACHED` | A size limit from data-model.md "Limits" would be exceeded (budgets, categories, members, pending invitations per budget or per invitee email, passkeys), including **restoring a deleted budget when its owner is already in 10 non-deleted budgets, or when any other member would exceed the hard bound of 20** (F-37; the member is never named; soft-deleted budgets never count) | `{issue: limit}` |
| 429 | `RATE_LIMITED` | Rate limit from auth.md §14 hit, including the per-user MFA failure budget (every second-factor check answers 429 until the window ends) and **a second email change while an `email_change_cancel` token is open** (one change per 24 h, F-33), and an MFA check while all 5 attempt slots of the pending session or reset token are used or in flight (`Retry-After: 1`, auth.md §6 "Attempt slots"). `Retry-After` header is set. | no |
| 500 | `INTERNAL` | Unexpected. Details only in server logs and Sentry, keyed by requestId. | no |
| 503 | `UNAVAILABLE` | `/readyz` when the database is unreachable, migrations are missing, or a stored key ID is absent from `APP_KEYRING`. Because `/readyz` is public, its `message` is always the same generic text and never names key IDs, counts, tables or which check failed; the detail is in the server log only. Also: any request while the database is down; the password-hashing queue wait exceeded 2 s (auth.md §7, `Retry-After` set) | no |

The generic `CONFLICT` code from the template is removed in favor of the specific 409 codes above.

## Field issue registry (`FieldError.issue`)
| issue | Meaning |
|---|---|
| `required` | Missing required field, parameter or header |
| `unknown_field` | Field not in the schema (requests reject unknown fields) |
| `invalid_type` | Wrong JSON type |
| `invalid_format` | Bad UUID, date, month, email, token, cursor, code pattern |
| `invalid_value` | Not an allowed enum value, or an unknown IANA timezone |
| `too_small` / `too_big` | Number or date out of range (incl. transaction date outside 2000-01-01 … today + 1 year) |
| `too_short` / `too_long` | String or array length out of range (incl. password under 12 characters) |
| `breached_password` | Password appears in a breached-password corpus (auth.md) |
| `duplicate` | Duplicate within the request (same category twice in `splits`) or an existing unique value |
| `sum_mismatch` | Splits do not sum to the parent amount |
| `archived` | References an archived category |
| `already_member` | Invitee is already a member of the budget |
| `invitation_pending` | A pending invitation already exists for that email |
| `limit` | A count limit was reached |

## Implicit codes (not repeated in each operation's `x-error-codes`)
- Every operation: `INTERNAL`, `RATE_LIMITED` (global per-IP limit), `UNAVAILABLE`.
- Operations with a body: `VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`. Operations with path, query or header parameters: `VALIDATION_FAILED`.
- `x-session` of `active`, `mfa_pending` or `active_or_mfa_pending`: `UNAUTHENTICATED`; `active` also `MFA_REQUIRED` (pending session) and, unless `x-pending-deletion-allowed`, `ACCOUNT_PENDING_DELETION`.
- Every unsafe method (POST, PUT, PATCH, DELETE), public or not: `CSRF_FAILED`.

## Unknown routes and unimplemented operations
- A path under `/api` that the contract does not define, or a defined path called with a method the contract does not list for it (including `HEAD` and `OPTIONS`), answers **404 `NOT_FOUND`** in `ErrorBody`, at check-order step 1 (after the Host check, before rate limits and session checks). There is no 405 and no 501.
- **Every contract operation is implemented.** The backend refuses to start if it registers a route the contract lacks (auth.md §12), and a backend unit test asserts that the registered operation set equals the contract's. Partially implemented contract changes therefore never reach `main`; an operation is added to the contract and implemented in the same release.
- Outside `/api`, a `GET` that accepts `text/html` gets the SPA's `index.html` (ARCHITECTURE "Same origin"); any other unknown path gets the same 404 `ErrorBody`.

## Check order (deterministic; tests rely on it)
0. `Host` equals `URL(APP_ORIGIN).host`, port included (except `GET /api/healthz` and `GET /api/readyz`, which platform probes call with other hosts) → else 400 `VALIDATION_FAILED` (`header.Host`).
1. Route (path and method) exists → else 404 `NOT_FOUND`.
2. Global per-IP rate limit → 429.
3. Session: required and missing/expired → 401 `UNAUTHENTICATED`; wrong state (`mfa_pending` on a non-MFA endpoint) → 401 `MFA_REQUIRED`; `active` on an `mfa_pending`-only endpoint → 403 `FORBIDDEN`.
4. CSRF (unsafe methods) → 403 `CSRF_FAILED`.
5. Pending-deletion restriction → 403 `ACCOUNT_PENDING_DELETION`.
6. Content type and size → 415 / 413; then schema validation of path, query, headers, body → 400 `VALIDATION_FAILED`.
7. Endpoint rate limit (auth.md) → 429. This precedes re-authentication (step 10), so an exhausted quota answers 429 even when re-auth is stale. Rows that count attempts (e.g. `login` per IP, `signup`, `export`) count the request here even when a later step rejects it; rows that count failures or completed actions (e.g. `login` per email, `email-change-request`) are incremented only once that outcome is known.
8. Budget membership (`x-budget-role`) → 404 `NOT_FOUND` for non-members and deleted budgets. For `deleted_budget_owner`: `requireDeletedBudgetOwnership` → 404 unless the caller holds the owner membership of a budget deleted ≤ 30 days ago.
9. Role → 403 `FORBIDDEN`.
10. Re-authentication (`x-reauth`) → 403 `REAUTH_REQUIRED`.
11. Sub-resource lookup within the budget → 404 `NOT_FOUND`.
12. Idempotency key replay or reuse → 201 replay / 422 `IDEMPOTENCY_KEY_REUSED`.
13. Optimistic version → 409 `VERSION_CONFLICT`.
14. Domain rules → 409 / 422 codes above.

## Client handling (frontend)
- `UNAUTHENTICATED`: clear in-memory state, go to sign-in, keep the user's unsaved form input in memory so it survives re-login in the same tab.
- `MFA_REQUIRED`: show the MFA step. `REAUTH_REQUIRED`: open the re-auth dialog, then retry the original request once.
- `VERSION_CONFLICT`: refetch the resource and show "changed by someone else" with both versions; never silently overwrite.
- `VALIDATION_FAILED`: map `details` to fields by `field` path; unmatched details go to a form-level message.
- `RATE_LIMITED`: show a wait message using `Retry-After`. `INTERNAL` / `UNAVAILABLE` / network errors: keep the input and offer retry (transaction creates retry with the same Idempotency-Key).
- Always show or copy the `requestId` on unexpected errors ("Copy diagnostics").

## Logging rules for errors (backend)
Log `code`, HTTP status, route template, requestId, opaque user ID, and for `VALIDATION_FAILED` only the `in`/`field`/`issue` triples. Never log values. 4xx do not go to Sentry.

5xx errors are logged and sent to Sentry through an **allowlist serializer** (F-07): `name`, SQLSTATE `code`, `constraint`, `table`, `column`, and the stack (frames only). **Never** serialized: `message`, `detail`, `where`, `hint`, query text or parameters of database and driver errors, zod "received" values, request or response bodies, headers. The redaction unit test includes a constraint-violation fixture whose `detail` contains a payee and an amount, and asserts that neither appears in the log line or the Sentry event.

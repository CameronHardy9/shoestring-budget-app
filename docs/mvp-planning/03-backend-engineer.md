# Meeting 3: backend-engineer
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP backend scope
- **Auth:** sign up, log in, log out, `/me`, password reset, delete account.
- **Accounts:** CRUD for cash, checking, credit and similar. A balance is the opening balance plus the sum of its transactions.
- **Categories:** CRUD, grouped into income and expense; a starter set is seeded at sign-up.
- **Budgets:** an amount per category per month.
- **Transactions:** CRUD with filters (date range, account, category) and cursor pagination. Transfers are stored as linked pairs so they don't count as spending.
- **Summaries:** a monthly dashboard of budgeted vs spent vs remaining per category, with totals and account balances.
- **Cross-cutting:** money in integer minor units, month boundaries in the user's timezone, idempotency keys on creates (because mobile connections retry), rate limits on auth, structured logs.
- **Defer:** bank sync, notifications/push, recurring transactions, shared budgets, multi-currency, receipts, CSV export, offline sync, admin UI.

### Decisions for the owner
1. **Language and framework:** (a) TypeScript + Fastify + zod *(recommended)*, (b) Python + FastAPI, (c) Go
2. **Login method:** (a) email + password *(recommended)*, (b) magic link only, (c) OAuth (Google/Apple), (d) passkeys. Add OAuth or passkeys later.
3. **Sessions:** (a) httpOnly cookie sessions stored on the server *(recommended)*, (b) JWT bearer tokens
4. **Budget style:** (a) a simple monthly limit per category *(recommended)*, (b) zero-based/envelope with rollover (like YNAB)
5. **Where totals are calculated:** (a) on the server *(recommended)*, (b) in the browser
6. **CSV import in the MVP:** (a) yes, (b) defer *(recommended, unless manual entry alone is unacceptable)*
7. **Email delivery:** (a) a transactional provider (Postmark, Resend or SES) behind an adapter that writes to the console locally *(recommended)*, (b) no email in the MVP
8. **Single user or shared:** single user *(recommended)*, with data tied to a "budget" record so sharing can be added later
9. **Offline:** (a) online only, plus idempotency keys *(recommended)*, (b) queued offline writes

### Draft task list
1. Scaffold: environment config, structured logs with request IDs, a single error handler, `/health`, backend/CLAUDE.md
2. Validation that rejects unknown fields; responses checked against the contract
3. Auth: argon2id hashing, sessions, CSRF protection, rate limits, password reset
4. Authorization middleware that checks every resource's owner (other users' data returns 404)
5. Accounts, categories (with seeding), transactions and transfers
6. Budgets and the monthly summary service (pure functions, fully unit tested)
7. Idempotency keys and cursor pagination
8. Account deletion
9. Unit tests for failure paths and permission denials; `make check` green

### Dependencies
architect (stack, OpenAPI, auth matrix, data model, new error codes such as `INVALID_CREDENTIALS` and `IDEMPOTENCY_CONFLICT`) · data-engineer (Postgres, migrations, data-access module) · ci-engineer (Makefile, compose, env vars) · frontend (same-site cookies, pagination and error patterns) · security-reviewer · sre (hosting, email provider, secrets)

### Risks and open questions
- Expectations for retention, backups and encryption at rest
- Cookie sessions get harder if the frontend and API end up on different domains
- Timezone and month-boundary bugs in summaries
- Is manual entry alone acceptable for the MVP, without CSV import or bank sync?
- Is one currency per user assumed?

## Owner decisions (2026-11-12)
Already settled in meeting 1: TypeScript + Fastify + zod · email + password (argon2id), server-side httpOnly cookie sessions with a 30-day sliding expiry, passkey or TOTP MFA · monthly category limits · totals calculated on the server · no CSV import · **shared budgets** (owner + equal members) · online-only, with idempotency keys · USD only · export + 30-day deletion · $0 cost.
From meeting 2: no accounts or transfers, no recurring transactions, **split transactions included**, Kysely + dbmate.

| Decision | Choice |
|---|---|
| Email delivery | **Free-tier transactional provider** (e.g. Resend or Brevo) behind an adapter that logs to the console locally. The owner has a **custom domain** available (shared with other uses), so send from a dedicated subdomain. sre confirms the provider and the DNS records. |
| Who can invite new people | **Owner only** creates sign-up invites. Budget owners can add existing users to their budget. |
| MFA recovery | **Both:** one-time recovery codes shown at MFA setup, plus an owner-assisted reset as a fallback. An email reset alone never bypasses MFA. |

## Agreed tasks (approved as listed)
1. Scaffold: environment config, JSON logs with request IDs and no financial data, a single error handler, `/healthz` and `/readyz`, backend/CLAUDE.md
2. zod validation that rejects unknown fields; responses checked against the contract
3. Auth: invite-based sign-up, login and logout, sessions, CSRF, rate limits, email verification, password reset
4. MFA: passkeys and TOTP, recovery codes, re-authentication for sensitive actions
5. Owner-only admin commands: create sign-up invites, reset a user's MFA
6. Budgets and members: invite existing users, accept; owner/member authorization on every resource (non-members get 404)
7. Categories, monthly plans, transactions with splits
8. Monthly summary service (pure functions, fully unit tested, consistent with split and month rules)
9. Idempotency keys and cursor pagination
10. Email adapter (free-tier provider; console locally)
11. CSV export, account deletion with a 30-day grace period, and the purge (scheduling at $0 is an sre question)
12. Unit tests for failure paths and permission denials; `make check` green

# Backend conventions (loads when working in backend/) — owner: backend-engineer

Fastify 5 + zod 4 on Node 24 (TypeScript run by type stripping in dev; rolldown
bundle for production). Data access only through `@shoestring/db` (never Kysely
or SQL here; ESLint and Semgrep enforce it). Source of truth: docs/contracts/.

## Layout
| Path | What |
|---|---|
| `src/server.ts` | Production entry → `dist/server.js`. Never imports the test hooks. |
| `src/admin.ts`, `src/admin/cli.ts`, `src/admin/config.ts` | Admin CLI → `dist/admin.js`: every admin-commands.md command, per-command least config, two-step `--yes --expect-user-id`, JSON-line output without emails/tokens |
| `src/dev-server.ts` | Dev/e2e entry: same app + test hooks when every guard passes |
| `src/test-hooks.ts` | `/api/_test/*` (test-hooks.md). Exports the sentinel `__SHOESTRING_TEST_HOOKS__`. Only dev-server imports it |
| `src/app.ts` | `createDeps(config, logger, overrides)` and `buildApp(deps)`; `apiRoutes` lists the registered operations |
| `src/config.ts` | zod env config, fails closed (production refusals per ARCHITECTURE "Config") |
| `src/contract/contract.gen.ts` | GENERATED from api.openapi.yaml (`pnpm --filter ./backend gen:contract`); a test fails when stale |
| `src/http/pipeline.ts` | Global `onRequest`: request id, headers, Host, global limit, session, CSRF, writes limit, pending deletion; the one error handler |
| `src/http/routes.ts` | `defineRoute({operationId, params, query, body, rateLimit, handler})`; per-route steps 6–10; startup checks |
| `src/http/schemas.ts`, `validation.ts` | Strict zod request schemas and helpers (`text`, `optionalText`, `password`, …); zod issue → `FieldError` |
| `src/http/response-validation.ts` | ajv check of every response against the contract (dev/test only; violation → 500 + log) |
| `src/routes/*.ts` | Thin handlers. `src/services/*.ts`: business logic (auth, mfa, recovery = reset + email change, account, budgets) |
| `src/auth/` | sessions/cookies, argon2id queue + policy + HIBP, device vocabulary, TOTP (node:crypto, AES-GCM at rest), recovery codes (HMAC), WebAuthn (`@simplewebauthn/server`) |
| `src/email/` | transports (console, test outbox, Resend), daily budget mailer, notification templates |
| `src/domain/` | pure rules: calendar/date window, MAC'd cursors, idempotency hash |
| `src/test-support/` | `harness.ts`: test app over a **strict fake DAL** (unconfigured calls throw); `fake-mfa.ts`: in-memory dal.mfa; `authenticator.ts`: software WebAuthn authenticator (real signatures) |
| `scripts/` | `gen-contract.ts`, `build.ts` (rolldown), `test-hooks-tripwire.ts` (the Dockerfile tripwire; `pnpm run check-dist`) |

## Rules
- **Routes come from the contract.** Add an operation with `defineRoute({ operationId })` and add it to `apiRoutes`. Method, path and `x-session`/`x-budget-role`/`x-reauth`/`x-idempotency` come from the generated table; `registerRoutes` refuses to start on any mismatch. Do not register `/api` routes by hand (an `onRoute` hook rejects them).
- Every contract operation is implemented (a test asserts `apiRoutes.length === operations.length`). Unimplemented ones would stay unregistered (404); errors.md has no 501.
- **Second factors** go through `services/mfa.ts` `verifySecondFactor` only. Attempt limits are **reserve-first** (F-45): the per-user 20/24 h budget is charged with an atomic upsert before the check and refunded on success, and an `AttemptGuard` reserves the per-session/per-token slot (`dal.sessions|tokens.reserve*/fail*/release*MfaAttempt`) or a throttle row (`throttleGuard`: reauth, TOTP confirm). Never check-then-count. Enrollment (TOTP confirm, passkey registration) is exempt from the user budget.
- **User text in mail** goes through `safeUserText` (NFKC, bidi stripped, dot look-alikes and `. / @ :` defanged, F-48); `text()` rejects bidi controls at input.
- `deleted_budget_owner` routes get `ctx.deletedScope` from `dal.requireDeletedBudgetOwnership` only (F-36).
- **Check order** is errors.md's: Host → route → global limit → session → CSRF → pending deletion → 415/413 → schema → endpoint limit (`rateLimit`) → membership → role → re-auth → handler.
- **Scopes:** a `BudgetScope` only from `dal.requireMembership` (done by the route layer for `member`/`owner` routes; use `ctx.scope`). Never cast to `BudgetScope` (Semgrep).
- **Session IDs** passed to `deleteSession` / `createSession({replacesSessionId})` come only from the caller's own cookie (`resolveSession`). Never use `users.updatePasswordHash` except rehash-on-login.
- **Errors:** throw `ApiError(code, {details})` or let `DalError` propagate; messages are fixed text, never values. Unknown errors become 500 `INTERNAL`, logged through the F-07 allowlist serializer (`logging.ts`).
- **Logging:** `req.log` only (no `console`). Log IDs, codes and counts; never bodies, query strings, emails, names, IPs, amounts, tokens. One line per request is emitted by the pipeline.
- **Time:** read `deps.clock.now()` (the app clock, frozen by test hooks). Wall time (`deps.wallNow`) only for latency padding.
- **Text** inputs use `text(min,max)` (trim, NFC, no control chars, code-point length) so they always pass the DB `is_clean_text` CHECK.
- No `_test` as a whole word in production code (Dockerfile tripwire, Semgrep). `pnpm --filter ./backend build` runs the tripwire.
- `erasableSyntaxOnly`: no TS parameter properties or enums.

## Commands
- `make check` (canonical). Package only: `pnpm --filter ./backend run lint|typecheck|test|build`.
- Unit tests need no database (strict fake DAL). `test` runs with `--coverage`: 100% gate on `src/domain/**`, `auth/totp.ts`, `auth/recovery-codes.ts`. Real-DB integration tests belong to tests/; backend tests may not import `@shoestring/db/testing` (Semgrep).
- Local server: `make dev`, or `pnpm --filter ./backend dev` with `NODE_ENV`, `APP_ORIGIN`, `DATABASE_URL`, `APP_KEYRING`, `COOKIE_SECURE=false` (+ `TEST_HOOKS=1` and `DATABASE_ADMIN_URL` for hooks).
- After editing api.openapi.yaml: `pnpm --filter ./backend gen:contract`.

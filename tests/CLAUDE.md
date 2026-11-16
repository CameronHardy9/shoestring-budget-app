# Test conventions (loads when working in tests/) — owner: test-engineer

Cross-area suites that run against the **running e2e stack** (ADR-0009: backend
dev entry with test hooks, Vite dev server, tmpfs Postgres). Unit tests live
next to the code in each area and belong to that area's owner.

## Layout
| Path | What | Runner |
|---|---|---|
| `contract/` | api.openapi.yaml + errors.md: success/error tour of every operation, generated (property-based) requests, unknown routes/methods, strict rejections, check order, the oracle's self-test | Vitest |
| `integration/` | Behaviour across backend + DAL + Postgres: permission matrices, two-household isolation, owner/member, invitations, splits, money and months, idempotency, paging | Vitest |
| `integration/security/` | Regression tests for security findings; the finding/checklist ID is in the file name or test name | Vitest |
| `e2e/` | Playwright journeys J1–J6 (Phase B) | Playwright |
| `visual/` | Screenshot baselines in the pinned Playwright container (Phase B) | Playwright |
| `support/` | Shared infrastructure (below) | |
| `scripts/stack.sh` | A long-lived local copy of the e2e stack | bash |

## Support modules
- `env.ts`: where the stack is (`APP_ORIGIN`, `API_URL` or `BACKEND_PORT`, DB URLs). API suites call the backend directly with `Host: <APP_ORIGIN host>`; Vite would answer OPTIONS and add CORS headers itself.
- `http.ts`: `ApiClient` = one browser (cookie, in-memory CSRF token, Origin). **Every response is checked by the contract oracle** (`contract.ts`): status listed, schema, code↔status per errors.md, code allowed for the operation, X-Request-Id, `Cache-Control: no-store`, no CORS, never 5xx. A violation throws `ContractViolation` naming operation and problem. Pass `{ contract: false }` only for responses outside the contract (HEAD).
- `hooks.ts`: only the hooks in test-hooks.md: `resetStack`, `setClock`/`advanceClock`/`now`, `emails`/`lastEmail`/`tokenFromLink`, `signupInvite`, `testLogin`; plus the shared DAL whose manual clock always equals the server's frozen clock.
- `factories.ts`: users, budgets, members, categories, plans, transactions through the DAL (`@shoestring/db`). One random password per run, argon2id-hashed once.
- `world.ts`: `seedWorld()` = owner + member of a budget, an outsider with their own budget, one transaction; everyone signed in.
- `recipes.ts`: one known-good call per operation. The tour, matrices and rejection suites are generated from it plus the contract's `x-` extensions; a new operation without a recipe fails `contract/operations.test.ts`.
- `auth.ts`, `totp.ts`, `webauthn.ts`: real sign-in, RFC 6238 TOTP and a software passkey authenticator, written independently of the backend.
- `emails.ts`: auth.md §15 parsed at run time; `setup.ts` checks every captured email of every test against it.
- `arbitraries.ts`: JSON Schema → fast-check. `db-locks.ts`: hold a table lock to make "in flight" deterministic (F-45), superuser queries for states the API refuses to build.

## Determinism and isolation
- One backend holds global state (database, frozen clock, in-memory limiter, outbox), so **files and tests run serially in one worker**. `support/setup.ts` resets everything before **every** test and freezes the clock at `DEFAULT_NOW` (2026-11-16T15:00Z). No test depends on another or on its order.
- No fixed sleeps (ESLint bans `setTimeout`). Move the app clock, or wait on a condition (`db-locks.ts` polls `pg_stat_activity`). Rate-limit windows read the app clock, so `advanceClock` opens them; the reset clears them.
- Property tests are seeded per operation (`FC_SEED` overrides, `FC_RUNS=5` multiplies runs for local exploration). fast-check prints the seed and shrunk counterexample.
- Flaky tests are fixed or quarantined with a written reason. `retry: 0`.
- Known product bugs: `it.fails` with `TODO(BUG-n, owner)` and the report's cross-area entry. Remove `.fails` when fixed (Vitest then fails, prompting it).
- Mind the fixed 1 s answers (F-22) of password-reset request, email-change request and budget-invitation create: seed through the DAL unless that call is under test.

## Test data rules
**Synthetic data only, never real financial data** (checklist C15.7): `@example.test` addresses, invented names and payees, round amounts. No secrets in the repo: passwords and tokens are generated at run time.

## Commands
- Whole thing exactly as CI: `make e2e` (starts and tears down its own stack, then `pnpm --filter ./tests run e2e`).
- While working: `bash tests/scripts/stack.sh up` once (writes `tests/.env.stack`, gitignored), then
  - one file: `pnpm --filter ./tests run api integration/paging.test.ts`
  - one test: `pnpm --filter ./tests run api integration/paging.test.ts -t "tampered"`
  - stop: `bash tests/scripts/stack.sh down`
- `make check` runs this package's `lint` and `typecheck` (there is deliberately no `test` script: these suites need the stack).

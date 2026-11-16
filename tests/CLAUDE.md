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
| `e2e/` | Playwright journeys J1–J6, sessions (C3.4–C3.6), axe on every journey screen; `e2e/csp-prod/` the CSP gate on the production build | Playwright (`playwright.config.ts`) |
| `visual/` | Screenshot baselines (6 screens × light/dark × 2 phones), run only in the pinned Playwright container | Playwright (`playwright.visual.config.ts`) |
| `support/` | Shared infrastructure (below) | |
| `scripts/stack.sh` | A long-lived local copy of the e2e stack | bash |
| `scripts/build-prod-frontend.mjs`, `scripts/prod-server.mjs` | The production frontend built into `.prod-build/`, served with the backend's real headers and `/api` proxied to the stack (CSP gate, visual) | node |
| `ACCEPTANCE.md` | Every acceptance criterion, NFR and security item → its test (keep current) | |
| `RELEASE-CHECKLIST.md` | The owner's manual phone, VoiceOver and TalkBack checklist | |

## Playwright
- Projects: `iphone-webkit`, `pixel-chromium`, `desktop-chrome` (journeys, against the Vite dev server, ADR-0009); `csp-prod-webkit`, `csp-prod-chromium` (production build). `csp-prod-chromium` runs full Chromium (`channel: "chromium"`) with bfcache ON (Playwright's `--disable-back-forward-cache` removed), so `page.goBack()` there must use `waitUntil: "commit"`. Playwright's WebKit never uses bfcache; `e2e/sign-out-back.ts` states which project takes which path. `@playwright/test` is pinned to the version in `.github/tools/Dockerfile`; `make e2e` refuses a mismatch.
- `e2e/fixtures.ts`: every test resets the stack first; every page fails on a `securitypolicyviolation` (collected in Node through `exposeBinding`, so violations on pages the test navigated away from still count; the `cspViolations` fixture holds them) and on uncaught page errors; every email is checked against auth.md §15. Helpers: `signInAs` (test login into the browser's cookie jar), `expectAccessible` (axe, fails on serious/critical; excludes only React Aria's live announcer, as frontend/src/test/axe.ts does), `taps` (tap counter for the 3-tap bar), `quickAddOpener`.
- Journeys use the real UI for the journey itself; setup goes through the DAL and the hooks. Selectors: the frontend test IDs and role/label queries, never CSS paths.
- The Playwright container has **no database packages** (its install leaves `db/node_modules` empty) and no backend port, so `visual/` sets data up over HTTP only (hooks + API through the Vite proxy) and must never import `support/dal.ts` or `support/factories.ts`. `support/hooks.ts`, `support/http.ts` and `e2e/fixtures.ts` stay DAL-free for that reason; the DAL lives in `support/dal.ts`.
- Through the Vite proxy the oracle skips only the CORS-header check (`viaDevProxy`): those headers are Vite's.
- Only the production build sends a CSP, so the gate means something only on the csp-prod projects and in the visual suite.
- Visual: frozen server and browser clocks, fixed names and amounts, animations and caret off. WebKit's screenshot helper injects a `body {}` `<style>` the real CSP blocks; `snap()` checks the gate right before each screenshot and afterwards drops only violations at that helper's exact line and column (read from the installed playwright-core; a Playwright upgrade that moves it fails loudly). **Baselines come only from the container** (`make e2e`, or the `visual` step alone); a missing baseline fails on CI and is written locally. Never update baselines from a macOS browser.

## Support modules
- `env.ts`: where the stack is (`APP_ORIGIN`, `BASE_URL`, `API_URL` or `BACKEND_PORT`). API suites call the backend directly with `Host: <APP_ORIGIN host>`; Vite would answer OPTIONS and add CORS headers itself. **Local only (F-56):** every origin must be http on localhost/127.0.0.1/[::1] (`env-guards.ts`); with APP_ORIGIN exported the process environment is used, otherwise `tests/.env.stack` whole, and a stack variable exported with a different value is an error. `db-env.ts`: the DB URLs, refused unless local (`parseDatabaseUrl` from `@shoestring/db`); every DB connection in tests/ goes through it. Errors name the variable, never the URL.
- `http.ts`: `ApiClient` = one browser (cookie, in-memory CSRF token, Origin). **Every response is checked by the contract oracle** (`contract.ts`): status listed, schema, code↔status per errors.md, code allowed for the operation, X-Request-Id, `Cache-Control: no-store`, no CORS, never 5xx. A violation throws `ContractViolation` naming operation and problem. Pass `{ contract: false }` only for responses outside the contract (HEAD).
- `hooks.ts`: only the hooks in test-hooks.md: `resetStack`, `setClock`/`advanceClock`/`now`, `emails`/`lastEmail`/`tokenFromLink`, `signupInvite`, `testLogin`; plus a teardown registry. `dal.ts`: the shared DAL, whose clock reads the same frozen instant as the server.
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
  - Playwright: `node tests/scripts/build-prod-frontend.mjs` once, then `pnpm --filter ./tests run ui e2e/j2-quick-add.spec.ts --project=iphone-webkit` (add `--headed` or `--ui` to watch)
  - stop: `bash tests/scripts/stack.sh down`
- `make check` runs this package's `lint`, `typecheck` and `test`. `test` (`vitest.unit.config.ts`) runs only the stack-free unit tests of the infrastructure (`support/*.test.ts`); everything else needs the stack.
- `e2e` script order: build the production frontend, Vitest API suites, Playwright. `make e2e` then runs `visual` in the container.

# ADR-0009: e2e runs against dev servers with test hooks, not the production image
- Status: **Accepted (owner, 2026-11-13)**
- Date: 2026-11-13
- Areas affected: ci, tests, backend, sre, security
- Inputs: ci-engineer request; security finding F-10; test-hooks.md

## Context
e2e tests need a frozen clock, a fast reset, a captured email outbox and a test login (test-hooks.md). F-10 showed a contradiction. If e2e runs against the production image, the hooks must be inside that image, and the only things keeping them off in production are environment variables. Cloud Run does not set `NODE_ENV`. A single misconfiguration would then expose `POST /api/_test/login` (anyone becomes anyone).

## Decision
- **`make e2e` runs against development servers:**
  - the backend from source through its **dev entry** (`backend/src/dev-server.ts`, which registers the hooks when the guards pass)
  - the frontend through the Vite dev server proxying `/api` to `API_PROXY_TARGET`
  - Postgres in compose, with `TEST_HOOKS=1`, `NODE_ENV=test` and `APP_ORIGIN=http://localhost:<port>`
- **The production image contains no hooks at all.**
  - The prod build bundles only `src/server.ts` → `dist/server.js` and `src/admin.ts` → `dist/admin.js`.
  - The Dockerfile's prod target **fails the build if anything in `backend/dist/` contains `_test` as a whole word (`grep -w`) or the sentinel `__SHOESTRING_TEST_HOOKS__`** (test-hooks.md; the hooks module must export the sentinel and the build must keep it; production code must not use `_test` as a standalone word), and sets `ENV NODE_ENV=production`.
  - There is no "test" Docker target. F-10's separate-targets idea is satisfied by "prod image vs dev servers".
- **Defence in depth from F-10 is kept:**
  - config fails closed when `NODE_ENV` is missing
  - `TEST_HOOKS=1` with `NODE_ENV=production` refuses to start
  - hooks register only for `localhost`, `127.0.0.1` or `*.test` origins
  - the post-deploy smoke test asserts `/api/_test/reset` → 404
- **Covering the production artifact anyway:** a CI **prod-image smoke** job builds the production image, starts it with production-like config (no hooks, throwaway Postgres, `APP_ORIGIN` set to a `.test` host name), and checks:
  - the SPA loads from `STATIC_DIR`
  - `/api/healthz` and `/api/readyz` respond
  - the security headers and CSP are present
  - the Host check rejects a foreign host
  - `/api/_test/reset` returns 404

  Lighthouse and the bundle-size check run against the production frontend build, not the Vite dev server.

## Alternatives considered
- **e2e against the production image with hooks enabled by env vars:** this is the F-10 risk. Rejected.
- **A `test` Docker target (prod + hooks) for e2e:** closer to production, but it puts hooks into an image built from the same Dockerfile and adds a second image to keep straight. The grep tripwire plus the smoke job give most of the benefit with fewer moving parts.
- **No test hooks (drive everything through the UI and real email):** slow and flaky; there is no way to freeze time.

## Consequences
- Production-only behaviour (static serving, `NODE_ENV=production` paths, headers) is covered by the smoke job and the post-deploy probe, not by the full e2e suite. Bugs that only appear in the bundled build can slip through e2e; the smoke job keeps that gap small.
- Visual baselines and Lighthouse use production frontend builds (pinned Playwright container), so the dev server's styling differences do not leak into them.
- ci-engineer: compose profile for e2e, the dist grep, the prod-image smoke job. backend: dev entry, guards, config refusals. sre: post-deploy probe. test-engineer: tests use only the hooks in test-hooks.md.
- The LAN phone-testing recipe gets no hooks automatically, because the LAN origin fails the origin tripwire (F-30).

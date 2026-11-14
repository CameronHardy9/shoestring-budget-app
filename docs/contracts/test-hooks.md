# Test hooks
Owner: architect. Implemented by backend-engineer; consumed by test-engineer (integration, contract and e2e tests). Build rules: ADR-0009.
Revision 2 (2026-11-13): F-10 and F-30, reconciled with ADR-0009. Revision 3: the tripwire matches `_test` as a whole word (`grep -w`) or the sentinel string (F-10 re-review). Revision 4 (2026-11-14): the outbox `kind` and `links` are pinned to auth.md §15.

Test hooks are HTTP endpoints under `/api/_test/`. They exist only in the **development entry point** when every guard below passes. They are not in api.openapi.yaml, so they are not in the generated client.

## Keeping them out of production (F-10, ADR-0009)
e2e runs against the dev servers (backend from source with hooks, Vite dev server), **not** against the production image. The production image therefore never needs the hooks, and they are physically absent from it:
1. **Separate entry point:** the hooks module is imported only by `backend/src/dev-server.ts`. The production entries `src/server.ts` and `src/admin.ts`, built to `dist/server.js` and `dist/admin.js`, never reference it, directly or dynamically.
2. **Build tripwire:** the production Docker target fails the build if anything under `backend/dist/` contains **`_test` as a whole word** (`grep -rw _test`), which catches `'/api/_test'` + `'/reset'` style prefixes, **or the sentinel `__SHOESTRING_TEST_HOOKS__`**. The test-hooks module must export that sentinel, and the dev build must keep it (it is never tree-shaken or minified away), so its absence from `dist/` proves the hooks are out. **Production code must not use `_test` as a standalone word** anywhere (identifiers, strings, routes). Any false positive from bundled dependency code is handled with a reviewed, path-specific allowlist (security-reviewer approves); the sentinel check never has exceptions. `make image-smoke` (the CI image job, `.github/scripts/image-smoke.sh`) repeats both checks on the **built image**, over everything in `/app`, and also asserts that `/app` holds only `dist/`, `node_modules/`, `package.json` and `public/`, so no source, test or hook file can ride along. Its 404 probe (item 6) covers the same gap at runtime.
3. **Fail-closed environment:** the production Docker target sets `ENV NODE_ENV=production`. Config validation **refuses to start if `NODE_ENV` is missing** or not one of `development`, `test`, `production`. `TEST_HOOKS=1` together with `NODE_ENV=production` refuses to start.
4. **Origin tripwire:** even in the dev entry, hooks register only when `APP_ORIGIN` is `http://localhost[:port]`, `http://127.0.0.1[:port]` or an `http(s)://*.test` origin. Anything else (a LAN IP for phone testing, a real domain) leaves them unregistered and logs a warning. This also covers F-30: the LAN phone-testing recipe cannot expose `/api/_test/*`.
5. **Production probe:** the post-deploy smoke test (sre) asserts that `POST https://shoestring.<domain>/api/_test/reset` returns 404.
6. A separate CI **prod-image smoke** job runs the production image without hooks and checks four things: the SPA, `/api/healthz`, the security headers, and that `/api/_test/reset` returns 404 (ADR-0009).

## Behaviour
- Hooks bypass CSRF and rate limits, but still enforce the Host check, and require `Origin` to match `APP_ORIGIN` or be absent (Playwright's request fixture).
- Errors use `ErrorBody` like every other route.

| Endpoint | Body | Response | Purpose |
|---|---|---|---|
| `POST /api/_test/reset` | `{}` | 204 | Truncate all tables (fast reset between tests). Data-engineer provides the reset function (uses `DATABASE_ADMIN_URL`, local and test only). |
| `POST /api/_test/clock` | `{ "now": "<RFC 3339>" }` or `{ "now": null }` | 204 | Freeze the server clock used for every time rule (today, expiries, sliding and absolute sessions, rate-limit windows, the email budget day) or return to real time. The DAL takes "now" from the app clock, never from the database. |
| `POST /api/_test/signup-invites` | `{ "email": "…" }` | 201 `{ "token": "…" }` | Same as the `create-signup-invite` admin command, but returns the token. |
| `POST /api/_test/login` | `{ "email": "…" }` | 200 `AuthState` + cookie | Create an `active` session for an existing user without password or MFA (speeds up e2e setup). |
| `GET /api/_test/emails?to=<email>` | | 200 `{ "items": [{ "to", "subject", "kind", "priority", "links": [string], "sentAt" }] }` | Read the captured outbox (test email transport), oldest first. `kind` is one value of the closed vocabulary in auth.md §15. `priority` is the **P** column there. `links` are absolute URLs: `APP_ORIGIN` + a path from auth.md §15 "Email link routes", with `#token=…` for token links; `[]` for mails without a link. |
| `DELETE /api/_test/emails` | | 204 | Clear the outbox. |

Factories that create users, budgets, categories and transactions directly in the database live in tests/ and use the data-engineer's DAL, not HTTP.

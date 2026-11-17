---
name: test-infra-gotchas
description: Non-obvious traps in the Shoestring e2e stack and tooling that broke or nearly broke tests/ (Vite proxy, vitest BASE_URL, formatter unescaping, pool size)
metadata:
  type: project
---

Learned building Phase A (2026-11-14/16):

- **API suites must hit the backend directly, not the Vite proxy.** Vite answers OPTIONS itself (204 + CORS headers), which breaks the contract's "unknown method = 404, no CORS" rules. make e2e / e2e-up export API_URL (since 2026-11-16, also into the visual container).
- **Since 2026-11-16 an edge proxy sits in front of backend and Vite (TRUST_PROXY_HOPS=1).** Per-client IPs only via X-E2E-Client-IP (ApiClient `clientIp`); the default peer IP is the Docker gateway and differs on Linux CI. tests/scripts/stack.sh is gone: use make e2e-up/e2e-down.
- **Vitest sets process.env.BASE_URL = "/"** (Vite base), so never use BASE_URL presence to detect the stack. env.ts keys off APP_ORIGIN.
- **A format-on-write hook rewrites `"‮"` escapes into literal characters.** Literal bidi/zero-width chars then trip Semgrep's Trojan Source rule. Build such strings with String.fromCodePoint, and grep for invisible chars after editing.
- **Backend DAL pool is 5.** Holding a DB lock that blocks 5 requests starves the pool, so later requests hang instead of answering. For F-45 "in flight", block exactly one request (4 sequential failures + 1 blocked by an EXCLUSIVE lock on auth_throttles).
- **The outbox is not cleared by /api/_test/reset.** resetStack also calls DELETE /api/_test/emails.
- Frozen clock + test login: sessions expire after 30 days of the frozen clock, so sign in again after advancing more than 30 days.
- frontend/src/App.test.tsx "auth guard" tests flaked once under the parallel `make test` load (stuck on Loading). Reported to frontend-engineer 2026-11-16.

- **Vite dev sends no CSP** (and injects inline styles in dev), so the CSP gate runs on the production build: tests/scripts/prod-server.mjs serves tests/.prod-build with the backend's headers copied from /api/healthz. Coordinator ruling 2026-11-16: SPA/static header checks belong to image-smoke, not e2e.
- **axe flags React Aria's LiveAnnouncer** (transient `div role=img` with a dangling aria-labelledby in `[data-live-announcer]`); exclude that node only, as frontend/src/test/axe.ts does.
- React Aria injects usePreventScroll's <style> only on iOS; Playwright's iPhone emulation needs navigator.platform overridden to "iPhone".
- page.request shares the browser context's cookie jar, so POST /api/_test/login there signs the browser in.
- The Bash auto-mode classifier sometimes fails repeatedly; after 10 misses in a row the turn stops. Switch to Read/Write work and retry later.

**Why:** each of these cost a debugging round or would mislead the next person.
- **Recurring backend pattern: count-then-hit limits** are not race-safe. The reset-request per-address rows had it; fixed 2026-11-16 as F-57 (reserve first: add, compare, refund). Look for the pattern in new limits. A deterministic race test is hard because the per-IP upsert runs before the count; the owner has not asked for an API burst test.
- Timing (F-22) tests: run known/unknown samples concurrently and compare medians; observed gap ~1 ms on OrbStack, all ~1020-1060 ms.
- **Taps right after navigation (2026-11-16):** two lost taps on iphone-webkit (/more layout shift; quick-add + inert while the budget loaded) were fixed in the product on fix/loading-tap-targets, not by test waits; j2 now holds GET /api/budgets/{id} with page.route to prove + works while loading. Diagnose such flakes from the trace timeline (click time vs API responses).
- **Flaky area: /api/_test/reset deadlock (40P01), once in ~8 runs (2026-11-16).** The reset's one-statement TRUNCATE of all tables can deadlock with the backend healthcheck's /api/readyz reads (docker-compose.yml polls readyz). Shows as "test hook POST /api/_test/reset answered 500" in whatever test is next. Reported to data-engineer/backend-engineer; not a test bug.

**How to apply:** check this list before changing tests/support or adding concurrency tests. Related: [[test-data-strategy]].
- **bfcache under Playwright (verified 2026-11-16, PW 1.65):** Chromium gets `--disable-back-forward-cache` by default, and the headless shell never caches anyway (CDP reason BackForwardCacheDisabledForDelegate). It works with `channel: "chromium"` plus `ignoreDefaultArgs: ["--disable-back-forward-cache"]`, but then `page.goBack()` must use `waitUntil: "commit"` (a restore fires no load event, so the default hangs). Playwright's WebKit never restores from bfcache, headed or headless.
- **WebKit screenshots inject `<style>body {}</style>`** (inPagePrepareForScreenshots, sync animations). The violation has an empty `sample` (no 'report-sample' in the CSP) and the event target is the document, so it can only be identified by line/column in the evaluated helper (5:30 in 1.65). Chromium injects nothing. Caret hiding uses inline style via CSSOM, which CSP allows.
- `exposeBinding` survives navigations; use it for anything collected from the page across documents.
- **Building RegExps from strings (2026-11-16):** CodeQL `js/incomplete-sanitization` fails PRs on partial escaping, and Semgrep's `detect-non-literal-regexp` taints every function parameter that reaches `new RegExp`, ignoring escaping. Use `support/regex.ts` (`escapeRegExp`, `openApiPathRegex`, `templateRegex`, `endsWithRegex`); its private `compile()` holds the one justified nosemgrep. `RegExp.escape` exists in Node 24 but the tests tsconfig lib is ES2024, so it isn't typed.

Learned on the Sentry PR (2026-11-17):
- **parseStackFile only read `[A-Z_]+` keys**, so `E2E_SENTRY_DSN` (digits) in tests/.env.stack was silently ignored; fixed to `[A-Z][A-Z0-9_]*`. Any new stack variable with a digit was invisible before.
- **WebKit mutes errors thrown from Playwright init scripts** (ErrorEvent.error null → report.ts sends "Script error"); promise rejections are not muted. Use a rejection when the test needs the real message on WebKit.
- **At addInitScript time `document.documentElement` can be null**: `MutationObserver.observe(document.documentElement)` throws and silently kills the rest of the init script. Observe `document` with subtree.
- Sentry envelopes: the SDK adds `sdk.integrations/packages/settings{infer_ip:"never"}` AFTER beforeSend; Sentry's fetch transport sends Referer origin-only (strict-origin). Probe real envelopes with a throwaway spec before writing allowlists.
- Service workers DO run under Playwright on both csp-prod engines (localhost is a secure context; prod-server serves /sw.js). Only sw-first-visit.spec.ts allows them.

Learned on the offline PR (2026-11-17, PW 1.65):
- **`context.setOffline` works on all three journey projects:** navigator.onLine flips and `offline`/`online` fire (what TanStack's onlineManager needs; a `page.route` abort does not pause reads). It did NOT close Vite's open HMR socket in a probe, but offline.spec.ts mocks it with `page.routeWebSocket` anyway and asserts no reload (a closed socket = Vite polls then `location.reload()`).
- **Every screen is lazy:** offline, a never-fetched screen module fails to import on the dev server. Preload online with `import("/src/app/lazy-screen.tsx").preloadAllScreens()` in page.evaluate (same module instance), which caches no data.
- An offline (refused) fetch still emits Playwright `request` events with its headers (Idempotency-Key observable). `page.request` ignores setOffline.
- **Recurring false-alarm class: digit patterns vs clock-derived IDs (2026-11-17).** The Sentry gate's `8765` amount regex matched "-8765-" inside a UUIDv7 (leading groups = clock), only at certain times. Mask UUIDs, 32-hex IDs and lineno/colno/timestamp/status_code values first (support/pii-scan.ts, unit-tested). Apply the same masking to any new "value must not appear" scan.

---
name: test-infra-gotchas
description: Non-obvious traps in the Shoestring e2e stack and tooling that broke or nearly broke tests/ (Vite proxy, vitest BASE_URL, formatter unescaping, pool size)
metadata:
  type: project
---

Learned building Phase A (2026-11-14/16):

- **API suites must hit the backend directly, not the Vite proxy.** Vite answers OPTIONS itself (204 + CORS headers), which breaks the contract's "unknown method = 404, no CORS" rules. make e2e exports BACKEND_PORT (undocumented); tests/support/env.ts falls back to it. Asked ci-engineer to export API_URL.
- **Vitest sets process.env.BASE_URL = "/"** (Vite base), so never use BASE_URL presence to detect the stack. env.ts keys off APP_ORIGIN.
- **A format-on-write hook rewrites `"‮"` escapes into literal characters.** Literal bidi/zero-width chars then trip Semgrep's Trojan Source rule. Build such strings with String.fromCodePoint, and grep for invisible chars after editing.
- **Backend DAL pool is 5.** Holding a DB lock that blocks 5 requests starves the pool, so later requests hang instead of answering. For F-45 "in flight", block exactly one request (4 sequential failures + 1 blocked by an EXCLUSIVE lock on auth_throttles).
- **The outbox is not cleared by /api/_test/reset.** resetStack also calls DELETE /api/_test/emails.
- Frozen clock + test login: sessions expire after 30 days of the frozen clock, so sign in again after advancing more than 30 days.
- frontend/src/App.test.tsx "auth guard" tests flaked once under the parallel `make test` load (stuck on Loading). Reported to frontend-engineer 2026-11-16.

**Why:** each of these cost a debugging round or would mislead the next person.
**How to apply:** check this list before changing tests/support or adding concurrency tests. Related: [[test-data-strategy]].

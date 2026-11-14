---
name: backend-gotchas
description: Non-obvious environment and tooling gotchas hit while building backend/ (formatter hook, Host header in smoke tests, Semgrep false positives, supply-chain-safe deps)
metadata:
  type: project
---

- **The editor's PostToolUse formatter turns `\uXXXX` escapes in Write/Edit content into literal characters** (U+2028, U+200B, U+0301, NBSP). Literal U+2028 inside a regex broke compilation once. After writing code with escapes, scan for control/invisible chars and re-escape with a Python one-liner.
  **Why:** happened 2026-11-13 in notifications.ts and tests. **How to apply:** prefer writing escape-heavy lines via python, then grep.
- **Node fetch (undici) cannot set `Host`**, so manual smoke scripts must run the server with `APP_ORIGIN` equal to the real address (e.g. http://127.0.0.1:3999). The Host check is covered by `app.inject` tests instead.
- **Semgrep's regex rules flag strings**, not just imports: ESLint ban patterns naming "kysely" / db internals / `@shoestring/db/testing`, and any file containing `_test` or the hooks sentinel (scripts too). Files with `test-hooks` in the name and `*.test.*` are excluded. The tripwire script is therefore `scripts/test-hooks-tripwire.ts`.
- Backend unit tests may NOT import `@shoestring/db/testing` (Semgrep allowlist), so they use the strict fake DAL in `src/test-support/harness.ts`; real-DB checks are manual smoke or tests/.
- Supply chain (strictDepBuilds, 7-day age): esbuild has a postinstall (blocked); rolldown and `@node-rs/argon2` have none. `@node-rs/argon2`'s `Algorithm` is a const enum (unusable with isolatedModules): check the `$argon2id$` PHC prefix instead.
- Fastify 5.12: `trustProxy` typed without `number` (use a `(addr, hop) => hop < n` function); `disableRequestLogging`/`requestIdLogLabel` are deprecated in favour of `logController: new LogController({...})`.

Related: [[phase-a-status]]

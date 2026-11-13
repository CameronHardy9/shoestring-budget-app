---
name: pipeline-timings
description: Local timings of make setup/check/e2e/audit, baseline with zero packages (2026-11-12) and with db/ only (2026-11-13), to spot regressions
metadata:
  type: project
---
Baseline on the owner's Mac (OrbStack, warm image cache), zero area packages, 2026-11-12:
- make setup 1s · make check 5-8s (mostly the actionlint and shellcheck containers) · make e2e 2-3s (Postgres only, tmpfs) · make audit 9-12s (Semgrep about 6s, with registry rules fetched each run).
- Cold first pulls: Postgres about 6s, Semgrep image about 1 min, Playwright image about 1-2 min.
- Synthetic full stack (db, backend and frontend fakes): make dev about 8-16s cold, hot reload through the bind mount about 1s; e2e with a visual test in the Playwright container about 14s warm (51s cold).

With db/ only (2026-11-13, 188 packages): make check about 38s (lint 14s, typecheck 2s, test 17s incl. throwaway Postgres + migrate + 117 vitest tests) · make audit about 20s · make e2e about 8s (deps + migrate one-shots, no suites yet) · forced pnpm install 3.4s.

**Why:** the check stage target is under 10 minutes; these numbers show where time goes as packages land.
**How to apply:** compare against new runs after packages are added. If check grows past a few minutes, look at per-package lint/test first. See [[environment-pitfalls]].

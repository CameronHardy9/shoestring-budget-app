---
name: pipeline-timings
description: Local timings of make setup/check/e2e/audit/image/image-smoke: zero packages (2026-11-12), db/ only (2026-11-13), backend+db (2026-11-14), make test worker budget and full suites incl. e2e 9 min (2026-11-16)
metadata:
  type: project
---
Baseline on the owner's Mac (OrbStack, warm image cache), zero area packages, 2026-11-12:
- make setup 1s · make check 5-8s (mostly the actionlint and shellcheck containers) · make e2e 2-3s (Postgres only, tmpfs) · make audit 9-12s (Semgrep about 6s, with registry rules fetched each run).
- Cold first pulls: Postgres about 6s, Semgrep image about 1 min, Playwright image about 1-2 min.
- Synthetic full stack (db, backend and frontend fakes): make dev about 8-16s cold, hot reload through the bind mount about 1s; e2e with a visual test in the Playwright container about 14s warm (51s cold).

With db/ only (2026-11-13, 188 packages): make check about 38s (lint 14s, typecheck 2s, test 17s incl. throwaway Postgres + migrate + 117 vitest tests) · make audit about 20s · make e2e about 8s (deps + migrate one-shots, no suites yet) · forced pnpm install 3.4s.

With backend/ + db/ (2026-11-14, 310 packages): make check about 34s (lint 15s, typecheck 5s, test 12s, 396 tests) · make audit 20s · make image 5-11s warm (image 324 MB, /app 65 MB of which ~36 MB is db/dbmate dead weight) · make image-smoke 12s · make dev 7s · make e2e 9s.

make test worker budget (2026-11-16, 4 test packages incl. tests/ unit, 8-core Mac under load avg 12-20 from other agents): old behaviour (all packages at once, Vitest default cpus-1 workers each) failed 2/2 make check runs (frontend axe tests hit 5 s, db's 300 ms summary perf test). New default (cpus/packages rounded up, min 2 = 2 each here) passed 3/3: make check 153/126/125 s (lint 41-55, typecheck 12-16, test 57-76). Quiet machine baseline earlier that day: make check 87 s, test 36 s. CI (4 vCPU) make test was 36 s with the old behaviour. Sequential (1 pkg x 8 workers) was no faster than parallel. pnpm -r's topological sort runs backend after db (backend depends on db); --no-sort was not faster.

**Why:** the check stage target is under 10 minutes; these numbers show where time goes as packages land.
**How to apply:** compare against new runs after packages are added. If check grows past a few minutes, look at per-package lint/test first. See [[environment-pitfalls]].

Full suites (2026-11-16, tests/ complete, e2e edge added, load avg ~10 from parallel agents): make e2e 9m11s (stack healthy 14s, Vitest API 1408 tests 245s, Playwright 54 tests 4.0m, visual 24 shots 38s in the container) · make e2e-up 17s · make check 76s · make audit 64s · make image 33s · make image-smoke 41s. CI e2e job timeout is 20 min; watch it if suites keep growing.

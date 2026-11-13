---
name: schema-conventions
description: Decisions behind Shoestring's db/ design that are not obvious from the code (role model, roles.sql dual-run, runtime scope check, Node type stripping, test clones)
metadata:
  type: project
---

Design decisions made when building db/ (2026-11-13), with the reasons:

- roles.sql is run twice per database: as the DB owner (creates roles, database/schema grants) and as migrator (table grants, which only the owner of the tables can give, and which pg_restore --no-privileges drops). Steps the caller cannot do are skipped; a final verify block fails loudly. Runbooks (bootstrap step 8, restore steps 5/7) depend on this; restore step 5 must use the owner URL.
- BudgetScope has a runtime WeakSet check on top of the TypeScript brand, so `as BudgetScope` forgeries fail at runtime (F-18 asked for tooling, this adds defense in depth).
- The isolation test has a coverage check: every function exported by a budget-domain repo module must be in its CASES table.
- Repo modules must export only ctx-first functions (dal.ts binds them generically); pure helpers live in src/*.ts.
- CLIs run as TypeScript through Node 24 type stripping (no tsx dependency); `build` emits dist/ for the production image.
- Tests clone the migrated DB per file (CREATE DATABASE ... TEMPLATE, ~100 ms) instead of transaction rollback, because many DAL functions open their own transactions and test concurrency.
- purge_security_events() deliberately uses the DB clock (no "now" argument) so the app role cannot wipe the audit log.

- Security review 2026-11-13 (F-41..F-44) added hard rules: scope minting stays module-private; every DB URL goes through src/conn.ts (pg's own parser, no host/hostaddr params; `new URL().hostname` alone is bypassable); seed refuses non-local hosts and production; PUBLIC loses TEMPORARY on the database; seed/testing code is excluded from `files` and dist.

**Why:** these choices trade a little complexity for contract guarantees (F-11, F-18, F-26) and fast isolated tests.
**How to apply:** keep them when extending db/; if changing one, re-check the runbooks and security findings it supports. Related: [[migration-pitfalls]].

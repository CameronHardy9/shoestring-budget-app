---
name: test-data-strategy
description: How tests/ isolates data (serial + per-test reset), why not parallel, and the recipes/oracle design that new operations must plug into
metadata:
  type: project
---

- One e2e backend holds global state (DB, frozen clock, in-memory limiter, outbox), so the Vitest API suites run **serially, with a reset before every test** (support/setup.ts). Parallel workers would need one backend + DB clone each. createDatabaseClone can't clone while the backend is connected to the template.
- Every response goes through the contract oracle in support/http.ts. support/recipes.ts holds one known-good call per operationId. The tour, both permission matrices and the rejection suite are generated from it, so a new contract operation fails until it gets a recipe.
- Factories write through the DAL with a manual clock kept equal to the server's frozen clock. Requests that are padded to a fixed 1 s (password-reset request, email-change request, invitation create) are seeded via the DAL unless the call itself is under test.
- Phase A timing: about 1320 tests in about 135 s; make e2e takes about 148 s in total. Phase B Playwright must also run with workers: 1 or avoid global hooks.
- BUG-1 closed 2026-11-16 by a contract change, not a fix: GET/HEAD bodies are ignored (errors.md "Request bodies"). The oracle allows 413/415 only on POST/PUT/PATCH/DELETE; generators send stray GET bodies.
- Test env is local-only (F-56): stack vars exported in the shell that differ from tests/.env.stack are an error, so `unset DATABASE_URL` etc. if a run dies with StackEnvError.
- Passwords in tests/ only come from `randomPassword()` (support/passwords.ts), never an inline `` `pw-${randomUUID()}` `` template. GitGuardian "Generic Password" (incident 40152085) flags a password-named variable or key assigned a string, even when it is random at run time. The owner ruled that tests/ stays scanned (2026-11, mvp-planning/10 round 5), so the fix belongs in the code, not in a scanner exclusion.

**Why:** the design choices aren't obvious from any single file.
**How to apply:** follow this when adding suites in Phase B. Related: [[test-infra-gotchas]].

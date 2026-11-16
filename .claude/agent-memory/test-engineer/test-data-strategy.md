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
- Known contract deviation: GET request bodies are ignored, not 400/415 (BUG-1, it.fails in contract/routes.test.ts).

**Why:** the design choices aren't obvious from any single file.
**How to apply:** follow this when adding suites in Phase B. Related: [[test-infra-gotchas]].

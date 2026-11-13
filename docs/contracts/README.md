# Contracts
The agreements between areas. Owned by the architect, changed only with owner
approval, and always changed *before* the implementation that depends on them.

| File | Defines | Consumed by |
|---|---|---|
| api.openapi.yaml | Every HTTP endpoint under `/api`, payloads, status codes, per-operation auth/role/re-auth extensions | backend (implements), frontend (generated client), tests (contract and permission tests) |
| data-model.md | Entities, relationships, invariants (DB-enforced where possible), data classification, limits, purge, CSV export | data-engineer (migrations, DAL), backend, security-reviewer, sre |
| auth.md | Sessions, CSRF, MFA, re-auth, rate limits, permission matrix | backend, frontend, security-reviewer, tests |
| errors.md | ErrorBody shape, code and issue registries, check order, X-Request-Id | backend, frontend, tests |
| admin-commands.md | Owner-only CLI commands run as Cloud Run jobs (invites, MFA reset, session revocation, audit view, purge) | backend (implements), sre (jobs, runbooks, scheduling), security-reviewer |
| test-hooks.md | Test-only endpoints (clock, reset, outbox, test login) and the rules that keep them out of production | backend (implements), tests, ci (build tripwire) |

Generated code (API client, types) is produced from these files and never hand-edited.
Validate the OpenAPI file with any OpenAPI 3.1 validator (ci-engineer wires one into `make check`).

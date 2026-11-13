# ADR-0001: Stack and repository layout
- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-12
- Areas affected: frontend, backend, data, tests, ci, sre

## Context
One human developer and a team of agents build and maintain a small mobile-first PWA at $0 running cost. Every area should share one language so types, tooling and CI stay simple. The API contract must be enforceable on both sides.

## Decision
- **Language:** TypeScript (strict) everywhere. **Node 24 LTS**, pinned (`.nvmrc` + `packageManager`).
- **Repo:** one **pnpm workspace** with packages `frontend`, `backend`, `db` (`@shoestring/db`), `tests`. Root workspace files are owned by ci-engineer.
- **Frontend:** React + Vite SPA; React Aria or Radix primitives; Tailwind with CSS-variable design tokens (light/dark following the system plus a manual switch); own SVG charts with table equivalents; Vitest + Testing Library + axe.
- **Backend:** Fastify + zod (unknown fields rejected), pino JSON logs, argon2id, SimpleWebAuthn (or equivalent maintained library), an `otplib`-class TOTP library. The backend also serves the built SPA (same origin).
- **Data:** PostgreSQL; **dbmate** plain-SQL migrations (reviewable SQL, no ORM migrations); **Kysely** typed query builder inside a data-access module owned by data-engineer. Two DB roles: `migrator` (DDL) and `app` (DML).
- **Contract-first API:** docs/contracts/api.openapi.yaml is the source of truth. `openapi-typescript` generates types for both frontend and backend; the frontend uses `openapi-fetch` (small, typed) wrapped with CSRF, request-ID and error handling. Backend zod schemas are checked against the generated types at compile time and responses are validated against the contract in tests. CI fails on stale generated files.
- **Tests:** Vitest (unit, next to code), Playwright (e2e on emulated iPhone WebKit, Pixel Chromium, desktop Chrome; screenshots in a pinned Linux container), axe, OpenAPI response validation plus generated requests for contract tests.
- **CI:** GitHub Actions on a public repo, SHA-pinned actions, `permissions: {}` by default, gitleaks + Semgrep CE + osv-scanner + CodeQL, Dependabot weekly grouped. Package manager and supply-chain settings: ADR-0008. Test topology: ADR-0009.
- **Workspace interface:** every package exposes `lint`, `typecheck`, `test` (+ `build`, `dev` where relevant); backend builds `dist/server.js` and `dist/admin.js`; db adds `migrate` and an idempotent `seed`; tests adds `e2e` and `visual` (ARCHITECTURE "Workspace interface").
- **Local:** docker compose on OrbStack runs Postgres, backend and frontend with hot reload.

## Alternatives considered
- **Next.js / SvelteKit:** SSR is unnecessary for an authenticated SPA and complicates same-origin cookie handling and free hosting; a static SPA plus API is simpler.
- **FastAPI / Go backend:** a second toolchain in CI and no shared types.
- **Prisma / Drizzle migrations:** less reviewable SQL; DB-level invariants (deferred constraint triggers, partial unique indexes) are first-class in plain SQL.
- **SQLite:** weak fit for free managed hosting and for multiple instances; Postgres free tiers exist.
- **Code-first OpenAPI (generate from zod):** couples the contract to backend code and lets the backend change the contract without architect review.
- **Separate per-area installs:** duplicate tooling and version drift.

## Consequences
- One language, one lockfile, one CI toolchain. Contract drift becomes a type error.
- Owner prerequisite: upgrade the local Node 20.10 to Node 24 and install OrbStack.
- ci-engineer wires: OpenAPI validation, client generation and the staleness check into `make check`; bundle-size check; Lighthouse CI.
- The generated client and types are never hand-edited.

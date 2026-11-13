# Meeting 6: ci-engineer
Status: **meeting held 2026-11-12**

## Findings from prep
- The Makefile targets all `exit 1`. ci.yml has the right shape but uses unpinned `actions/checkout@v5` and sets up no toolchain.
- **No container runtime is installed on this Mac** (no Docker, Colima, OrbStack or Podman), so `make dev` with compose won't work yet.
- Local Node is v20.10, which reached end of life in April 2026. pnpm, python3, gh and jq are present.
- `.gitignore` doesn't cover `.env.production`, `node_modules/`, build output or coverage.
- The folder is not a git repository yet.

## Agent's agenda

### Proposed MVP scope
- **Day one:**
  - Working Makefile targets
  - Pinned toolchain (`.nvmrc`/`.tool-versions`, `packageManager`)
  - Compose with Postgres
  - ci.yml with SHA-pinned actions, caching and a Postgres service
  - `make audit`: dependencies, secrets and SAST, failing on high severity
  - Dependabot
  - A hardened `.gitignore`
  - Branch-protection recommendations
- **Later:** a versioned image in GHCR, signing and SBOM, per-PR previews, a visual baseline service, a merge queue, nightly scans

### Decisions for the owner
1. **Repo layout:** (a) a single pnpm workspace *(recommended if TypeScript end to end)*, (b) separate per-area installs, (c) polyglot (pnpm + uv)
2. **Local dev model:** (a) everything in compose, (b) only Postgres in compose with app servers on the host and hot reload *(recommended)*, (c) local Postgres with no compose
3. **Container runtime on your Mac:** Docker Desktop, OrbStack or Colima *(OrbStack or Colima recommended)*
4. **GitHub repo:** private or public? Protect `main` with required checks `check`, `e2e` and `audit`, linear history, and conversations resolved before merge. Protection on private repos needs GitHub Pro.
5. **Dependency updates:** (a) Dependabot, weekly and grouped *(recommended)*, (b) Renovate. Should patch updates merge automatically?
6. **Security tooling:** gitleaks + Semgrep CE + osv-scanner, with versions pinned *(recommended)*, plus GitHub push protection. CodeQL needs Advanced Security on private repos.
7. **CI minutes and cost:** 2,000 free minutes a month on private repos. Cap check at about 10 minutes and e2e at about 20; Chromium only for the MVP; $0 spending limit.
8. **Runtime:** Node 22 or 24 LTS, pinned. Upgrade the local Node 20.

### Draft task list
1. Version pin files; complete `.gitignore`
2. `make setup` and `make check`
3. docker-compose.yml with Postgres, health checks and seed data; `make dev`
4. `make e2e`: start the stack, migrate, run tests, tear down
5. `make audit` with gitleaks, Semgrep and a dependency audit
6. Rewrite ci.yml: SHA pins, pnpm cache, Postgres service, Playwright artifacts, no secrets in PR jobs
7. Dependabot config covering the package manager, github-actions and docker
8. Branch-protection checklist for the owner
9. A multi-stage, non-root Dockerfile for sre
10. Record baseline timings

### Dependencies
architect (stack, layout, OpenAPI tooling) · data-engineer (migration and seed commands) · test-engineer (frameworks, visual baselines) · frontend and backend (lint and format configs, which also feed `.claude/hooks/format.sh`) · security-reviewer (scanners and thresholds) · sre (hosting and registry)

### Risks and open questions
- `git init` and a GitHub remote must exist before any CI can run
- `make dev` and `make e2e` can't be verified until a container runtime is installed
- Visual tests are flaky across operating systems, so run them only in Linux containers
- A non-TypeScript backend means two toolchains in CI
- Bank-sync secrets would need environment-scoped secrets that fork PRs can't reach

## Owner decisions (2026-11-12)
| Decision | Choice |
|---|---|
| Repo visibility | **Public**: unlimited free Actions minutes, free branch protection, free CodeQL. Synthetic data only; secret scanning and push protection are essential. |
| Container runtime | **OrbStack** (owner installs it) |
| Local dev model | **Everything in containers** (Postgres, backend, frontend), with hot reload through bind mounts (owner chose this over host-run apps) |
| Defaults accepted | Node 24 LTS (owner upgrades from Node 20) · single pnpm workspace · Dependabot weekly and grouped, no automerge · gitleaks + Semgrep CE + osv-scanner + CodeQL · SHA-pinned actions · $0 Actions spending limit |

## Agreed tasks (approved as listed)
1. Version pins (Node 24, pnpm); complete `.gitignore` (`.env.*`, node_modules, build output, coverage)
2. `make setup` and `make check`
3. docker-compose.yml: Postgres, backend and frontend with hot reload via bind mounts, health checks, migrations and seed on start; `make dev`
4. `make e2e`: start the stack, migrate, run tests, tear down; screenshots generated in a pinned Playwright container
5. `make audit`: gitleaks + Semgrep + osv-scanner, failing on high severity
6. ci.yml: SHA pins, pnpm cache, Postgres service, Playwright artifacts on failure, no secrets for fork PRs, CodeQL
7. Dependabot for npm, github-actions and docker
8. Owner checklist: `git init`, create the public repo, branch protection on main, push protection, $0 spending limit
9. A multi-stage, non-root Dockerfile for sre
10. Phone-testing recipe: expose `make dev` on the LAN

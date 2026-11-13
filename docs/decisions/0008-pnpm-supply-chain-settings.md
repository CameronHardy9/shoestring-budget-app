# ADR-0008: pnpm 10 with supply-chain settings
- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-13
- Areas affected: ci, frontend, backend, data, tests, security
- Inputs: ci-engineer request; security finding F-16; owner decision "pnpm 10.34.9 with its supply-chain settings" (mvp-planning/10)

## Context
The repo is public, and CI holds deploy and backup identities. A compromised npm package runs code at install time through `postinstall` and similar scripts, as in the 2025 npm worm campaigns. Malicious versions are usually caught and unpublished within days. One package manager across the workspace keeps the controls in one place.

## Decision
- **pnpm 10.34.9**, pinned with `packageManager` in the root `package.json` (Corepack). CI and the Dockerfile use the same version.
- **Dependency build scripts blocked by default** (pnpm 10 behaviour). Only packages listed in `onlyBuiltDependencies` may run install scripts. The list starts with native modules proven to need it (e.g. `argon2`). Every addition is reviewed in the PR, with a one-line reason.
- **`minimumReleaseAge: 10080`** (7 days): newly published versions are not resolvable for a week. An urgent security fix may be admitted early with a scoped `minimumReleaseAgeExclude` entry, and the PR must say so and be reviewed by security-reviewer.
- **Trust policy `no-downgrade`:** resolution fails if a package's publishing trust evidence (e.g. provenance or trusted publisher) is weaker than for earlier versions.
- **Installs are reproducible:** `pnpm install --frozen-lockfile` everywhere in CI and in Docker builds. The deploy job runs no install; it deploys the image already built.
- **Workflow hardening (with the above):**
  - every workflow starts with `permissions: {}` and grants per job
  - actions are pinned by full SHA
  - no `pull_request_target`, and no `workflow_run` that checks out PR code
  - deploy only from the `production` environment on `main`
- Dependabot (npm, Actions, Docker) stays weekly and grouped, with no automerge. Its PRs are subject to the same release-age delay.

## Alternatives considered
- **npm or Yarn:** neither has an equivalent built-in default block on build scripts plus a release-age gate; we would rely on `--ignore-scripts` discipline.
- **A 3-day release age (F-16 minimum):** weaker; 7 days costs little for an MVP and matches the owner's decision.
- **Running installs with all scripts disabled (`--ignore-scripts`):** breaks `argon2`; the allowlist is more precise.

## Consequences
- New dependencies can be up to 7 days behind upstream. The occasional urgent bump needs the documented exclusion.
- ci-engineer owns `pnpm-workspace.yaml`/`.npmrc` settings and the CI checks that they are present. security-reviewer reviews any `onlyBuiltDependencies` or exclusion change.
- Contributors need Corepack enabled, with Node 24 (ADR-0001).

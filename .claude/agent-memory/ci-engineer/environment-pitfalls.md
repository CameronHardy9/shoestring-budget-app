---
name: environment-pitfalls
description: Owner's Mac and tool-image quirks that break naive CI/Makefile scripts (bash 3.2, make 3.81, corepack shim, Playwright image Node, denied rm -rf)
metadata:
  type: project
---
Facts verified 2026-11-12 that shaped the pipeline scripts:

- macOS ships GNU Make 3.81 (no .SHELLFLAGS/.ONESHELL) and /bin/bash 3.2: empty arrays under `set -u` error, so use `${arr[@]+"${arr[@]}"}`. Keep logic in .github/scripts/*.sh, not the Makefile.
- The Bash tool runs zsh; `source lib.sh` there breaks on BASH_SOURCE. Wrap ad-hoc calls in `bash -c`.
- nvm default is Node 20; every Bash call needs `source ~/.nvm/nvm.sh && nvm use 24`. The global `pnpm` is a corepack shim from Node 20, so `packageManager` picks the version (any version works, no owner install needed).
- The Playwright image (mcr.microsoft.com/playwright v1.65) ships Node 26 and no corepack. Run pnpm via `npm exec --package=pnpm@<pin> -- pnpm`.
- `--network host` from a container reaches the Mac's localhost on OrbStack, so the visual suite uses the same origin as the host.
- pnpm `minimumReleaseAge: 10080` refuses versions under 7 days old. Pick older versions, or pass `--config.minimumReleaseAge=0` only in scratch experiments.
- Settings deny `rm -rf`. Use `docker volume rm` and `pnpm install --force` instead.
- Semgrep `pattern: $X as T` also matches `<T>x`; the pattern `<T>$X` itself fails to parse.
- Other agents edit in parallel (sre in infra/ and docs/runbooks/, security in docs/security/). Read their docs for asks aimed at ci-engineer (mvp-security-checklist C1.1, C8.2, C13.x, C15.x; deploy.md wants a GHCR image and deploy.yml).

**Why:** each of these cost a failed run once.
**How to apply:** check this list before writing shell or compose changes; see [[pipeline-timings]].

---
name: environment-pitfalls
description: Owner's Mac and tool-image quirks that break naive CI/Makefile scripts (bash 3.2, make 3.81, corepack shim, Playwright image Node, denied rm -rf), compose and pnpm traps, e2e edge proxy client-IP topology
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
- Settings deny Read(./.env), and that blocks ls/awk on it too. Verify generated credentials by behavior: `docker exec <pg> printenv` piped into a login, never printed.
- Compose interpolates the WHOLE file (all profiles, also for `down`/`logs`), so `${VAR:?}` breaks dev-down without .env. dev-ctl.sh stubs unset vars with random values for those commands.
- A `${VAR:?msg}` message containing ": " makes the YAML plain scalar invalid. Use commas.
- The postgres image trusts 127.0.0.1 inside its own container, so a wrong password "works" there. Test auth from a sibling container on the compose network.
- jq `@base64d` decodes to UTF-8 text, so lengths are wrong for random bytes. Use Node's Buffer.
- shellcheck SC2155 flags `export X="$(cmd)"`, and `export "$v=$(cmd)"` masks failures without being flagged. Assign first, then export.
- Other agents edit in parallel (sre in infra/ and docs/runbooks/, security in docs/security/, architect in docs/contracts/ even mid-task: APP_KEYRING replaced two env vars during one run, so re-grep contracts before reporting). Read their docs for asks aimed at ci-engineer (mvp-security-checklist C1.1, C8.2, C13.x, C15.x; deploy.md wants a GHCR image and deploy.yml).

- Compose `VAR: ${VAR:-}` passes an EMPTY string, not unset. Apps that check `!== undefined` (db's seed with SEED_USER_PASSWORD) then reject it; the migrate command unsets empty values first.
- Test compose changes in an isolated project: `docker compose --env-file /dev/null -p <name>` with exported stub creds, then `docker volume rm <name>_pgdata`. Never `down -v`: it also deletes the fixed-name shared node_modules volumes.
- Claude Code's safety check blocks any `bash -c '...rm...'` script. Truncate scratch files with `: >file` instead.
- Semgrep path globs with a leading `/` are anchored to the scan root; `pattern-not-inside: function f(...) {...}` also matches `export (async) function`. Test rules on fixtures in the scratchpad mounted as /src.

- Semgrep's built-in .semgrepignore skips every `tests/` dir (also with --verbose: "Skipped by .semgrepignore"). Explicit file targets bypass it, so audit.sh passes tests/ files by name (2026-11-13).
- Parallel `make check`: since 2026-11-14 make test uses project `shoestring-test-$$` and host port 0 (read back with `compose port`), so Postgres no longer collides. Coverage collisions fixed 2026-11-16: test.sh passes a relative `--coverage.reportsDirectory=coverage/make-test-$$` (one per package and run; Vitest wipes reportsDirectory at start and keeps raw data in its .tmp). db's wall-clock perf test (300 ms) still fails when two runs overlap on a loaded Mac.
- Postgres healthcheck must use TCP (`pg_isready -h 127.0.0.1`): the image's init server is socket-only (listen_addresses=''), so a socket check went healthy early and migrate got ECONNREFUSED.

- pnpm filter `"./backend..."` selects backend ALONE (no workspace deps); use `"{./backend}..."`. In the image build db/ then had no node_modules and rolldown silently externalized kysely/pg (UNRESOLVED_IMPORT warning only), so the image crashed at start. Only a real run of the image caught it (2026-11-14).
- `pnpm deploy --legacy --offline` fails on workspace deps (re-resolves them, ERR_PNPM_NO_OFFLINE_META). Use `--config.inject-workspace-packages=true` on the deploy command only (lockfile-pinned, dev symlinks untouched). Deploy copies the whole package (src/ incl. test-hooks.ts), so the Dockerfile keeps an allowlist.
- Distroless has no shell/grep: scan image files with `docker run --entrypoint /nodejs/bin/node <img> -e '<script>'`. Admin CLI has no --help (exit 2 usage_error).

- In the zsh Bash tool, `set -- $v` does NOT word-split; a measurement loop silently ran one variant. Put loops in a bash script file (2026-11-16).
- pnpm forwards args after the script name (`pnpm -r run test --maxWorkers=2`); adding `--` would reach Vitest as a file filter.

**Why:** each of these cost a failed run once.
**How to apply:** check this list before writing shell or compose changes; see [[pipeline-timings]].

- e2e client IP (2026-11-16): backend/frontend publish NO host ports in docker-compose.test.yml; the `edge` service (.github/scripts/e2e-edge.mjs) publishes BACKEND_PORT and FRONTEND_PORT and appends the TCP peer (or `X-E2E-Client-IP`) to X-Forwarded-For; backend TRUST_PROXY_HOPS=1. Vite's /api proxy has no xfwd, so it is transparent. If frontend ever sets `xfwd: true`, the browser path derives the edge's IP. Observed peer on OrbStack: the compose network gateway (192.168.97.1 that run); verify with a failed login, then `security_events.ip` via psql in the postgres container.
- Content-hash dirty tags change on every edit other agents make, so make image-smoke often rebuilds the image right after make image when agents work in parallel. Expected, not a bug.
- The e2e backend runs `node --watch` through the bind mount, so another agent editing backend/ mid-run restarts it: the edge logs `ECONNREFUSED` and the suites get 502 "edge: upstream unavailable" (9 failures in one run, 2026-11-16). Check `docker logs <backend> | grep Restarting` before blaming a change. CI is unaffected (nobody edits files there).
- Edge upstream stays `agent: false` (2026-11-16). A keep-alive agent cut ~0.3 ms/request but no measurable suite time (API phase 168 s both), and caused EPIPE -> 502 on the >64 KiB 413 tests (backend closes without reading the body; on a reused socket the write fails before the 413 is read). Suite time swings 168-215 s with machine load alone; A/B on one stack with the backend un-watched (scratch compose override: `pnpm --filter ./backend exec node src/dev-server.ts`).
- CodeQL locally (2026-11-16, free): `gh release download codeql-bundle-v<CI version> -R github/codeql-action -p codeql-bundle-javascript-linux64.tar.zst` (136 MB; macOS tar extracts zstd), run it in `debian:trixie-slim --platform linux/amd64` with `database create --build-mode=none --source-root=<dir>` and `database analyze ... javascript-security-extended.qls`. One file takes about 1 min. It reproduced alert #6 exactly. CodeQL treats an http client response (`ures`) as user input, and it counted `writeHead`'s status argument as a header-name sink. Fix: keep headers in flat raw arrays, check names against the token regex, set `res.statusCode` and call `appendHeader`.
- Keep-alive race (2026-11-16): a Node 24 server with the default `keepAliveTimeout` of 5 s advertises `timeout=5` but actually closes at about 6 s (`keepAliveTimeoutBuffer` 1 s). A Node `http.Agent({keepAlive:true})` IGNORES that hint unless the agent sets `timeout` (free socket `timeout` stays 0), so a client idle for about 6 s reuses a dying socket and gets `socket hang up` (ECONNRESET, reusedSocket=true). The edge now uses 65 s. Clients should set `timeout` below the server's value. `http.globalAgent` already has timeout 5000. Fastify's backend keeps 72 s. Vite answers proxied /api with Connection: close.
- Sentry (2026-11-16):
  - zizmor's default persona hides `secrets-outside-env`, a medium finding (it showed as "1 suppressed"). Run `--persona pedantic` on workflow changes. Secrets go in a GitHub environment (`sentry`, main only) on their own job.
  - sentry-cli 3.8 `sourcemaps upload --release R --url-prefix '~/'` pairs Vite "hidden" maps with `<file>.js.map` siblings, so no sourceMappingURL comment is needed. A dry run against a mock API showed "sourcemap at X.js.map".
  - Never pass maps between jobs as a GitHub artifact: artifacts are public on a public repo.
  - Since 2026-11-17 the backend bundles @sentry/node into a lazy `dist/chunks/esm-*.js` (a devDependency), so the image is back to 74 MB gzip with no Sentry, oxc or OpenTelemetry package in node_modules. image-smoke starts the app a second time with SENTRY_DSN to prove that chunk loads.
  - No DSN validator in our code requires 32 hex or sentry.io: the backend's `sentryEndpoints` wants https, a user and a numeric project; @sentry/core `makeDsn` accepts any `\w+` key and host. `E2E_SENTRY_DSN` is a 32-hex key at o0.ingest.sentry.test/1.
  - Image tags do NOT include build args. A DSN build and a no-DSN build of the same tree share a tag, and make image-smoke reuses whichever exists.
  - Earlier state: @sentry/node 11.10.0 pulled in @sentry/bundler-plugins: the `sentry` CLI package (15 MB), oxc-parser with a native binding, and glob 13.0.7 (osv medium). That raised the image from 325 to 419 MB uncompressed (73 to 87 MB gzip).
- osv-scanner 2.7 ignores (2026-11-17): `.github/osv-scanner.toml` is passed with `--config`. `ignoreUntil` is deprecated, so use `effectiveUntil` (it gives a stderr warning otherwise). An `id` of the GHSA also filters its CVE alias. After the date, the advisory is reported again (tested with a past date). The stderr line "has unused ignores" marks stale entries, and audit.sh shows it in the summary.
- Dependabot security updates and vulnerability alerts are OFF on the repo (2026-11-17: `automated-security-fixes` enabled:false, `vulnerability-alerts` 404). Version updates only bump direct deps, so a transitive fix (for example picomatch) needs the owner to turn those on, or a manual `pnpm update -r <pkg>`.

- Migrate image (2026-11-17):
  - The Dockerfile's LAST stage is the default target, so image.sh passes `--target runtime`. Keep runtime last anyway.
  - node-pg (pg-connection-string 2.14) reads `sslrootcert=system` as a FILE path (ENOENT). dbmate (Go) accepts it. The migrate CLI uses both, so MIGRATOR_DATABASE_URL must be plain `?sslmode=verify-full` (Go and Node then use the system/bundled roots).
  - `pnpm install --frozen-lockfile --offline --filter ./db` works with only db/ copied into the build stage (other importers absent).
  - Third-party packages ship `testing` dirs (pg-protocol/src/testing): name scans for our seed/testing code must skip node_modules.
  - GHCR image paths must be lowercase; the repo slug has capitals (use `tr A-Z a-z`, bash 3.2 has no `${,,}`).
  - `CMD []` after ENTRYPOINT inspects as `null`; ENTRYPOINT alone already clears the base CMD.
  - `--user 0:0 --cap-drop ALL` cannot read the distroless nonroot user's 0700 /home/nonroot (root without DAC caps). Root scans in image-smoke use SCAN_HARDEN = HARDEN + `--cap-add DAC_READ_SEARCH` only (security Info item, 2026-11-17).

- Image publishing (2026-11-17):
  - GHCR package visibility: GitHub's docs contradict each other (Actions page: a GITHUB_TOKEN-created package inherits the repo's visibility; access-control page: a personal-account package starts private, inherits access "but not the visibility"). No REST API changes visibility; only the package settings page. Anonymous `https://ghcr.io/token?scope=repository:<path>:pull&service=ghcr.io` answers 403 for private AND nonexistent packages, 200 for public.
  - Image ID differs by store: OrbStack (containerd snapshotter) `.Id` = manifest digest = pushed digest; GitHub runners (Docker 28, classic store) `.Id` = config digest, pushed digest differs. `docker pull <name>@<digest>` then `.Id` == tested ID holds in both (tested in docker:28-dind). `--provenance=false --sbom=false` keeps a single image manifest (no index) in either store.
  - .dockerignore excludes deploy/, so the backup image builds with context deploy/backup (`-f Dockerfile.backup`).
  - Editing ci.yml with a Python slice `s[:start] + new` silently dropped every job after the anchor (sourcemaps); actionlint and zizmor stay green. After any scripted workflow edit, diff the job list against HEAD. Python non-raw strings also eat `\`+newline in embedded shell.
- First main publish run (2026-11-17): image-save.sh assumed `$RUNNER_TEMP/images/` existed (local simulation had it); now mkdir -p. The Ubuntu mirror (us-east-2.ec2.archive.ubuntu.com) served `playwright install --with-deps` at 150 kB/s: 125 MB, 186 .debs, 14 min, so throughput not stalls (apt retries alone do not help). Fix: check job sets SKIP_BROWSERS=1; e2e caches the .debs via apt `Dir::Cache::Archives` in ~/.cache/playwright-apt (setup.sh). A non-root-owned apt archive dir under a 750 home makes apt warn "Download is performed unsandboxed as root" (harmless). apt-get autoclean then chown so actions/cache can read apt's root-owned lock file. apt 2.7 trusts a .deb already in the archive dir by SIZE only (no hash; F-69, reproduced with a same-size tampered file), so ci_apt_cache verifies each cached .deb's SHA256 against `apt-cache show pkg:arch=ver` after apt-get update and deletes mismatches. `pkg:all=ver` lookups work.

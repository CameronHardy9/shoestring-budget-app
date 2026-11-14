# Production image: one same-origin container. Fastify (backend/) serves the API
# at /api and the built SPA (frontend/) at /. Build once per commit and deploy the
# same image to every environment (sre). Build with `make image`.
#
# Expectations on the area packages (see the ci-engineer report):
#   frontend: `build` script writes the SPA to frontend/dist (hidden source maps OK)
#   backend:  `build` script writes backend/dist with dist/server.js and dist/admin.js,
#             serves STATIC_DIR at /, and listens on HOST:PORT
#   The test-hooks module must not be in backend/dist (checked below). It exports
#   the sentinel string __SHOESTRING_TEST_HOOKS__ so the check can see it.

# ---- base: Node + the pnpm version pinned in package.json ---------------------
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS base
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install

# ---- fetch: download every package in the lockfile (cached layer) -------------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ---- build: install offline, build frontend and backend, prune to prod deps ----
FROM fetch AS build
COPY . .
# "{dir}..." = the package in dir plus its workspace dependencies (db/). The
# braces matter: "./backend..." selects backend alone, db/ gets no node_modules,
# and the bundler then leaves kysely and pg as unresolved externals.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "{./backend}..." --filter "{./frontend}..."
ARG APP_RELEASE=dev
ENV APP_RELEASE=$APP_RELEASE \
    VITE_APP_RELEASE=$APP_RELEASE
# Until frontend/ exists the image is API-only (no SPA): fine for the smoke job,
# not a releasable artifact (make image says so).
RUN if [ -f frontend/package.json ]; then pnpm --filter ./frontend run build; \
    else echo "note: no frontend/package.json, building an API-only image" >&2; fi \
 && pnpm --filter ./backend run build
# docs/contracts/test-hooks.md: the production build must not contain test hooks.
# Fails on `_test` as a whole word, however the route is assembled ('/api/_test/x',
# prefix '/api/_test', "/api/" + "_test"), and on the sentinel string the hooks
# module exports. Whole-word matching (-w) ignores identifiers such as is_test,
# _tests or TEST_HOOKS, so normal code does not trip it (security F-10).
# The entries must exist first: grep over a missing or empty dist would pass.
# grep exits 0 on a match, 1 on none and 2 on an error; only 1 passes.
RUN for f in server.js admin.js; do \
      [ -s "backend/dist/$f" ] || { echo "error: backend build did not produce dist/$f" >&2; exit 1; }; \
    done; \
    rc=0; grep -rIlw --include='*.js' --include='*.mjs' --include='*.cjs' \
         -e '_test' -e '__SHOESTRING_TEST_HOOKS__' backend/dist || rc=$?; \
    if [ "$rc" -eq 0 ]; then echo "error: test-hook code found in backend/dist (files above)" >&2; exit 1; fi; \
    if [ "$rc" -ne 1 ]; then echo "error: test-hook tripwire could not scan backend/dist (grep exit $rc)" >&2; exit 1; fi
# Standalone backend with production dependencies only, from the lockfile.
# Legacy deploy re-resolves workspace packages' dependencies (and fails offline),
# so inject workspace packages for this one command only; the workspace itself
# keeps symlinked packages for hot reload in dev.
# pnpm deploy copies the whole package (src/ incl. the test-hooks module,
# scripts/, configs). Keep only what runs: no test-hook source in the image
# (test-hooks.md, ADR-0009); make image-smoke asserts this allowlist.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter ./backend deploy --prod --offline --config.inject-workspace-packages=true /deploy \
 && mkdir /out \
 && mv /deploy/package.json /deploy/dist /deploy/node_modules /out/
# Public SPA without source maps; the maps go to the `sourcemaps` stage for a
# private upload to Sentry, never to users.
RUN mkdir -p /public /sourcemaps \
 && if [ -d frontend/dist ]; then cp -R frontend/dist/. /public/; fi \
 && (cd /public && find . -name '*.map' -exec sh -c 'mkdir -p "/sourcemaps/$(dirname "$1")" && mv "$1" "/sourcemaps/$1"' _ {} \;)

# ---- sourcemaps: `docker build --target sourcemaps --output type=local,dest=.sourcemaps .`
FROM scratch AS sourcemaps
COPY --from=build /sourcemaps/ /

# ---- runtime: distroless, non-root, no shell or package manager ---------------
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a AS runtime
# Create /app as root so the app user cannot write to its own code.
USER root
WORKDIR /app
ARG APP_RELEASE=dev
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/public \
    APP_RELEASE=$APP_RELEASE \
    NODE_OPTIONS=--enable-source-maps
# Files stay owned by root and read-only to the app user.
COPY --from=build /out /app
COPY --from=build /public /app/public
LABEL org.opencontainers.image.title="shoestring" \
      org.opencontainers.image.source="https://github.com/CameronHardy9/shoestring-budget-app" \
      org.opencontainers.image.revision=$APP_RELEASE
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The distroless entrypoint is node. Admin commands run in the same image:
#   docker run --rm --env-file <prod env> <image> dist/admin.js <command> [flags]
CMD ["dist/server.js"]

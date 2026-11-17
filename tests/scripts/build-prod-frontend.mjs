// Builds the PRODUCTION frontend bundle into tests/.prod-build (gitignored by
// tests/.gitignore) for the suites that
// need what users actually get: the CSP violation gate (C3.1), the Sentry
// no-PII checks (F-06, F-07, F-50) and the visual baselines (ADR-0009: "visual
// baselines use production frontend builds").
// It runs the frontend's own `vite build` with a different outDir only; it
// writes nothing under frontend/.
//
// VITE_SENTRY_DSN is the stack's fake DSN (E2E_SENTRY_DSN, a reserved .test
// host that never resolves), read the way support/env.ts reads the stack:
// the exported environment under `make e2e`, tests/.env.stack after
// `make e2e-up`. The browser tests intercept that host. Anything but a .test
// DSN is refused (env-guards.ts), so an e2e bundle can never report to a real
// Sentry project. With no stack at all the bundle is built without Sentry.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSentryDsn, stackSource } from "../support/env-guards.ts";

const raw = stackSource().E2E_SENTRY_DSN;
const sentryDsn = raw ? fakeSentryDsn(raw).dsn : "";

const out = fileURLToPath(new URL("../.prod-build/", import.meta.url));
const started = Date.now();
execFileSync(
  "pnpm",
  ["--filter", "./frontend", "exec", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"],
  {
    stdio: "inherit",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, VITE_APP_RELEASE: "e2e", VITE_SENTRY_DSN: sentryDsn },
  },
);
process.stdout.write(
  `production frontend built into tests/.prod-build in ${Date.now() - started} ms ` +
    `(error tracking: ${sentryDsn ? new URL(sentryDsn).host : "off, no E2E_SENTRY_DSN"})\n`,
);

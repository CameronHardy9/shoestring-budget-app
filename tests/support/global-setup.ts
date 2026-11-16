// Once per run: fail fast, with a message that names the cause, when the
// suites are started without a usable stack.
import { databaseAdminUrl, databaseUrl } from "./db-env.ts";
import { env } from "./env.ts";
import { hooksAvailable } from "./hooks.ts";

export default async function globalSetup(): Promise<void> {
  // F-56: refuse a non-local database before any test runs (env.ts has
  // already refused non-loopback origins on import).
  databaseUrl();
  databaseAdminUrl();
  let probe;
  try {
    probe = await hooksAvailable();
  } catch (e) {
    throw new Error(
      `Cannot reach the backend at ${env.apiUrl} (${(e as Error).message}). ` +
        "Run through `make e2e`, or start a local stack: make e2e-up",
      { cause: e },
    );
  }
  if (probe.status !== 204)
    throw new Error(
      `POST /api/_test/reset answered ${probe.status}: the test hooks are not registered. ` +
        "The e2e stack must run the backend's dev entry with TEST_HOOKS=1, NODE_ENV=test, " +
        "EMAIL_TRANSPORT=test, DATABASE_ADMIN_URL and a localhost APP_ORIGIN (test-hooks.md, ADR-0009).",
    );
}

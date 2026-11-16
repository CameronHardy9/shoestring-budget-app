// The database URLs for the factories (dal.ts) and the superuser helpers
// (db-locks.ts), refused unless they point at a LOCAL database (F-56): the
// suites insert synthetic users and budgets and take table locks, which must
// never happen to a shared or production database. Uses the data layer's own
// parser (`parseDatabaseUrl`, F-42), so `?host=` and other tricks cannot
// bypass the check. Lazy: nothing is read until a suite needs the database,
// and env.ts stays free of database packages (the Playwright container has
// none).
import { DatabaseUrlError, parseDatabaseUrl } from "@shoestring/db";
import { StackEnvError, stackSource } from "./env-guards.ts";

/**
 * `value` if it is a postgres URL on localhost, 127.0.0.1, ::1 or the compose
 * host `postgres`; otherwise a StackEnvError naming `name`, never the URL
 * (it carries a password).
 */
export function localDatabaseUrl(
  name: string,
  value: string | undefined,
): string {
  if (!value)
    throw new StackEnvError(
      `${name} is not set. Run the suites through \`make e2e\`, or start a local stack first: make e2e-up`,
    );
  let local: boolean;
  try {
    local = parseDatabaseUrl(name, value).local;
  } catch (e) {
    // DatabaseUrlError messages name only the variable; anything else from
    // the driver's parser might quote the URL, so it is not passed on.
    throw new StackEnvError(
      e instanceof DatabaseUrlError
        ? e.message
        : `${name} could not be parsed as a postgres URL`,
    );
  }
  if (!local)
    throw new StackEnvError(
      `${name} must point at a local database (localhost, 127.0.0.1, ::1 or the compose host "postgres"): ` +
        "the suites write synthetic data and take table locks, so they refuse any other host",
    );
  return value;
}

let memo: { app: string; admin: string } | null = null;
function urls(): { app: string; admin: string } {
  const source = stackSource();
  memo ??= {
    app: localDatabaseUrl("DATABASE_URL", source.DATABASE_URL),
    admin: localDatabaseUrl("DATABASE_ADMIN_URL", source.DATABASE_ADMIN_URL),
  };
  return memo;
}

/** `app` role: the DAL used by the factories. */
export const databaseUrl = (): string => urls().app;
/** Superuser, local/test only: seeding states the API refuses to build (auth.md §9 test 2), table locks. */
export const databaseAdminUrl = (): string => urls().admin;

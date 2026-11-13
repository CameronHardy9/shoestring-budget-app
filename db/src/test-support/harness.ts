// Per-test-file database: a clone of the migrated test database, a Dal on the
// `app` role with a manual clock, and raw pools for invariant tests.
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { manualClock } from "../clock.ts";
import type { ManualClock } from "../clock.ts";
import { createDal } from "../dal.ts";
import type { Dal } from "../dal.ts";
import { createDatabaseClone } from "../testing/index.ts";

export const START = "2026-11-13T15:00:00.000Z";

export interface TestDb {
  dal: Dal;
  clock: ManualClock;
  /** Raw SQL as `app` (the backend's role). */
  app: pg.Pool;
  /** Raw SQL as the superuser (setup and inspection only). */
  admin: pg.Pool;
  /** `app` URL of the clone. */
  appUrl: string;
  /** `migrator` URL of the clone. */
  migratorUrl: string;
  /** Superuser URL of the clone. */
  adminUrl: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Registers beforeAll/afterAll hooks and returns a handle filled in beforeAll. */
export function useTestDb(): TestDb {
  const handle = {} as TestDb;
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const clone = await createDatabaseClone(env("DATABASE_ADMIN_URL"));
    dispose = () => clone.dispose();
    const clock = manualClock(START);
    handle.clock = clock;
    handle.appUrl = clone.urlFor(env("DATABASE_URL"));
    handle.migratorUrl = clone.urlFor(env("MIGRATOR_DATABASE_URL"));
    handle.adminUrl = clone.urlFor(env("DATABASE_ADMIN_URL"));
    handle.dal = createDal({
      connectionString: handle.appUrl,
      clock: clock.clock,
    });
    handle.app = new pg.Pool({ connectionString: handle.appUrl, max: 3 });
    handle.admin = new pg.Pool({ connectionString: handle.adminUrl, max: 2 });
  });
  afterAll(async () => {
    await handle.dal.close();
    await handle.app.end();
    await handle.admin.end();
    await dispose?.();
  });
  return handle;
}

// @shoestring/db/testing: LOCAL AND TEST ONLY. Never import from production
// entry points (backend/src/server.ts, admin.ts). Used by the backend's dev
// test hooks (POST /api/_test/reset) and by tests/ (test-engineer).
// Every function needs the superuser URL (DATABASE_ADMIN_URL) and refuses
// hosts other than localhost or the compose service.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { assertLocalDatabaseUrl } from "../conn.ts";

function assertLocal(url: string): URL {
  // Shared F-42 check: driver-parsed host, no host/hostaddr parameters.
  assertLocalDatabaseUrl("DATABASE_ADMIN_URL", url);
  return new URL(url);
}

async function withClient<T>(
  url: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({
    connectionString: url,
    application_name: "shoestring-testing",
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Empties every application table (keeps the schema and schema_migrations).
 * One TRUNCATE; needs the superuser URL because `app` may not TRUNCATE.
 */
export async function resetDatabase(adminUrl: string): Promise<void> {
  assertLocal(adminUrl);
  await withClient(adminUrl, async (c) => {
    const res = await c.query<{ name: string }>(
      `select format('%I.%I', schemaname, tablename) as name
         from pg_tables
        where schemaname = 'public' and tablename <> 'schema_migrations'
        order by tablename`,
    );
    if (res.rows.length === 0) return;
    // Identifiers come from the catalog, quoted by format(%I).
    await c.query(
      `truncate table ${res.rows.map((r) => r.name).join(", ")} restart identity cascade`,
    );
  });
}

export interface DatabaseClone {
  /** The clone's name (t_<random hex>). */
  name: string;
  /** `url` with the database name replaced by the clone's. */
  urlFor(url: string): string;
  /** Removes the clone, terminating its connections. */
  dispose(): Promise<void>;
}

/**
 * Creates an isolated copy of the migrated database (CREATE DATABASE ...
 * TEMPLATE) in about 100 ms. Use one per test file or worker, then dispose of
 * it. The template is the database named in `adminUrl`; nothing else may be
 * connected to it while cloning, so connect test code only to clones.
 */
export async function createDatabaseClone(
  adminUrl: string,
): Promise<DatabaseClone> {
  const admin = assertLocal(adminUrl);
  const template = decodeURIComponent(admin.pathname.slice(1));
  const name = `t_${randomBytes(6).toString("hex")}`;
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/postgres";
  await withClient(maintenance.toString(), async (c) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await c.query(
          `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(template)}`,
        );
        return;
      } catch (e) {
        // 55006: the template is briefly in use (another clone starting). Retry.
        if ((e as { code?: string }).code !== "55006" || attempt >= 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  // CREATE DATABASE does not copy the template's database ACL; apply the
  // same database-level rules as roles.sql (F-44: no TEMPORARY for PUBLIC).
  const cloneAdmin = new URL(adminUrl);
  cloneAdmin.pathname = `/${name}`;
  await withClient(cloneAdmin.toString(), async (c) => {
    const db = pg.escapeIdentifier(name);
    await c.query(`revoke all on database ${db} from public`);
    await c.query(`grant connect, create on database ${db} to migrator`);
    await c.query(`grant connect on database ${db} to app, backup`);
  });
  return {
    name,
    urlFor(url: string) {
      const u = new URL(url);
      u.pathname = `/${name}`;
      return u.toString();
    },
    async dispose() {
      await withClient(maintenance.toString(), async (c) => {
        await c.query(
          `drop database if exists ${pg.escapeIdentifier(name)} with (force)`,
        );
      });
    },
  };
}

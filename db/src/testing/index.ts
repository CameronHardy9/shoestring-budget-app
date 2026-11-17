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

// resetDatabase retries: deadlock, lock_timeout, and statement_timeout (the
// lock phase's own cap; nothing else in the reset sets one).
const RESET_RETRY_CODES = new Set(["40P01", "55P03", "57014"]);
const RESET_ATTEMPTS = 25;

/**
 * Empties every application table (keeps the schema and schema_migrations).
 * Needs the superuser URL because `app` may not TRUNCATE.
 *
 * Deadlock-free against concurrent readers (the backend's readyz
 * healthcheck, a straggling request): TRUNCATE takes AccessExclusive locks
 * one table at a time, and a reader can hold one of them while waiting for
 * another (readyz: totp_credentials, then recovery_codes; the reset in name
 * order takes recovery_codes first). No single lock order matches every
 * reader, so the reset is the side that always backs off: in one transaction
 * it first takes every table lock with one LOCK TABLE, capped at a third of
 * deadlock_timeout. A cycle therefore ends in the reset's timeout before any
 * backend runs the deadlock detector, so readers never see 40P01; they wait
 * at most that cap. The reset rolls back (releasing everything) and retries
 * with jittered backoff, a bounded number of times. Once every table lock is
 * held, the TRUNCATE needs no table lock a reader could hold.
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
    const tables = res.rows.map((r) => r.name).join(", ");
    const dt = await c.query<{ ms: number }>(
      "select setting::int as ms from pg_settings where name = 'deadlock_timeout'",
    );
    const lockMs = Math.max(
      10,
      Math.min(300, Math.floor((dt.rows[0]?.ms ?? 1000) / 3)),
    );
    for (let attempt = 1; ; attempt++) {
      try {
        await c.query("begin");
        // statement_timeout caps the whole LOCK statement (lock_timeout is
        // per wait, and waits on several tables could add up past the
        // detector); lock_timeout also covers any lock the TRUNCATE still
        // needs (indexes, owned sequences), so no wait of ours ever reaches
        // deadlock_timeout.
        await c.query(
          "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
          [`${lockMs}ms`],
        );
        await c.query(`lock table ${tables} in access exclusive mode`);
        await c.query("set local statement_timeout = 0");
        await c.query(`truncate table ${tables} restart identity cascade`);
        await c.query("commit");
        return;
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        const code = (e as { code?: string }).code;
        if (
          code === undefined ||
          !RESET_RETRY_CODES.has(code) ||
          attempt >= RESET_ATTEMPTS
        )
          throw e;
        const backoff = Math.min(200, 10 * 2 ** attempt);
        await new Promise((r) =>
          setTimeout(r, backoff / 2 + Math.random() * (backoff / 2)),
        );
      }
    }
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
        // pg's Pool.end() resolves before its connections have closed. Wait
        // (up to 2 s) for them, so FORCE only terminates real leftovers; a
        // terminated idle client surfaces as an unhandled pool 'error'.
        for (let i = 0; i < 100; i++) {
          const { rows } = await c.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname = $1",
            [name],
          );
          if ((rows[0]?.n ?? 0) === 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        await c.query(
          `drop database if exists ${pg.escapeIdentifier(name)} with (force)`,
        );
      });
    },
  };
}

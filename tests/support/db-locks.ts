// Deterministic concurrency: hold a table lock from a superuser connection so
// requests that reach it wait INSIDE the server, then release it. Used to put
// an MFA attempt "in flight" (F-45) without relying on timing. Never sleeps:
// waits by polling pg_stat_activity for the expected number of lock waiters.
import pg from "pg";
import { env } from "./env.ts";

export interface HeldLock {
  /** Resolves once at least `n` other sessions wait for a lock in this database. */
  waitForWaiters(n: number, timeoutMs?: number): Promise<void>;
  release(): Promise<void>;
}

/** Superuser one-off query (local/test database only). */
export async function adminQuery<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({
    connectionString: env.databaseAdminUrl,
    application_name: "shoestring-tests-admin",
  });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** `LOCK TABLE <table> IN EXCLUSIVE MODE`: reads go on, writes to the table wait. */
export async function holdExclusiveLock(
  table: "auth_throttles" | "sessions" | "user_tokens",
): Promise<HeldLock> {
  const holder = new pg.Client({
    connectionString: env.databaseAdminUrl,
    application_name: "shoestring-tests-lock",
  });
  await holder.connect();
  await holder.query("begin");
  await holder.query(
    `lock table ${holder.escapeIdentifier(table)} in exclusive mode`,
  );
  return {
    async waitForWaiters(n, timeoutMs = 10_000) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const { rows } = await holder.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
        );
        if ((rows[0]?.n ?? 0) >= n) return;
        if (performance.now() > deadline)
          throw new Error(
            `fewer than ${n} requests waited on the ${table} lock within ${timeoutMs} ms`,
          );
        await new Promise<void>((r) => setImmediate(r));
      }
    },
    async release() {
      await holder.query("rollback");
      await holder.end();
    },
  };
}

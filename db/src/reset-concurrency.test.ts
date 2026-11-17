// resetDatabase (POST /api/_test/reset) against concurrent readers such as
// the backend's readyz healthcheck. The e2e reset used to fail about 1 run in
// 8 with 40P01: readyz's listKeyIdsInUse is one statement that takes
// AccessShare on totp_credentials, then recovery_codes (parse order), while
// the reset's TRUNCATE takes AccessExclusive in table-name order
// (recovery_codes first). Each side then waits for the other.
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./testing/index.ts";
import { newBudget, newUser } from "./test-support/fixtures.ts";
import { useTestDb } from "./test-support/harness.ts";

const t = useTestDb();
const clients: pg.Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.end()));
});

async function appClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: t.appUrl });
  await c.connect();
  clients.push(c);
  return c;
}

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** Locks the reset's session holds or waits for on the two MFA tables. */
async function resetLocks(): Promise<{ relname: string; granted: boolean }[]> {
  const r = await t.admin.query<{ relname: string; granted: boolean }>(
    `select c.relname, l.granted
       from pg_locks l
       join pg_class c on c.oid = l.relation
       join pg_stat_activity a on a.pid = l.pid
      where a.datname = current_database()
        and a.application_name = 'shoestring-testing'
        and l.mode = 'AccessExclusiveLock'
        and c.relname in ('recovery_codes', 'totp_credentials')
      order by c.relname`,
  );
  return r.rows;
}

async function waitingOnLock(pid: number): Promise<boolean> {
  const r = await t.admin.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
    [pid],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

async function until(
  cond: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return false;
}

async function appTableCounts(): Promise<Record<string, number>> {
  const tables = await t.admin.query<{ name: string }>(
    `select tablename as name from pg_tables
      where schemaname = 'public' and tablename <> 'schema_migrations'
      order by tablename`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables.rows) {
    // Identifier from the catalog, quoted.
    const r = await t.admin.query<{ n: number }>(
      `select count(*)::int as n from ${pg.escapeIdentifier(name)}`,
    );
    counts[name] = r.rows[0]?.n ?? -1;
  }
  return counts;
}

describe("resetDatabase with concurrent readers", () => {
  it("survives the readyz lock-order inversion (forced) and leaves every table empty", async () => {
    let cycles = 0;
    // Repeat until the deadlock cycle has really formed at least 3 times (on
    // a slow machine the reset's short lock wait can end before the reader
    // queues); every round must end with a complete reset and no reader error.
    for (let round = 0; round < 20 && cycles < 3; round++) {
      const { userId } = await newUser(t.dal);
      await newBudget(t.dal, userId);

      // The state readyz's single statement is in between its two lock
      // acquisitions: AccessShare on totp_credentials held, recovery_codes next.
      const reader = await appClient();
      const pid = (
        await reader.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error("no pid");
      await reader.query("begin");
      await reader.query("select key_id from totp_credentials limit 0");

      const reset = settle(resetDatabase(t.adminUrl));
      // The reset holds recovery_codes and queues for totp_credentials.
      expect(
        await until(async () => {
          const l = await resetLocks();
          return (
            l.length === 2 &&
            l[0]?.relname === "recovery_codes" &&
            l[0].granted &&
            l[1]?.relname === "totp_credentials" &&
            !l[1].granted
          );
        }, 5_000),
      ).toBe(true);

      // The reader's second lock closes the cycle.
      const second = settle(
        reader.query("select key_id from recovery_codes limit 0"),
      );
      if (await until(() => waitingOnLock(pid), 100)) cycles++;

      expect(await second).toBeNull();
      await reader.query("commit");
      expect(await reset).toBeNull();
      const counts = await appTableCounts();
      expect(Object.values(counts).some((n) => n !== 0)).toBe(false);
    }
    expect(cycles).toBeGreaterThanOrEqual(3);
    expect(await t.dal.health.isSchemaCurrent()).toBe(true);
  });

  it("never fails a reset or a readyz read while both run in a loop", async () => {
    let stop = false;
    const readerErrors: unknown[] = [];
    let reads = 0;
    // readyz's three queries exactly as the backend runs them, 4 in parallel.
    const readers = Array.from({ length: 4 }, async () => {
      while (!stop) {
        try {
          await t.dal.health.ping();
          await t.dal.health.isSchemaCurrent();
          await t.dal.mfa.listKeyIdsInUse();
          reads++;
        } catch (e) {
          readerErrors.push(e);
        }
      }
    });
    const resetErrors: unknown[] = [];
    try {
      for (let i = 0; i < 40; i++) {
        const { userId } = await newUser(t.dal);
        await newBudget(t.dal, userId);
        const e = await settle(resetDatabase(t.adminUrl));
        if (e !== null) resetErrors.push(e);
      }
    } finally {
      stop = true;
      await Promise.all(readers);
    }
    expect(resetErrors).toEqual([]);
    expect(readerErrors).toEqual([]);
    expect(reads).toBeGreaterThan(40);
    const counts = await appTableCounts();
    expect(Object.values(counts).some((n) => n !== 0)).toBe(false);
  });
});

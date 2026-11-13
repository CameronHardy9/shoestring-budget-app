// Migrations apply to an EMPTY database (not a clone), roll back completely
// (tested down path), apply again, and leave the privilege model roles.sql
// verifies. Also checks what the `app` role must never be able to do.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_MIGRATION_VERSION } from "./migrations.ts";
import { expectPgError } from "./test-support/fixtures.ts";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = readdirSync(join(DB_DIR, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const name = `m_${randomBytes(6).toString("hex")}`;
const adminUrl = () => withDb(env("DATABASE_ADMIN_URL"), name);
const migratorUrl = () => withDb(env("MIGRATOR_DATABASE_URL"), name);
const appUrl = () => withDb(env("DATABASE_URL"), name);

async function admin(sql: string, db = "postgres"): Promise<void> {
  const c = new pg.Client({
    connectionString: withDb(env("DATABASE_ADMIN_URL"), db),
  });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

function migrateCli(): { status: number | null; output: string } {
  const r = spawnSync(
    process.execPath,
    [join(DB_DIR, "src", "cli", "migrate.ts")],
    {
      cwd: DB_DIR,
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: adminUrl(),
        MIGRATOR_DATABASE_URL: migratorUrl(),
        DATABASE_URL: appUrl(),
      },
      encoding: "utf8",
    },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function dbmate(...args: string[]): { status: number | null; output: string } {
  const require = createRequire(import.meta.url);
  const cli = join(
    dirname(require.resolve("dbmate/package.json")),
    "dist",
    "cli.js",
  );
  const url = new URL(migratorUrl());
  url.searchParams.set("sslmode", "disable");
  const r = spawnSync(
    process.execPath,
    [
      cli,
      "--env",
      "MIGRATOR_DATABASE_URL",
      "--migrations-dir",
      join(DB_DIR, "migrations"),
      "--no-dump-schema",
      ...args,
    ],
    {
      cwd: DB_DIR,
      env: { ...process.env, MIGRATOR_DATABASE_URL: url.toString() },
      encoding: "utf8",
    },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin(`create database ${pg.escapeIdentifier(name)}`);
});
afterAll(async () => {
  await admin(
    `drop database if exists ${pg.escapeIdentifier(name)} with (force)`,
  );
});

describe("migrations", () => {
  it("LATEST_MIGRATION_VERSION matches the newest migration file", () => {
    expect(MIGRATIONS.at(-1)?.slice(0, 14)).toBe(LATEST_MIGRATION_VERSION);
    for (const f of MIGRATIONS) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("apply to an empty database, roll back completely, and apply again", () => {
    const up = migrateCli();
    expect(up.output).toContain("migrate: done");
    expect(up.status).toBe(0);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const down = dbmate("rollback");
      expect(down.status).toBe(0);
    }
    expect(dbmate("status").output).toContain(`Pending: ${MIGRATIONS.length}`);
    const again = migrateCli();
    expect(again.status).toBe(0);
    expect(dbmate("status").output).toContain("Pending: 0");
    // Idempotent re-run (as in every deploy): nothing to apply, grants verified.
    expect(migrateCli().status).toBe(0);
  });

  it("refuses an admin URL that is not local", () => {
    const r = spawnSync(
      process.execPath,
      [join(DB_DIR, "src", "cli", "migrate.ts")],
      {
        cwd: DB_DIR,
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: "postgres://postgres:x@db.example.com/x",
          MIGRATOR_DATABASE_URL: migratorUrl(),
        },
        encoding: "utf8",
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_ADMIN_URL must point at a local");
    expect(r.stderr).not.toContain("postgres:x@");
  });
});

describe("app role privileges", () => {
  it("has DML only: no DDL, no TRUNCATE, no audit-log edits, no role changes", async () => {
    await expectPgError(query(appUrl(), "create table hack (i int)"), "42501");
    await expectPgError(
      query(appUrl(), "alter table users add column x int"),
      "42501",
    );
    await expectPgError(query(appUrl(), "drop table budgets"), "42501");
    await expectPgError(query(appUrl(), "truncate transactions"), "42501");
    await expectPgError(
      query(appUrl(), "delete from security_events"),
      "42501",
    );
    await expectPgError(
      query(appUrl(), "update security_events set ip = null"),
      "42501",
    );
    await expectPgError(
      query(
        appUrl(),
        "insert into schema_migrations values ('99999999999999')",
      ),
      "42501",
    );
    await expectPgError(query(appUrl(), "create role sneaky"), "42501");
    // F-44: PUBLIC's TEMPORARY is revoked, so no temp tables or functions.
    await expectPgError(query(appUrl(), "create temp table scratch (i int)"), "42501");
    await expectPgError(
      query(appUrl(), "create function pg_temp.f() returns int language sql as 'select 1'"),
      "42501",
    );
    const rows = await query<{ n: number }>(
      appUrl(),
      "select purge_security_events()::int as n",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("migrator cannot create roles; tables and the purge function belong to migrator", async () => {
    await expectPgError(query(migratorUrl(), "create role sneaky"), "42501");
    const owners = await query<{ owner: string }>(
      adminUrl(),
      "select distinct pg_get_userbyid(relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
    );
    expect(owners).toEqual([{ owner: "migrator" }]);
    const fn = await query<{ owner: string; secdef: boolean }>(
      adminUrl(),
      "select pg_get_userbyid(proowner) as owner, prosecdef as secdef from pg_proc where proname = 'purge_security_events'",
    );
    expect(fn).toEqual([{ owner: "migrator", secdef: true }]);
  });

  it("a direct delete of a category in use fails immediately (deferred FK made immediate)", async () => {
    const c = new pg.Client({ connectionString: appUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query(
        "insert into users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) values (gen_random_uuid(), 'fk@example.test', 'FK', '$argon2id$x', now(), now(), now())",
      );
      const [u] = (
        await c.query<{ id: string }>(
          "select id from users where email = 'fk@example.test'",
        )
      ).rows;
      await c.query(
        "insert into budgets (id, name, timezone, created_at, updated_at) values ('00000000-0000-7000-8000-000000000001', 'B', 'UTC', now(), now())",
      );
      await c.query(
        "insert into budget_members values ('00000000-0000-7000-8000-000000000001', $1, 'owner', now(), now(), now())",
        [u?.id],
      );
      await c.query(
        "insert into categories (id, budget_id, name, kind, sort_order, created_at, updated_at) values ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'C', 'expense', 0, now(), now())",
      );
      await c.query(
        "insert into transactions (id, budget_id, date, direction, amount_cents, created_at, updated_at) values ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', '2026-11-01', 'outflow', 5, now(), now())",
      );
      await c.query(
        "insert into transaction_splits (id, budget_id, transaction_id, category_id, amount_cents, created_at) values (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000002', 5, now())",
      );
      await c.query(
        "set constraints transaction_splits_category_fkey immediate",
      );
      await expectPgError(
        c.query(
          "delete from categories where id = '00000000-0000-7000-8000-000000000002'",
        ),
        "23503",
      );
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
  });
});

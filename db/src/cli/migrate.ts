// `pnpm --filter ./db run migrate` (local, CI, compose, and the production
// migrate job). Steps:
//   1. Local/test only, when DATABASE_ADMIN_URL is set: run roles.sql as the
//      superuser and set the app/migrator passwords from their URLs.
//   2. dbmate migrate as `migrator` (MIGRATOR_DATABASE_URL), with a migration
//      lock and no schema dump.
//   3. roles.sql as `migrator`: re-applies table grants and verifies the whole
//      privilege model (fails loudly if anything is off).
// Never prints URLs, passwords or SQL values.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  DatabaseUrlError,
  assertLocalDatabaseUrl,
  assertSecureDatabaseUrl,
  parseDatabaseUrl,
} from "../conn.ts";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROLES_SQL = join(DB_DIR, "roles.sql");
const MIGRATIONS_DIR = join(DB_DIR, "migrations");

function fail(message: string): never {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set`);
  return v;
}

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    return fail(`${name} is not a valid URL`);
  }
}

async function withClient<T>(
  url: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: url,
    application_name: "shoestring-migrate",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runRolesSql(url: string): Promise<void> {
  await withClient(url, async (c) => {
    c.on("notice", (n) => {
      console.log(`migrate: ${n.message ?? ""}`);
    });
    await c.query(readFileSync(ROLES_SQL, "utf8"));
  });
}

/** ALTER ROLE ... PASSWORD with the quoting done server-side by format(%I, %L). */
async function setRolePassword(
  admin: pg.Client,
  role: string,
  password: string,
): Promise<void> {
  const res = await admin.query<{ stmt: string }>(
    "select format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) as stmt",
    [role, password],
  );
  const stmt = res.rows[0]?.stmt;
  if (!stmt) fail("could not build ALTER ROLE statement");
  await admin.query(stmt);
}

async function bootstrapLocalRoles(adminUrl: string): Promise<void> {
  // Local/test only (F-42): parsed by the driver, host parameters refused.
  assertLocalDatabaseUrl("DATABASE_ADMIN_URL", adminUrl);
  console.log("migrate: bootstrapping roles (local/test)");
  await runRolesSql(adminUrl);
  const wanted: [string, string][] = [["MIGRATOR_DATABASE_URL", "migrator"]];
  if (process.env.DATABASE_URL) wanted.push(["DATABASE_URL", "app"]);
  await withClient(adminUrl, async (c) => {
    for (const [envName, role] of wanted) {
      const raw = requireEnv(envName);
      // Passwords are only ever set on the local database being bootstrapped.
      assertLocalDatabaseUrl(envName, raw);
      const u = parseUrl(envName, raw);
      if (decodeURIComponent(u.username) !== role)
        fail(`${envName} must use the ${role} role`);
      const password = decodeURIComponent(u.password);
      if (password.length < 16)
        fail(`${envName} needs a generated password of at least 16 characters`);
      await setRolePassword(c, role, password);
    }
  });
}

/**
 * dbmate's driver (lib/pq) defaults to sslmode=require, but the local and CI
 * Postgres has no TLS and its URLs carry no sslmode. For a local host without
 * an explicit sslmode only, dbmate gets sslmode=disable. Production URLs set
 * sslmode=verify-full and are passed through unchanged.
 */
function dbmateUrl(url: string): string {
  const u = new URL(url);
  if (
    parseDatabaseUrl("MIGRATOR_DATABASE_URL", url).local &&
    !u.searchParams.has("sslmode")
  ) {
    u.searchParams.set("sslmode", "disable");
  }
  return u.toString();
}

function runDbmate(migratorUrl: string): void {
  const require = createRequire(import.meta.url);
  const cli = join(
    dirname(require.resolve("dbmate/package.json")),
    "dist",
    "cli.js",
  );
  const res = spawnSync(
    process.execPath,
    [
      cli,
      "--env",
      "MIGRATOR_DATABASE_URL",
      "--migrations-dir",
      MIGRATIONS_DIR,
      "--no-dump-schema",
      "--wait",
      "--wait-timeout",
      "60s",
      "--migration-lock",
      "migrate",
    ],
    {
      cwd: DB_DIR,
      stdio: "inherit",
      env: { ...process.env, MIGRATOR_DATABASE_URL: dbmateUrl(migratorUrl) },
    },
  );
  if (res.status !== 0) fail(`dbmate exited with status ${String(res.status)}`);
}

async function main(): Promise<void> {
  const migratorUrl = requireEnv("MIGRATOR_DATABASE_URL");
  // A remote migrator URL must verify the server certificate (F-28, F-42).
  assertSecureDatabaseUrl("MIGRATOR_DATABASE_URL", migratorUrl);
  const migrator = parseUrl("MIGRATOR_DATABASE_URL", migratorUrl);
  if (decodeURIComponent(migrator.username) !== "migrator")
    fail("MIGRATOR_DATABASE_URL must use the migrator role");
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (adminUrl) await bootstrapLocalRoles(adminUrl);
  console.log("migrate: applying migrations (dbmate, migrator role)");
  runDbmate(migratorUrl);
  console.log(
    "migrate: applying and verifying grants (roles.sql, migrator role)",
  );
  await runRolesSql(migratorUrl);
  console.log("migrate: done");
}

main().catch((e: unknown) => {
  if (e instanceof DatabaseUrlError) fail(e.message);
  const code =
    typeof e === "object" && e !== null && "code" in e
      ? String(e.code)
      : "unknown";
  // Our own roles.sql exceptions carry no values; show them. Driver errors show the SQLSTATE only.
  const msg =
    e instanceof Error && e.message.startsWith("roles.sql:")
      ? e.message
      : `error (SQLSTATE ${code})`;
  fail(msg);
});

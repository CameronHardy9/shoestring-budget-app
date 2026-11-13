// Connection pool and Kysely instance. Internal to db/.
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_DATE = 1082;

function parseSafeInteger(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    // Unreachable with the schema's limits; never silently lose precision.
    throw new RangeError("integer outside the JavaScript safe range");
  }
  return n;
}

/**
 * Type parsers for every connection:
 * - int8 and numeric become safe integers (money is integer cents; sums are
 *   cast back to bigint in SQL). A fractional or unsafe value throws.
 * - date stays the 'YYYY-MM-DD' string: no JS Date, so no timezone shift.
 */
const types = new pg.TypeOverrides();
types.setTypeParser(OID_INT8, "text", parseSafeInteger);
types.setTypeParser(OID_NUMERIC, "text", parseSafeInteger);
types.setTypeParser(OID_DATE, "text", (value: string) => value);

export interface PoolOptions {
  connectionString: string;
  /** Pool size. Cloud Run concurrency 20 with Neon's pooler: keep small. */
  max?: number;
  applicationName?: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "shoestring",
    // Timeouts are role defaults set by roles.sql (statement_timeout 10 s for
    // app), not startup parameters: Neon's pooled endpoint (PgBouncer) can
    // reject unknown startup parameters.
    types,
  });
  // An idle client error (e.g. the server restarted) must not crash the
  // process; the next checkout reconnects. Only the SQLSTATE is reported, never
  // the message (it can contain values).
  pool.on("error", () => undefined);
  return pool;
}

export function createKysely(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

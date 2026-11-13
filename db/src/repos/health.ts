// readyz support: database reachable, migrations applied, key IDs in use.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { LATEST_MIGRATION_VERSION } from "../migrations.ts";

/** Round trip to the database (throws if unreachable). */
export async function ping(ctx: Ctx): Promise<void> {
  await sql`select 1`.execute(ctx.db);
}

/** True when the newest migration this build ships with has been applied. */
export async function isSchemaCurrent(ctx: Ctx): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("schema_migrations")
    .select("version")
    .where("version", "=", LATEST_MIGRATION_VERSION)
    .executeTakeFirst();
  return row !== undefined;
}

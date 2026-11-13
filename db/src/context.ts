// Internal execution context shared by every repository function.
import type { Kysely, Transaction } from "kysely";
import type { Clock } from "./clock.ts";
import type { IdGenerator } from "./ids.ts";
import type { Database } from "./schema.ts";

export interface Ctx {
  readonly db: Kysely<Database> | Transaction<Database>;
  readonly clock: Clock;
  readonly newId: IdGenerator;
}

/** Runs `fn` in the current transaction, or in a new one. */
export async function withTx<T>(
  ctx: Ctx,
  fn: (tx: Ctx & { db: Transaction<Database> }) => Promise<T>,
): Promise<T> {
  if (ctx.db.isTransaction) {
    return fn(ctx as Ctx & { db: Transaction<Database> });
  }
  return ctx.db.transaction().execute((trx) => fn({ ...ctx, db: trx }));
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export function plus(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

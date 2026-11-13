// Persistent auth rate-limit counters (auth.md §14). Keys are HMACs computed
// by the backend (throttle-v1 subkey); no raw IPs or emails reach this table.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";

export interface ThrottleKey {
  /** e.g. 'login:ip', 'login:email_ip', 'mfa:user', 'email:daily' */
  scope: string;
  /** 32-byte HMAC */
  keyHash: Buffer;
}

/** Adds `by` (default 1) to the counter of the window starting at `windowStart`; returns the new count. */
export async function hitThrottle(
  ctx: Ctx,
  key: ThrottleKey,
  windowStart: Date,
  by = 1,
): Promise<number> {
  const now = ctx.clock();
  const row = await ctx.db
    .insertInto("auth_throttles")
    .values({
      scope: key.scope,
      key_hash: key.keyHash,
      window_start: windowStart,
      count: by,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["scope", "key_hash", "window_start"]).doUpdateSet({
        count: sql<number>`auth_throttles.count + ${by}::int`,
        updated_at: now,
      }),
    )
    .returning("count")
    .executeTakeFirstOrThrow();
  return row.count;
}

/** Sum of the counters whose window starts at or after `since` (rolling windows). */
export async function sumThrottle(
  ctx: Ctx,
  key: ThrottleKey,
  since: Date,
): Promise<number> {
  const row = await ctx.db
    .selectFrom("auth_throttles")
    .select(sql<number>`coalesce(sum(count), 0)::int`.as("n"))
    .where("scope", "=", key.scope)
    .where("key_hash", "=", key.keyHash)
    .where("window_start", ">=", since)
    .executeTakeFirstOrThrow();
  return row.n;
}

/** Clears every window of a key (e.g. the per-email login counters after a password reset). */
export async function clearThrottle(ctx: Ctx, key: ThrottleKey): Promise<void> {
  await ctx.db
    .deleteFrom("auth_throttles")
    .where("scope", "=", key.scope)
    .where("key_hash", "=", key.keyHash)
    .execute();
}

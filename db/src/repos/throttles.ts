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

/**
 * Adds `by` (default 1) to the counter of the window starting at `windowStart`
 * and returns the new count.
 *
 * - `by >= 0` charges: one atomic upsert, so concurrent charges each see a
 *   distinct, increasing count (F-45 reserve-before-check).
 * - `by < 0` refunds (F-45 release after success, refusal or error): a plain
 *   UPDATE clamped at 0 that never inserts. If the window's row is gone
 *   (cleared, purged) it is a no-op returning 0. A refund cannot go through
 *   the upsert, because Postgres checks `count >= 0` on the proposed INSERT
 *   row before it resolves the conflict (23514 on every refund).
 */
export async function hitThrottle(
  ctx: Ctx,
  key: ThrottleKey,
  windowStart: Date,
  by = 1,
): Promise<number> {
  if (!Number.isSafeInteger(by) || Math.abs(by) > 2_147_483_647)
    throw new RangeError("throttle increment must be a 32-bit integer");
  const now = ctx.clock();
  if (by < 0) {
    const refunded = await ctx.db
      .updateTable("auth_throttles")
      .set({
        count: sql<number>`greatest(auth_throttles.count + ${by}::int, 0)`,
        updated_at: now,
      })
      .where("scope", "=", key.scope)
      .where("key_hash", "=", key.keyHash)
      .where("window_start", "=", windowStart)
      .returning("count")
      .executeTakeFirst();
    return refunded?.count ?? 0;
  }
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

// auth_throttles charges and refunds (F-45: charge first, refund on success,
// refusal or error). Refunds must not go through INSERT ... ON CONFLICT:
// Postgres checks `count >= 0` on the proposed insert row first (23514).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDal } from "../dal.ts";
import type { Dal } from "../dal.ts";
import { gate, hash32, waitForLockWaiters } from "../test-support/fixtures.ts";
import { useTestDb } from "../test-support/harness.ts";
import type { ThrottleKey } from "./throttles.ts";

const t = useTestDb();
const W = new Date("2026-11-13T15:00:00Z");

// A second Dal with enough connections that parallel calls really overlap.
let wide: Dal;
beforeAll(() => {
  wide = createDal({
    connectionString: t.appUrl,
    clock: t.clock.clock,
    poolMax: 25,
  });
});
afterAll(async () => {
  await wide.close();
});

const newKey = (): ThrottleKey => ({ scope: "mfa:user", keyHash: hash32() });

const rows = async (key: ThrottleKey) =>
  (
    await t.admin.query<{ count: number }>(
      `select count from auth_throttles where scope = $1 and key_hash = $2`,
      [key.scope, key.keyHash],
    )
  ).rows;

describe("hitThrottle refunds (by < 0)", () => {
  it("a refund after a charge decrements the same window", async () => {
    const key = newKey();
    await t.dal.throttles.hitThrottle(key, W);
    await t.dal.throttles.hitThrottle(key, W);
    expect(await t.dal.throttles.hitThrottle(key, W, -1)).toBe(1);
    expect(await t.dal.throttles.sumThrottle(key, W)).toBe(1);
    expect(await t.dal.throttles.hitThrottle(key, W, -1)).toBe(0);
    expect(await rows(key)).toEqual([{ count: 0 }]);
    // The next charge reuses the row.
    expect(await t.dal.throttles.hitThrottle(key, W)).toBe(1);
  });

  it("refunds only the given window", async () => {
    const key = newKey();
    const later = new Date(W.getTime() + 3_600_000);
    await t.dal.throttles.hitThrottle(key, W, 2);
    await t.dal.throttles.hitThrottle(key, later, 2);
    expect(await t.dal.throttles.hitThrottle(key, later, -1)).toBe(1);
    expect(await t.dal.throttles.sumThrottle(key, W)).toBe(3);
  });

  it("a refund on a missing row is a no-op returning 0 and creates no row", async () => {
    const key = newKey();
    expect(await t.dal.throttles.hitThrottle(key, W, -1)).toBe(0);
    expect(await rows(key)).toEqual([]);
    // Also after the key was cleared (password reset) or purged.
    await t.dal.throttles.hitThrottle(key, W);
    await t.dal.throttles.clearThrottle(key);
    expect(await t.dal.throttles.hitThrottle(key, W, -1)).toBe(0);
    expect(await rows(key)).toEqual([]);
  });

  it("a refund never goes below 0", async () => {
    const key = newKey();
    await t.dal.throttles.hitThrottle(key, W);
    expect(await t.dal.throttles.hitThrottle(key, W, -5)).toBe(0);
    expect(await t.dal.throttles.hitThrottle(key, W, -1)).toBe(0);
    expect(await rows(key)).toEqual([{ count: 0 }]);
  });

  it("rejects non-integer increments", async () => {
    const key = newKey();
    await expect(t.dal.throttles.hitThrottle(key, W, 0.5)).rejects.toThrow(
      RangeError,
    );
    await expect(t.dal.throttles.hitThrottle(key, W, -0.5)).rejects.toThrow(
      RangeError,
    );
    expect(await rows(key)).toEqual([]);
  });
});

describe("hitThrottle charge/refund concurrency", () => {
  it("a refund waiting on an uncommitted charge applies on top of it", async () => {
    const key = newKey();
    await t.dal.throttles.hitThrottle(key, W, 2);
    const charged = gate();
    const hold = gate();
    const charge = t.dal.transaction(async (tx) => {
      await tx.throttles.hitThrottle(key, W);
      charged.open();
      await hold.promise;
    });
    await charged.promise;
    const refund = wide.throttles.hitThrottle(key, W, -1);
    await waitForLockWaiters(t.admin); // blocked on the row lock
    hold.open();
    await charge;
    expect(await refund).toBe(2);
    expect(await rows(key)).toEqual([{ count: 2 }]);
  });

  it("a charge waiting on an uncommitted refund applies on top of it", async () => {
    const key = newKey();
    await t.dal.throttles.hitThrottle(key, W, 2);
    const refunded = gate();
    const hold = gate();
    const refund = t.dal.transaction(async (tx) => {
      expect(await tx.throttles.hitThrottle(key, W, -1)).toBe(1);
      refunded.open();
      await hold.promise;
    });
    await refunded.promise;
    const charge = wide.throttles.hitThrottle(key, W);
    await waitForLockWaiters(t.admin);
    hold.open();
    await refund;
    expect(await charge).toBe(2);
    expect(await rows(key)).toEqual([{ count: 2 }]);
  });

  it("a rolled-back charge leaves the waiting refund on the committed count", async () => {
    const key = newKey();
    await t.dal.throttles.hitThrottle(key, W, 2);
    const charged = gate();
    const hold = gate();
    const charge = t.dal.transaction(async (tx) => {
      await tx.throttles.hitThrottle(key, W);
      charged.open();
      await hold.promise;
      throw new Error("rollback");
    });
    await charged.promise;
    const refund = wide.throttles.hitThrottle(key, W, -1);
    await waitForLockWaiters(t.admin);
    hold.open();
    await expect(charge).rejects.toThrow("rollback");
    expect(await refund).toBe(1);
    expect(await rows(key)).toEqual([{ count: 1 }]);
  });

  it("parallel charges and refunds lose no updates", async () => {
    const key = newKey();
    // Pre-charge enough that no interleaving can reach the clamp at 0.
    await t.dal.throttles.hitThrottle(key, W, 20);
    const ops = [
      ...Array.from({ length: 40 }, () => 1),
      ...Array.from({ length: 20 }, () => -1),
    ].sort(() => Math.random() - 0.5);
    const results = await Promise.all(
      ops.map((by) => wide.throttles.hitThrottle(key, W, by)),
    );
    for (const n of results) expect(n).toBeGreaterThanOrEqual(0);
    expect(await rows(key)).toEqual([{ count: 40 }]);
  });

  it("F-45 reserve/refund: refused attempts give their slot back, kept ones stay under the limit", async () => {
    const key = newKey();
    const LIMIT = 5;
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const n = await wide.throttles.hitThrottle(key, W);
        if (n > LIMIT) {
          await wide.throttles.hitThrottle(key, W, -1);
          return "refused";
        }
        return "kept";
      }),
    );
    const kept = outcomes.filter((o) => o === "kept").length;
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThanOrEqual(LIMIT);
    expect(await rows(key)).toEqual([{ count: kept }]);
  });
});

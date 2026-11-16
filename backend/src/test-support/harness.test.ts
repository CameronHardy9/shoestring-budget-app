// The fake auth_throttles must behave like db/src/repos/throttles.ts so that
// backend tests cannot pass on semantics the real DAL does not have.
import { describe, expect, it } from "vitest";
import { T0, fakeThrottles } from "./harness.ts";

const key = { scope: "mfa:user", keyHash: Buffer.alloc(32, 7) };

describe("fakeThrottles.hitThrottle", () => {
  it("charges with an upsert and returns the running count", async () => {
    const t = fakeThrottles();
    expect(await t.dal.hitThrottle(key, T0)).toBe(1);
    expect(await t.dal.hitThrottle(key, T0, 3)).toBe(4);
    expect(await t.dal.sumThrottle(key, T0)).toBe(4);
  });

  it("clamps a refund at 0 and never goes negative", async () => {
    const t = fakeThrottles();
    await t.dal.hitThrottle(key, T0, 2);
    expect(await t.dal.hitThrottle(key, T0, -5)).toBe(0);
    expect(await t.dal.hitThrottle(key, T0, -1)).toBe(0);
    expect(await t.dal.sumThrottle(key, T0)).toBe(0);
    expect([...t.rows.values()]).toEqual([0]);
  });

  it("a refund into a missing window is a no-op returning 0 (no row inserted)", async () => {
    const t = fakeThrottles();
    expect(await t.dal.hitThrottle(key, T0, -1)).toBe(0);
    expect(t.rows.size).toBe(0);
    await t.dal.hitThrottle(key, T0);
    await t.dal.clearThrottle(key);
    expect(await t.dal.hitThrottle(key, T0, -1)).toBe(0);
    expect(t.rows.size).toBe(0);
  });

  it("rejects a non-32-bit increment like the real DAL", async () => {
    const t = fakeThrottles();
    await expect(t.dal.hitThrottle(key, T0, 1.5)).rejects.toThrow(RangeError);
    await expect(t.dal.hitThrottle(key, T0, 2 ** 31)).rejects.toThrow(
      RangeError,
    );
    expect(t.rows.size).toBe(0);
  });
});

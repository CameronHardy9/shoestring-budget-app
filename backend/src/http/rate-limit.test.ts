// F-46: the in-memory limiter frees ended windows, sweeps on a timer, and is
// hard-capped. F-45: reservations count first and refund into their own window.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppClock } from "../clock.ts";
import { parseKeyring } from "../crypto/keyring.ts";
import {
  T0,
  fakeThrottles,
  strictDal,
  testKeyring,
} from "../test-support/harness.ts";
import { HOUR, MINUTE, MemoryLimiter, Throttles } from "./rate-limit.ts";

const limiters: MemoryLimiter[] = [];
afterEach(() => {
  for (const l of limiters.splice(0)) l.close();
  vi.useRealTimers();
});

function limiter(options: { maxEntries?: number; sweepMs?: number } = {}) {
  const clock = createAppClock();
  clock.freeze(T0);
  const l = new MemoryLimiter(clock, options);
  limiters.push(l);
  return { l, clock };
}

describe("MemoryLimiter (F-46)", () => {
  it("frees 20,000 keys from a minute ago on the next sweep", () => {
    const { l, clock } = limiter();
    for (let i = 0; i < 20_000; i++)
      l.hit("global", `10.0.${i >> 8}.${i & 255}`, 300, MINUTE);
    expect(l.size).toBe(20_000);
    clock.freeze(new Date(T0.getTime() + MINUTE));
    l.sweep();
    expect(l.size).toBe(0);
  });

  it("sweeps on an unref'd timer, not on requests", () => {
    vi.useFakeTimers();
    const clock = createAppClock(() => Date.now());
    const l = new MemoryLimiter(clock, { sweepMs: 1_000 });
    limiters.push(l);
    l.hit("global", "a", 300, MINUTE);
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(l.size).toBe(1); // nothing scans on its own
    vi.advanceTimersByTime(1_000);
    expect(l.size).toBe(0);
  });

  it("is hard-capped: the oldest entries are evicted", () => {
    const { l } = limiter({ maxEntries: 100 });
    for (let i = 0; i < 1_000; i++) l.hit("global", `k${i}`, 300, MINUTE);
    expect(l.size).toBe(100);
  });

  it("an ended window starts again at zero; the limit still applies within a window", () => {
    const { l, clock } = limiter();
    for (let i = 0; i < 3; i++) l.hit("writes", "u", 3, MINUTE);
    expect(() => {
      l.hit("writes", "u", 3, MINUTE);
    }).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }) as Error);
    clock.freeze(new Date(T0.getTime() + MINUTE));
    expect(() => {
      l.hit("writes", "u", 3, MINUTE);
    }).not.toThrow();
  });
});

describe("Throttles reservations (F-45)", () => {
  it("refunds into the window that was charged, even after the window has moved on", async () => {
    const clock = createAppClock();
    clock.freeze(new Date("2026-11-13T15:59:59.000Z"));
    const t = fakeThrottles();
    const th = new Throttles(
      strictDal({ throttles: t.dal }),
      parseKeyring(testKeyring()),
      clock,
    );
    const key = th.key("mfa:user", "u1");
    const r = await th.reserveRolling(key, 24 * HOUR);
    expect(r.count).toBe(1);
    clock.freeze(new Date("2026-11-13T16:00:01.000Z")); // next hourly bucket
    await th.release(r);
    expect(await th.rollingCount(key, 24 * HOUR)).toBe(0);
    expect([...t.rows.values()].every((n) => n >= 0)).toBe(true);
  });
});

// Rate limits (auth.md §14). Auth limits and the email budget persist in
// Postgres (auth_throttles) with HMAC'd keys (throttle-v1 subkey), so they
// survive restarts and scale-to-zero. The global (per IP) and writes (per user)
// limits are in memory per instance. All windows read the app clock.
import type { Dal, ThrottleKey } from "@shoestring/db";
import { isIP } from "node:net";
import type { AppClock } from "../clock.ts";
import { hmacSha256 } from "../crypto/keyring.ts";
import type { Keyring } from "../crypto/keyring.ts";
import { ApiError } from "../errors.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Client IP key (F-08): full IPv4, or the /64 prefix of an IPv6 address. */
export function ipKey(ip: string): string {
  const v =
    ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v) !== 6) return v;
  const [head = "", tail = ""] = v.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = v.includes("::")
    ? [
        ...left,
        ...Array<string>(8 - left.length - right.length).fill("0"),
        ...right,
      ]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function retryAfter(now: number, windowMs: number): number {
  return Math.max(
    1,
    Math.ceil((windowStart(now, windowMs) + windowMs - now) / 1000),
  );
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError("RATE_LIMITED", { retryAfterSeconds });
}

/** In-memory fixed-window counters (global and writes rows), F-46-safe. */
export class MemoryLimiter {
  /** Map order = insertion order, so the first entry is the oldest. */
  private readonly counts = new Map<string, { end: number; n: number }>();
  private readonly clock: AppClock;
  private readonly maxEntries: number;
  private readonly timer: NodeJS.Timeout;

  constructor(clock: AppClock, options: { maxEntries?: number; sweepMs?: number } = {}) {
    this.clock = clock;
    this.maxEntries = options.maxEntries ?? 50_000;
    // Expired windows are dropped on a timer, never by scanning on a request.
    this.timer = setInterval(() => {
      this.sweep();
    }, options.sweepMs ?? MINUTE);
    this.timer.unref();
  }

  /** Counts one hit; throws RATE_LIMITED when the window is over `limit`. */
  hit(scope: string, key: string, limit: number, windowMs: number): void {
    const now = this.clock.now().getTime();
    const id = `${scope}\0${key}`;
    let entry = this.counts.get(id);
    if (!entry || entry.end <= now) {
      if (entry) this.counts.delete(id); // re-insert at the end (newest)
      entry = { end: windowStart(now, windowMs) + windowMs, n: 0 };
      // Hard cap: evict the oldest entries rather than grow without bound.
      while (this.counts.size >= this.maxEntries) {
        const oldest = this.counts.keys().next().value;
        if (oldest === undefined) break;
        this.counts.delete(oldest);
      }
      this.counts.set(id, entry);
    }
    entry.n++;
    if (entry.n > limit) throw rateLimited(Math.max(1, Math.ceil((entry.end - now) / 1000)));
  }

  /** Drops every entry whose window has ended. */
  sweep(): void {
    const now = this.clock.now().getTime();
    for (const [k, v] of this.counts) if (v.end <= now) this.counts.delete(k);
  }

  get size(): number {
    return this.counts.size;
  }

  clear(): void {
    this.counts.clear();
  }

  close(): void {
    clearInterval(this.timer);
  }
}

/** A counted attempt, refundable into the exact window it was charged to (F-45). */
export interface Reservation {
  readonly key: ThrottleKey;
  readonly windowStart: Date;
  /** Count after this attempt (rolling: summed over the whole span). */
  readonly count: number;
}

/** Persistent counters over the DAL's auth_throttles. */
export class Throttles {
  private readonly dal: Dal;
  private readonly keyring: Keyring | null;
  private readonly clock: AppClock;
  constructor(
    dal: Dal,
    keyring: Keyring | null,
    clock: AppClock,
  ) {
    this.dal = dal;
    this.keyring = keyring;
    this.clock = clock;
  }

  /** HMAC(throttle-v1, scope + key): no raw IP, email or user ID reaches the table. */
  key(scope: string, raw: string): ThrottleKey {
    if (!this.keyring) throw new Error("throttle keys need APP_KEYRING");
    return {
      scope,
      keyHash: hmacSha256(this.keyring.subkey("throttle-v1"), `${scope}\0${raw}`),
    };
  }

  /** Count in the current fixed window. */
  async count(key: ThrottleKey, windowMs: number): Promise<number> {
    const now = this.clock.now().getTime();
    return this.dal.throttles.sumThrottle(
      key,
      new Date(windowStart(now, windowMs)),
    );
  }

  /** Adds one to the current fixed window and returns the new count. */
  async hit(key: ThrottleKey, windowMs: number): Promise<number> {
    const now = this.clock.now().getTime();
    return this.dal.throttles.hitThrottle(
      key,
      new Date(windowStart(now, windowMs)),
    );
  }

  /** Rolling window made of hourly buckets (e.g. 24 h failure budgets). */
  async rollingCount(key: ThrottleKey, spanMs: number): Promise<number> {
    const now = this.clock.now().getTime();
    return this.dal.throttles.sumThrottle(
      key,
      new Date(windowStart(now, HOUR) - spanMs + HOUR),
    );
  }

  async rollingHit(key: ThrottleKey, spanMs: number): Promise<number> {
    await this.dal.throttles.hitThrottle(
      key,
      new Date(windowStart(this.clock.now().getTime(), HOUR)),
    );
    return this.rollingCount(key, spanMs);
  }

  clear(key: ThrottleKey): Promise<void> {
    return this.dal.throttles.clearThrottle(key);
  }

  /**
   * Race-safe attempt counting (F-45): the attempt is counted first, with the
   * atomic upsert, and the caller compares the returned count to its limit.
   * Concurrent attempts each see a distinct, increasing count, so at most
   * `limit` of them can pass.
   */
  async reserve(key: ThrottleKey, windowMs: number): Promise<Reservation> {
    const start = new Date(windowStart(this.clock.now().getTime(), windowMs));
    return { key, windowStart: start, count: await this.dal.throttles.hitThrottle(key, start) };
  }

  /** As reserve(), over a rolling span of hourly buckets. */
  async reserveRolling(key: ThrottleKey, spanMs: number): Promise<Reservation> {
    const now = this.clock.now().getTime();
    const start = new Date(windowStart(now, HOUR));
    await this.dal.throttles.hitThrottle(key, start);
    const count = await this.dal.throttles.sumThrottle(key, new Date(windowStart(now, HOUR) - spanMs + HOUR));
    return { key, windowStart: start, count };
  }

  /** Refunds a reservation (success, or refused without a check) into its own window. */
  async release(r: Reservation): Promise<void> {
    await this.dal.throttles.hitThrottle(r.key, r.windowStart, -1);
  }

  /** Throws RATE_LIMITED when `count >= limit` for the fixed window. */
  async assertUnder(
    key: ThrottleKey,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    if ((await this.count(key, windowMs)) >= limit)
      throw rateLimited(retryAfter(this.clock.now().getTime(), windowMs));
  }

  /** Counts an attempt and throws RATE_LIMITED once it exceeds `limit`. */
  async hitOrThrow(
    key: ThrottleKey,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    if ((await this.hit(key, windowMs)) > limit)
      throw rateLimited(retryAfter(this.clock.now().getTime(), windowMs));
  }

  retryAfter(windowMs: number): number {
    return retryAfter(this.clock.now().getTime(), windowMs);
  }
}

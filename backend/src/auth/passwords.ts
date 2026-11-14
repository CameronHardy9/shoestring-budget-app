// Passwords (auth.md §7, F-15, F-24): argon2id (m=19 MiB, t=2, p=1) behind a
// per-instance semaphore (4 concurrent, 2 s queue wait, then 503), policy
// checks, and the HIBP k-anonymity range check with a bundled fallback list.
import { hash, parseOptions, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { ApiError, fieldError, validationFailed } from "../errors.ts";
import type { FieldLocation } from "../errors.ts";
import type { Logger } from "../logging.ts";
import { COMMON_PASSWORDS } from "./common-passwords.ts";

export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Counting semaphore with a bounded wait (wall clock, not the app clock). */
export class HashQueue {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly limit: number;
  private readonly maxWaitMs: number;
  constructor(
    limit: number = 4,
    maxWaitMs: number = 2_000,
  ) {
    this.limit = limit;
    this.maxWaitMs = maxWaitMs;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await this.wait();
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new ApiError("UNAVAILABLE", { retryAfterSeconds: 2 }));
      }, this.maxWaitMs);
      const go = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(go);
    });
  }
}

export type BreachChecker = (password: string) => Promise<boolean>;

export interface PasswordServiceOptions {
  queue?: HashQueue;
  isBreached: BreachChecker;
}

export class PasswordService {
  private readonly queue: HashQueue;
  private dummyHash: Promise<string> | null = null;
  readonly isBreached: BreachChecker;

  constructor(options: PasswordServiceOptions) {
    this.queue = options.queue ?? new HashQueue();
    this.isBreached = options.isBreached;
  }

  hash(password: string): Promise<string> {
    return this.queue.run(() => hash(password, ARGON2_PARAMS));
  }

  /** Verifies; a malformed stored hash counts as a mismatch. */
  verify(storedHash: string, password: string): Promise<boolean> {
    return this.queue.run(async () => {
      try {
        return await verify(storedHash, password);
      } catch {
        return false;
      }
    });
  }

  /** Unknown-email login: same work as a real verify, always false (auth.md §5). */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= hash(
      randomBytes(32).toString("base64url"),
      ARGON2_PARAMS,
    );
    await this.verify(await this.dummyHash, password);
    return false;
  }

  /** True when the stored hash is not argon2id with the current parameters. */
  needsRehash(storedHash: string): boolean {
    try {
      const o = parseOptions(storedHash);
      return (
        !storedHash.startsWith("$argon2id$") ||
        o.memoryCost < ARGON2_PARAMS.memoryCost ||
        o.timeCost < ARGON2_PARAMS.timeCost ||
        o.parallelism !== ARGON2_PARAMS.parallelism
      );
    } catch {
      return true;
    }
  }

  /**
   * Policy for a NEW password (auth.md §7): 12-128 code points (checked by the
   * schema), not equal to the email, not breached. Throws VALIDATION_FAILED.
   */
  async assertAcceptable(
    password: string,
    email: string,
    field: { in: FieldLocation; field: string },
  ): Promise<void> {
    if (password.trim().toLowerCase() === email.trim().toLowerCase())
      throw validationFailed([
        fieldError(field.in, field.field, "invalid_value"),
      ]);
    if (await this.isBreached(password))
      throw validationFailed([
        fieldError(field.in, field.field, "breached_password"),
      ]);
  }
}

export function inBundledList(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

export interface HibpOptions {
  enabled: boolean;
  logger: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * HIBP Pwned Passwords range API (k-anonymity: only 5 hex chars of the SHA-1
 * leave the server), Add-Padding, 2 s timeout, 1 MiB cap. Any failure falls
 * back to the bundled list and logs a counter (no password data).
 */
export function createBreachChecker(options: HibpOptions): BreachChecker {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  return async (password) => {
    if (inBundledList(password)) return true;
    if (!options.enabled) return false;
    const sha1 = createHash("sha1")
      .update(password)
      .digest("hex")
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await doFetch(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: { "Add-Padding": "true", "User-Agent": "shoestring-api" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        },
      );
      if (!res.ok || !res.body) throw new Error("hibp status");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("hibp too large");
        }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      for (const line of body.split("\n")) {
        const [s, count] = line.trim().split(":");
        if (s === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch {
      options.logger.warn(
        { metric: "hibp_fallback" },
        "breached-password API unavailable; used bundled list",
      );
      return false;
    }
  };
}

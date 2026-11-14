// Test harness: the real app (pipeline, route table, error handler, response
// validation) over a strict fake DAL. Any DAL call a test did not configure
// throws, so tests state exactly which data access they expect.
import type {
  Dal,
  MeRecord,
  SecurityEventInput,
  SessionRecord,
  SessionStatus,
  ThrottleKey,
  UserStatus,
} from "@shoestring/db";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { DalError } from "@shoestring/db";
import { buildApp, createDeps } from "../app.ts";
import type { PasswordService } from "../auth/passwords.ts";
import { createAppClock } from "../clock.ts";
import type { AppClock } from "../clock.ts";
import { loadConfig } from "../config.ts";
import { randomToken, sha256 } from "../crypto/keyring.ts";
import type { AppDeps } from "../deps.ts";
import { Outbox } from "../email/transports.ts";
import type { Route } from "../http/routes.ts";
import { createLogger } from "../logging.ts";
import { FakeMfa } from "./fake-mfa.ts";

export const ORIGIN = "https://app.test";
export const HOST = "app.test";
export const T0 = new Date("2026-11-13T15:00:00.000Z");

export function testKeyring(): string {
  return JSON.stringify({
    current: "k1",
    keys: { k1: randomBytes(32).toString("base64") },
  });
}

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    DATABASE_URL: "postgres://app:pw@localhost:5432/shoestring_test",
    APP_KEYRING: testKeyring(),
    ...extra,
  };
}

type AnyFn = (...args: never[]) => unknown;
export type DalOverrides = {
  [K in keyof Dal]?: Dal[K] extends AnyFn
    ? Dal[K]
    : Partial<Record<keyof Dal[K], AnyFn>>;
};

/** A Dal whose every unconfigured function throws "unexpected DAL call". */
export function strictDal(overrides: DalOverrides): Dal {
  return new Proxy({} as Dal, {
    get(_t, area: string) {
      const o = (overrides as Record<string, unknown>)[area];
      if (typeof o === "function") return o;
      if (area === "close") return () => Promise.resolve();
      if (area === "then") return undefined;
      return new Proxy(
        {},
        {
          get(_t2, fn: string) {
            const impl = (o as Record<string, unknown> | undefined)?.[fn];
            if (impl) return impl;
            return () => {
              throw new Error(`unexpected DAL call ${area}.${fn}`);
            };
          },
        },
      );
    },
  });
}

/** In-memory sessions keyed by token hash. */
export class FakeSessions {
  readonly rows = new Map<
    string,
    { session: SessionRecord; userStatus: UserStatus }
  >();
  private readonly clock: AppClock;
  constructor(clock: AppClock) {
    this.clock = clock;
  }

  add(input: {
    userId: string;
    status?: SessionStatus;
    userStatus?: UserStatus;
    reauthAt?: Date | null;
    lastSeenAt?: Date;
  }): { token: string; csrf: string; session: SessionRecord } {
    const token = randomToken();
    const now = this.clock.now();
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      status: input.status ?? "active",
      csrfToken: randomToken(),
      createdAt: now,
      lastSeenAt: input.lastSeenAt ?? now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
      mfaVerifiedAt: null,
      reauthAt: input.reauthAt === undefined ? now : input.reauthAt,
      mfaFailedAttempts: 0,
      deviceBrowser: "chrome",
      deviceOs: "macos",
    };
    this.rows.set(sha256(token).toString("hex"), {
      session,
      userStatus: input.userStatus ?? "active",
    });
    return { token, csrf: session.csrfToken, session };
  }

  dal() {
    return {
      findSessionByTokenHash: (h: Buffer) =>
        Promise.resolve(this.rows.get(h.toString("hex")) ?? null),
      touchSession: () => Promise.resolve(null),
      deleteSession: (id: string) => {
        for (const [k, v] of this.rows)
          if (v.session.id === id) this.rows.delete(k);
        return Promise.resolve();
      },
      createSession: (input: {
        userId: string;
        tokenHash: Buffer;
        csrfToken: string;
        status: SessionStatus;
        replacesSessionId?: string;
      }) => {
        if (input.replacesSessionId)
          for (const [k, v] of this.rows)
            if (v.session.id === input.replacesSessionId) this.rows.delete(k);
        const now = this.clock.now();
        const active = input.status === "active";
        const session: SessionRecord = {
          id: crypto.randomUUID(),
          userId: input.userId,
          status: input.status,
          csrfToken: input.csrfToken,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(
            now.getTime() + (active ? 30 * 86_400_000 : 600_000),
          ),
          absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
          mfaVerifiedAt: null,
          reauthAt: active ? now : null,
          mfaFailedAttempts: 0,
          deviceBrowser: "chrome",
          deviceOs: "macos",
        };
        this.rows.set(input.tokenHash.toString("hex"), {
          session,
          userStatus: "active",
        });
        return Promise.resolve(session);
      },
      recordSessionMfaFailure: (id: string) => {
        for (const [k, v] of this.rows)
          if (v.session.id === id) {
            const attempts = v.session.mfaFailedAttempts + 1;
            v.session = { ...v.session, mfaFailedAttempts: attempts };
            if (attempts >= 5) this.rows.delete(k);
            return Promise.resolve({ attempts, deleted: attempts >= 5 });
          }
        return Promise.resolve({ attempts: 0, deleted: true });
      },
      completeMfaSession: async (pendingId: string, next: { tokenHash: Buffer; csrfToken: string }) => {
        let pending: SessionRecord | null = null;
        for (const [k, v] of this.rows)
          if (v.session.id === pendingId && v.session.status === "mfa_pending") {
            pending = v.session;
            this.rows.delete(k);
          }
        if (!pending) return null;
        const created = await this.dal().createSession({ userId: pending.userId, tokenHash: next.tokenHash, csrfToken: next.csrfToken, status: "active" });
        const row = this.rows.get(next.tokenHash.toString("hex"));
        if (row) row.session = { ...row.session, mfaVerifiedAt: this.clock.now() };
        return row?.session ?? created;
      },
      listSessions: (userId: string) =>
        Promise.resolve(
          [...this.rows.values()]
            .filter((v) => v.session.userId === userId && v.session.status === "active")
            .map((v) => ({ id: v.session.id, browser: v.session.deviceBrowser, os: v.session.deviceOs, createdAt: v.session.createdAt, lastSeenAt: v.session.lastSeenAt, expiresAt: v.session.expiresAt })),
        ),
      revokeSession: (userId: string, id: string) => {
        for (const [k, v] of this.rows)
          if (v.session.id === id && v.session.userId === userId) {
            this.rows.delete(k);
            return Promise.resolve();
          }
        return Promise.reject(new DalError("NOT_FOUND"));
      },
      revokeOtherSessions: (userId: string, keep: string) => {
        let n = 0;
        for (const [k, v] of this.rows)
          if (v.session.userId === userId && v.session.id !== keep) {
            this.rows.delete(k);
            n++;
          }
        return Promise.resolve({ revokedSessions: n });
      },
      markReauthenticated: (id: string) => {
        for (const v of this.rows.values())
          if (v.session.id === id)
            v.session = { ...v.session, reauthAt: this.clock.now() };
        return Promise.resolve();
      },
    };
  }
}

/** In-memory auth_throttles. */
export function fakeThrottles() {
  const rows = new Map<string, number>();
  const id = (k: ThrottleKey, w: Date) =>
    `${k.scope}|${k.keyHash.toString("hex")}|${w.getTime()}`;
  return {
    rows,
    dal: {
      hitThrottle: (k: ThrottleKey, w: Date, by = 1) => {
        const n = (rows.get(id(k, w)) ?? 0) + by;
        rows.set(id(k, w), n);
        return Promise.resolve(n);
      },
      sumThrottle: (k: ThrottleKey, since: Date) => {
        let n = 0;
        const prefix = `${k.scope}|${k.keyHash.toString("hex")}|`;
        for (const [key, v] of rows)
          if (
            key.startsWith(prefix) &&
            Number(key.slice(prefix.length)) >= since.getTime()
          )
            n += v;
        return Promise.resolve(n);
      },
      clearThrottle: (k: ThrottleKey) => {
        const prefix = `${k.scope}|${k.keyHash.toString("hex")}|`;
        for (const key of [...rows.keys()])
          if (key.startsWith(prefix)) rows.delete(key);
        return Promise.resolve();
      },
    },
  };
}

/** Fast stand-in for argon2: hash(p) = "h:" + p. */
export function fakePasswords(
  breached: readonly string[] = [],
): PasswordService {
  const verified: string[] = [];
  return {
    verified,
    hash: (p: string) => Promise.resolve(`h:${p}`),
    verify: (h: string, p: string) => {
      verified.push(p);
      return Promise.resolve(h === `h:${p}`);
    },
    verifyDummy: (p: string) => {
      verified.push(p);
      return Promise.resolve(false as const);
    },
    needsRehash: (h: string) => !h.startsWith("h:"),
    isBreached: (p: string) => Promise.resolve(breached.includes(p)),
    assertAcceptable: async () => {},
  } as unknown as PasswordService;
}

export function me(id: string, extra: Partial<MeRecord> = {}): MeRecord {
  return {
    id,
    email: `${id.slice(0, 4)}@example.test`,
    displayName: "Pat",
    status: "active",
    createdAt: T0,
    mfa: {
      enabled: false,
      totp: false,
      passkeyCount: 0,
      recoveryCodesRemaining: 0,
    },
    deletion: null,
    ...extra,
  };
}

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  clock: AppClock;
  outbox: Outbox;
  sessions: FakeSessions;
  /** In-memory dal.mfa (always present; explicit dal.mfa overrides win). */
  mfa: FakeMfa;
  throttles: ReturnType<typeof fakeThrottles>;
  events: SecurityEventInput[];
  logs: Record<string, unknown>[];
  sleeps: number[];
  wall: { now: number };
  /** Sends a request as a browser on APP_ORIGIN would (Host and, for unsafe methods, Origin). */
  req(
    method: InjectOptions["method"],
    url: string,
    opts?: {
      body?: unknown;
      auth?: { token: string; csrf: string };
      headers?: Record<string, string>;
    },
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  dal?: DalOverrides;
  env?: Record<string, string>;
  routes?: readonly Route[];
  passwords?: PasswordService;
}

export async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig(testEnv(o.env));
  const clock = createAppClock();
  clock.freeze(T0);
  const logs: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString("utf8").split("\n"))
        if (line) logs.push(JSON.parse(line) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({ ...config, logLevel: "info" }, stream);
  const sessions = new FakeSessions(clock);
  const throttles = fakeThrottles();
  const events: SecurityEventInput[] = [];
  const base = o.dal ?? {};
  const mfa = new FakeMfa(clock);
  const dal = strictDal({
    ...base,
    sessions: { ...sessions.dal(), ...(base.sessions ?? {}) },
    mfa: { ...mfa.dal(), ...(base.mfa ?? {}) },
    throttles: { ...throttles.dal, ...(base.throttles ?? {}) },
    securityEvents: {
      recordSecurityEvent: (e: SecurityEventInput) => {
        events.push(e);
        return Promise.resolve();
      },
      ...(base.securityEvents ?? {}),
    },
  });
  const outbox = new Outbox(() => clock.now());
  const wall = { now: 1_000_000 };
  const sleeps: number[] = [];
  const deps = createDeps(config, logger, {
    dal,
    clock,
    transport: outbox,
    passwords: o.passwords ?? fakePasswords(),
    wallNow: () => wall.now,
    sleep: (ms) => {
      sleeps.push(ms);
      wall.now += ms;
      return Promise.resolve();
    },
  });
  const app = await buildApp(deps, o.routes ? { routes: o.routes } : {});
  await app.ready();
  const SAFE = new Set(["GET", "HEAD"]);
  return {
    app,
    deps,
    clock,
    outbox,
    sessions,
    mfa,
    throttles,
    events,
    logs,
    sleeps,
    wall,
    req(method, url, opts = {}) {
      const headers: Record<string, string> = { host: HOST };
      if (!SAFE.has(String(method))) headers.origin = ORIGIN;
      if (opts.auth) {
        headers.cookie = `__Host-ss_sid=${opts.auth.token}`;
        headers["x-csrf-token"] = opts.auth.csrf;
      }
      Object.assign(headers, opts.headers ?? {});
      for (const [k, v] of Object.entries(headers))
        if (v === "") Reflect.deleteProperty(headers, k);
      return app.inject({
        method,
        url,
        headers,
        ...(opts.body !== undefined
          ? {
              payload: JSON.stringify(opts.body),
              headers: { ...headers, "content-type": "application/json" },
            }
          : {}),
      });
    },
    close: () => app.close(),
  };
}

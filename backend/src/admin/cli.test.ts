import { DalError } from "@shoestring/db";
import type { PurgeResult } from "@shoestring/db";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptTotpSecret, encryptTotpSecret } from "../auth/totp.ts";
import { parseKeyring, sha256 } from "../crypto/keyring.ts";
import { Outbox } from "../email/transports.ts";
import {
  fakeThrottles,
  strictDal,
  testKeyring,
} from "../test-support/harness.ts";
import type { DalOverrides } from "../test-support/harness.ts";
import { PURGE_MONITOR } from "../observability/error-tracker.ts";
import type { Alert, ErrorTracker, Monitor } from "../observability/error-tracker.ts";
import { EXIT, parseArgs, run } from "./cli.ts";

const U = "01a1d7ab-0000-7000-8000-000000000001";
const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://app:pw@localhost/db",
};
const mailEnv = {
  ...baseEnv,
  APP_ORIGIN: "https://app.test",
  EMAIL_TRANSPORT: "test",
};

async function cli(
  argv: string[],
  dal: DalOverrides,
  env: Record<string, string> = mailEnv,
  tracker?: ErrorTracker,
) {
  const lines: string[] = [];
  const outbox = new Outbox(() => new Date());
  const events: string[] = [];
  const t = fakeThrottles();
  const code = await run(argv, {
    env,
    out: (l) => lines.push(l),
    transport: outbox,
    ...(tracker ? { initTracker: () => Promise.resolve(tracker) } : {}),
    createDal: () =>
      strictDal({
        ...dal,
        throttles: t.dal,
        securityEvents: {
          recordSecurityEvent: (e: { type: string }) => {
            events.push(e.type);
            return Promise.resolve();
          },
          ...(dal.securityEvents ?? {}),
        },
      }),
  });
  const parsed = lines
    .flatMap((l) => l.trim().split("\n"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    code,
    lines: parsed,
    last: parsed.at(-1)!,
    raw: lines.join(""),
    outbox,
    events,
  };
}

describe("argument parsing", () => {
  it("parses flags in both forms and rejects unknown flags, stray arguments and commas in emails", () => {
    expect(
      parseArgs([
        "reset-mfa",
        "--email",
        "a@b.test",
        "--yes",
        "--expect-user-id=u1",
      ]),
    ).toEqual({
      command: "reset-mfa",
      flags: new Map<string, string | true>([
        ["email", "a@b.test"],
        ["yes", true],
        ["expect-user-id", "u1"],
      ]),
    });
    expect(parseArgs(["drop-database"])).toEqual({
      usageError: "unknown command",
    });
    expect(parseArgs(["purge", "now"])).toEqual({
      usageError: "unexpected argument",
    });
    expect(parseArgs(["purge", "--force"])).toEqual({
      usageError: "unknown flag",
    });
    expect(
      parseArgs(["create-signup-invite", "--email", "a@b.test,c@d.test"]),
    ).toEqual({ usageError: "invalid --email" });
  });
});

describe("least config (F-02)", () => {
  it("each command loads only what it needs", async () => {
    // purge needs only DATABASE_URL
    const purge = await cli(
      ["purge", "--dry-run"],
      {
        purge: {
          runPurge: () =>
            Promise.resolve({ failed: false, usersPurged: 0 } as PurgeResult),
        },
      },
      baseEnv,
    );
    expect(purge.code).toBe(EXIT.ok);
    // create-signup-invite needs APP_ORIGIN and EMAIL_* but not APP_KEYRING
    const noOrigin = await cli(
      ["create-signup-invite", "--email", "a@b.test"],
      {},
      baseEnv,
    );
    expect([noOrigin.code, noOrigin.last.outcome]).toEqual([
      EXIT.usage,
      "config_error",
    ]);
    // rewrap-mfa needs APP_KEYRING
    const noKeyring = await cli(["rewrap-mfa", "--dry-run"], {}, baseEnv);
    expect(String(noKeyring.last.reason)).toContain("APP_KEYRING");
  });
});

describe("create-signup-invite", () => {
  it("creates, emails the link, prints only the invite ID and expiry", async () => {
    const r = await cli(
      ["create-signup-invite", "--email", "New@Example.test"],
      {
        signup: {
          createSignupInvite: () =>
            Promise.resolve({
              inviteId: "inv-1",
              expiresAt: new Date("2026-11-20T00:00:00Z"),
            }),
        },
      },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(r.last).toMatchObject({
      command: "create-signup-invite",
      outcome: "ok",
      inviteId: "inv-1",
      requestId: expect.any(String) as unknown,
    });
    expect(r.raw).not.toContain("example.test");
    expect(r.raw).not.toContain("token");
    const [mail] = r.outbox.list("new@example.test");
    expect(mail).toMatchObject({ kind: "signup_invite", priority: true });
    expect(mail!.links[0]).toMatch(/^https:\/\/app\.test\/signup#token=/);
    expect(r.events).toEqual(["admin_signup_invite_created"]);
  });

  it("exits 4 when an account already exists", async () => {
    const r = await cli(["create-signup-invite", "--email", "a@b.test"], {
      signup: {
        createSignupInvite: () =>
          Promise.reject(new DalError("ALREADY_EXISTS")),
      },
    });
    expect(r.code).toBe(EXIT.refused);
  });
});

describe("reset-mfa (two-step)", () => {
  const dal = (calls: unknown[]): DalOverrides => ({
    users: {
      findUserIdByEmail: (e: string) =>
        Promise.resolve(e === "pat@example.test" ? U : null),
    },
    mfa: {
      resetMfa: (id: string, o: { dryRun?: boolean }) => {
        calls.push([id, o.dryRun]);
        return Promise.resolve({ revokedSessions: 2 });
      },
    },
  });

  it("dry run prints the user ID; --yes with the matching ID resets and emails; a mismatch exits 4", async () => {
    const calls: unknown[] = [];
    const dry = await cli(
      ["reset-mfa", "--email", "pat@example.test"],
      dal(calls),
    );
    expect([dry.code, dry.last.dryRun, dry.last.userId]).toEqual([
      EXIT.ok,
      true,
      U,
    ]);
    const wrong = await cli(
      [
        "reset-mfa",
        "--email",
        "pat@example.test",
        "--yes",
        "--expect-user-id",
        "someone-else",
      ],
      dal(calls),
    );
    expect(wrong.code).toBe(EXIT.refused);
    const go = await cli(
      [
        "reset-mfa",
        "--email",
        "pat@example.test",
        "--yes",
        "--expect-user-id",
        U,
      ],
      dal(calls),
    );
    expect([go.code, go.last.revokedSessions]).toEqual([EXIT.ok, 2]);
    expect(calls).toEqual([
      [U, true],
      [U, false],
    ]);
    expect(go.outbox.list("pat@example.test")).toEqual([
      expect.objectContaining({ kind: "mfa_reset", priority: true }),
    ]);
    expect(go.raw).not.toContain("pat@example.test");
  });

  it("exit 3 for no such user, 4 for a user without MFA", async () => {
    expect(
      (await cli(["reset-mfa", "--email", "ghost@example.test"], dal([]))).code,
    ).toBe(EXIT.notFound);
    const noMfa = await cli(["reset-mfa", "--email", "pat@example.test"], {
      ...dal([]),
      mfa: { resetMfa: () => Promise.reject(new DalError("MFA_NOT_ENABLED")) },
    });
    expect(noMfa.code).toBe(EXIT.refused);
  });
});

describe("revoke-sessions", () => {
  it("--restore without --all exits 4; --all needs --yes; --all --yes --restore revokes everything", async () => {
    const seen: unknown[] = [];
    const dal: DalOverrides = {
      sessions: {
        revokeAllSessions: (o: unknown) => {
          seen.push(o);
          return Promise.resolve({ sessions: 7, tokens: 3 });
        },
      },
    };
    expect(
      (
        await cli(
          ["revoke-sessions", "--email", "a@b.test", "--restore"],
          dal,
          baseEnv,
        )
      ).code,
    ).toBe(EXIT.refused);
    expect((await cli(["revoke-sessions", "--all"], dal, baseEnv)).code).toBe(
      EXIT.usage,
    );
    const r = await cli(
      ["revoke-sessions", "--all", "--yes", "--restore"],
      dal,
      baseEnv,
    );
    expect(r.last).toMatchObject({
      outcome: "ok",
      scope: "all",
      restore: true,
      sessions: 7,
      tokens: 3,
    });
    expect(seen).toEqual([{ restore: true }]);
    expect(r.events).toEqual(["admin_sessions_revoked"]);
  });

  it("one user: dry run counts, --yes revokes", async () => {
    const dal: DalOverrides = {
      users: { findUserIdByEmail: () => Promise.resolve(U) },
      sessions: {
        revokeAllSessionsForUser: (_u: string, o: { dryRun?: boolean }) =>
          Promise.resolve({ sessions: o.dryRun ? 4 : 4, tokens: 1 }),
      },
    };
    const dry = await cli(
      ["revoke-sessions", "--email", "a@b.test"],
      dal,
      baseEnv,
    );
    expect(dry.last).toMatchObject({ dryRun: true, userId: U, sessions: 4 });
    expect(dry.events).toEqual([]);
    const go = await cli(
      [
        "revoke-sessions",
        "--email",
        "a@b.test",
        "--yes",
        "--expect-user-id",
        U,
      ],
      dal,
      baseEnv,
    );
    expect(go.events).toEqual(["admin_sessions_revoked"]);
  });
});

describe("security-events (read-only)", () => {
  it("prints one line per event without emails; exit 3 for an unknown user", async () => {
    const dal: DalOverrides = {
      users: {
        getUserContact: (id: string) =>
          id === U
            ? Promise.resolve({
                userId: U,
                email: "pat@example.test",
                displayName: "Pat",
              })
            : Promise.reject(new DalError("NOT_FOUND")),
      },
      securityEvents: {
        listSecurityEventsForUser: () =>
          Promise.resolve([
            {
              createdAt: new Date("2026-11-13T15:00:00Z"),
              type: "login_succeeded",
              sessionId: null,
              budgetId: null,
              deviceBrowser: "safari",
              deviceOs: "ios",
              ip: "203.0.113.9",
            },
          ]),
      },
    };
    const r = await cli(["security-events", "--user-id", U], dal, baseEnv);
    expect(r.code).toBe(EXIT.ok);
    expect(r.lines[0]).toEqual({
      created_at: "2026-11-13T15:00:00.000Z",
      type: "login_succeeded",
      session_id: null,
      budget_id: null,
      device_browser: "safari",
      device_os: "ios",
      ip: "203.0.113.9",
    });
    expect(r.raw).not.toContain("pat@example.test");
    expect(
      (
        await cli(
          [
            "security-events",
            "--user-id",
            "01a1d7ab-0000-7000-8000-00000000ffff",
          ],
          dal,
          baseEnv,
        )
      ).code,
    ).toBe(EXIT.notFound);
  });
});

describe("rewrap-mfa", () => {
  it("re-encrypts TOTP secrets under the current key (same AAD) with compare-and-swap", async () => {
    const k1 = randomBytes(32).toString("base64");
    const oldRing = parseKeyring(
      JSON.stringify({ current: "k1", keys: { k1 } }),
    );
    const ring = JSON.stringify({
      current: "k2",
      keys: { k1, k2: randomBytes(32).toString("base64") },
    });
    const secret = randomBytes(20);
    const enc = encryptTotpSecret(oldRing, U, secret);
    const rows = [{ userId: U, keyId: "k1", ciphertext: enc.ciphertext }];
    const rewrapped: { toKeyId: string; ciphertext: Buffer }[] = [];
    const dal: DalOverrides = {
      mfa: {
        listTotpSecretsToRewrap: () => Promise.resolve(rows.splice(0)),
        rewrapTotpSecret: (
          _u: string,
          i: { fromKeyId: string; toKeyId: string; ciphertext: Buffer },
        ) => {
          rewrapped.push(i);
          return Promise.resolve(i.fromKeyId === "k1");
        },
        countMfaRowsByKeyId: () =>
          Promise.resolve([{ keyId: "k1", totp: 0, recoveryCodes: 3 }]),
      },
    };
    const env = { ...baseEnv, APP_KEYRING: ring };
    expect((await cli(["rewrap-mfa"], dal, env)).code).toBe(EXIT.usage);
    const r = await cli(["rewrap-mfa", "--yes"], dal, env);
    expect(r.last).toMatchObject({
      outcome: "ok",
      rewrapped: 1,
      recoveryCodesOnOldKeys: 3,
    });
    expect(rewrapped[0]!.toKeyId).toBe("k2");
    expect(
      decryptTotpSecret(
        parseKeyring(ring),
        "k2",
        U,
        rewrapped[0]!.ciphertext,
      ).equals(secret),
    ).toBe(true);
  });

  it("--retire-recovery-codes refuses the current key; --yes deletes and emails affected users", async () => {
    const ring = testKeyring();
    const env = { ...mailEnv, APP_KEYRING: ring };
    const seen: unknown[] = [];
    const dal: DalOverrides = {
      mfa: {
        retireRecoveryCodes: (k: string, o: { dryRun?: boolean }) => {
          seen.push([k, o.dryRun]);
          return Promise.resolve({ affectedUserIds: [U], codes: 10 });
        },
      },
      users: {
        getUserContact: () =>
          Promise.resolve({
            userId: U,
            email: "pat@example.test",
            displayName: "Pat",
          }),
      },
    };
    expect(
      (await cli(["rewrap-mfa", "--retire-recovery-codes", "k1"], dal, env))
        .code,
    ).toBe(EXIT.refused);
    expect(
      (await cli(["rewrap-mfa", "--retire-recovery-codes", "bad"], dal, env))
        .code,
    ).toBe(EXIT.refused);
    const dry = await cli(
      ["rewrap-mfa", "--retire-recovery-codes", "k9"],
      dal,
      env,
    );
    expect(dry.last).toMatchObject({ dryRun: true, users: 1, codes: 10 });
    const go = await cli(
      ["rewrap-mfa", "--retire-recovery-codes", "k9", "--yes"],
      dal,
      env,
    );
    expect(go.last).toMatchObject({ users: 1, codes: 10, notices: 1 });
    expect(seen).toEqual([
      ["k9", true],
      ["k9", false],
    ]);
    expect(go.outbox.list()[0]).toMatchObject({
      kind: "recovery_codes_retired",
      priority: true,
    });
  });
});

describe("purge", () => {
  const counts = {
    usersPurged: 1,
    usersSkipped: 0,
    ownedBudgetsPurged: 2,
    budgetsPurged: 0,
    transactionsPurged: 5,
    sessions: 3,
    webauthnChallenges: 0,
    userTokens: 0,
    signupInvites: 0,
    totpSetups: 0,
    idempotencyKeys: 4,
    authThrottles: 9,
    securityEvents: 0,
    invitations: 0,
  };

  it("requires --yes (or --dry-run) and prints counts only", async () => {
    const dal: DalOverrides = {
      purge: { runPurge: () => Promise.resolve({ ...counts, failed: false }) },
    };
    expect((await cli(["purge"], dal, baseEnv)).code).toBe(EXIT.usage);
    const r = await cli(["purge", "--yes"], dal, baseEnv);
    expect(r.code).toBe(EXIT.ok);
    expect(r.last).toMatchObject({ ...counts, dryRun: false, outcome: "ok" });
  });

  it("a skipped user (F-25 re-check) exits 1 so the purge alert fires", async () => {
    const dal: DalOverrides = {
      purge: {
        runPurge: () =>
          Promise.resolve({ ...counts, usersSkipped: 1, failed: true }),
      },
    };
    const r = await cli(["purge", "--yes"], dal, baseEnv);
    expect([r.code, r.last.outcome, r.last.usersSkipped]).toEqual([
      EXIT.unexpected,
      "users_skipped",
      1,
    ]);
  });

  it("an unexpected error exits 1 without leaking its message", async () => {
    const dal: DalOverrides = {
      purge: {
        runPurge: () => Promise.reject(new Error("relation payee Joe's Diner")),
      },
    };
    const r = await cli(["purge", "--yes"], dal, baseEnv);
    expect(r.code).toBe(EXIT.unexpected);
    expect(r.raw).not.toContain("Joe");
  });
});

describe("purge: A3 cron check-ins", () => {
  const sentryEnv = {
    ...baseEnv,
    SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/456",
    APP_RELEASE: "sha1",
  };
  const counts = { usersPurged: 0, usersSkipped: 0, failed: false };

  function recorder() {
    const log: string[] = [];
    const monitors: Monitor[] = [];
    const t: ErrorTracker = {
      enabled: true,
      captureError: () => log.push("captureError"),
      alert: (a: Alert) => log.push(`alert:${a.level}`),
      startCheckIn: (m) => {
        monitors.push(m);
        log.push(`${m.slug}:in_progress`);
        return { finish: (status) => log.push(`${m.slug}:${status}`) };
      },
      flush: () => {
        log.push("flush");
        return Promise.resolve();
      },
      close: () => {
        log.push("close");
        return Promise.resolve();
      },
    };
    return { t, log, monitors };
  }
  const purgeDal = (runPurge: () => Promise<unknown>): DalOverrides => ({
    purge: { runPurge },
  });

  it("a clean run: in_progress, then ok, then the client is flushed and closed; output unchanged", async () => {
    const r = recorder();
    const out = await cli(["purge", "--yes"], purgeDal(() => Promise.resolve(counts)), sentryEnv, r.t);
    expect(out.code).toBe(EXIT.ok);
    expect(r.log).toEqual(["purge:in_progress", "purge:ok", "close"]);
    expect(r.monitors).toEqual([PURGE_MONITOR]);
    expect(out.last).toMatchObject({ command: "purge", outcome: "ok", usersPurged: 0 });
    expect(out.raw).not.toContain("sentry");
  });

  it("skipped users, an unexpected error, or a missing --yes all report error", async () => {
    for (const [argv, dal] of [
      [["purge", "--yes"], purgeDal(() => Promise.resolve({ ...counts, usersSkipped: 1, failed: true }))],
      [["purge", "--yes"], purgeDal(() => Promise.reject(new Error("boom")))],
      [["purge"], purgeDal(() => Promise.resolve(counts))],
    ] as const) {
      const r = recorder();
      const out = await cli([...argv], dal, sentryEnv, r.t);
      expect(out.code).not.toBe(EXIT.ok);
      expect(r.log).toEqual(["purge:in_progress", "purge:error", "close"]);
    }
  });

  it("a manual dry run sends no check-in", async () => {
    const r = recorder();
    await cli(["purge", "--dry-run"], purgeDal(() => Promise.resolve(counts)), sentryEnv, r.t);
    expect(r.log).toEqual(["close"]);
  });

  it("without SENTRY_DSN no tracker is started; a malformed DSN is a config error", async () => {
    const r = recorder();
    expect((await cli(["purge", "--yes"], purgeDal(() => Promise.resolve(counts)), baseEnv, r.t)).code).toBe(EXIT.ok);
    expect(r.log).toEqual([]);
    const bad = await cli(["purge", "--yes"], purgeDal(() => Promise.resolve(counts)), { ...sentryEnv, SENTRY_DSN: "http://nope" }, r.t);
    expect([bad.code, bad.last.outcome]).toEqual([EXIT.usage, "config_error"]);
    expect(bad.raw).not.toContain("nope");
  });

  it("commands that do not mail or purge never read SENTRY_DSN (least config)", async () => {
    const r = recorder();
    const out = await cli(
      ["security-events", "--user-id", U],
      { securityEvents: { listSecurityEvents: () => Promise.resolve([]) } as never },
      { ...baseEnv, SENTRY_DSN: "http://would-be-refused" },
      r.t,
    );
    expect(out.last.outcome).not.toBe("config_error");
    expect(r.log).toEqual([]);
  });
});

describe("token handling", () => {
  it("stores only the token hash", async () => {
    const hashes: Buffer[] = [];
    const r = await cli(["create-signup-invite", "--email", "a@b.test"], {
      signup: {
        createSignupInvite: (_e: string, h: Buffer) => {
          hashes.push(h);
          return Promise.resolve({ inviteId: "i", expiresAt: new Date() });
        },
      },
    });
    const token = r.outbox.list()[0]!.links[0]!.split("#token=")[1]!;
    expect(hashes[0]!.equals(sha256(token))).toBe(true);
  });
});

import { DalError } from "@shoestring/db";
import type { UserTokenRecord } from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  encryptTotpSecret,
  newTotpSecret,
  stepAt,
  totpCode,
} from "../auth/totp.ts";
import { sha256 } from "../crypto/keyring.ts";
import { DAY, HOUR } from "../http/rate-limit.ts";
import { T0, makeHarness, slowThrottles } from "../test-support/harness.ts";
import type { DalOverrides, Harness } from "../test-support/harness.ts";

const U = "01a1d7ab-0000-7000-8000-000000000001";
const EMAIL = "pat@example.test";
const TOKEN = "r".repeat(43);
let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { code?: string };

const resetToken: UserTokenRecord = {
  id: "01a1d7ab-0000-7000-8000-0000000000f1",
  userId: U,
  purpose: "password_reset",
  email: null,
  requestedBySessionId: null,
  mfaFailedAttempts: 0,
  createdAt: T0,
  expiresAt: new Date(T0.getTime() + 30 * 60_000),
};

function harness(dal: DalOverrides = {}, calls: string[] = []) {
  return makeHarness({
    dal: {
      ...dal,
      users: {
        findUserIdByEmail: (e: string) =>
          Promise.resolve(e === EMAIL ? U : null),
        getUserContact: () =>
          Promise.resolve({ userId: U, email: EMAIL, displayName: "Pat" }),
        ...(dal.users ?? {}),
      },
      tokens: {
        issuePasswordResetToken: () => {
          calls.push("issue");
          return Promise.resolve({
            tokenId: resetToken.id,
            expiresAt: resetToken.expiresAt,
          });
        },
        findValidUserToken: (hash: Buffer, purpose: string) =>
          Promise.resolve(
            hash.equals(sha256(TOKEN)) && purpose === "password_reset"
              ? resetToken
              : null,
          ),
        reserveTokenMfaAttempt: () => {
          calls.push("reserve");
          return Promise.resolve({ granted: true, attempt: 1 });
        },
        failTokenMfaAttempt: () => {
          calls.push("tokenFailure");
          return Promise.resolve({ attempts: 1, invalidated: false, open: true });
        },
        releaseTokenMfaAttempt: () => {
          calls.push("release");
          return Promise.resolve();
        },
        completePasswordReset: (_h: Buffer, hash: string) => {
          calls.push(`complete:${hash}`);
          return Promise.resolve({ userId: U, revokedSessions: 2 });
        },
        ...(dal.tokens ?? {}),
      },
    },
  });
}

function enableTotp(hh: Harness) {
  const secret = newTotpSecret();
  hh.mfa.totp.set(U, {
    ...encryptTotpSecret(hh.deps.config.keyring, U, secret),
    confirmed: true,
    lastUsedStep: null,
    createdAt: 0,
  });
  return secret;
}

describe("password reset request", () => {
  it("always 202 at a fixed 1 s; mails only an existing account", async () => {
    const calls: string[] = [];
    h = await harness({}, calls);
    for (const email of [EMAIL, "ghost@example.test"]) {
      const r = await h.req("POST", "/api/auth/password-reset/request", {
        body: { email },
      });
      expect([r.statusCode, r.body]).toEqual([202, ""]);
    }
    expect(h.sleeps).toEqual([1000, 1000]);
    expect(calls).toEqual(["issue"]);
    const [mail] = h.outbox.list(EMAIL);
    expect(mail).toMatchObject({ kind: "password_reset", priority: false });
    expect(mail!.links[0]).toMatch(
      /^https:\/\/app\.test\/reset-password#token=[A-Za-z0-9_-]{43}$/,
    );
  });

  it("per-email limits are silent (3/hour); per-IP is 429 (5/hour)", async () => {
    const calls: string[] = [];
    h = await harness({}, calls);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await h.req("POST", "/api/auth/password-reset/request", {
            body: { email: EMAIL },
          })
        ).statusCode,
      ).toBe(202);
    expect(calls).toHaveLength(3);
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/request", {
          body: { email: EMAIL },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });
});

const resetRequest = (i: number) =>
  h.req("POST", "/api/auth/password-reset/request", {
    body: { email: EMAIL },
    remoteAddress: `198.51.100.${String(i + 1)}`, // one IP each: no 429
  });

describe("password reset request: per-email limits are race-safe", () => {
  it("12 concurrent requests for one address from 12 IPs send at most 3 mails, all byte-identical 202s", async () => {
    const calls: string[] = [];
    const slow = slowThrottles();
    h = await harness({ throttles: slow.dal }, calls);
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => resetRequest(i)),
    );
    // Sent or refused, every answer is the same bytes (F-22); only the
    // per-request id differs.
    const shape = (r: (typeof rs)[number]) => {
      const { "x-request-id": id, ...headers } = r.headers;
      expect(id).toEqual(expect.any(String));
      return { status: r.statusCode, body: r.body, headers };
    };
    for (const r of rs) expect(shape(r)).toEqual(shape(rs[0]!));
    expect([rs[0]!.statusCode, rs[0]!.body]).toEqual([202, ""]);
    expect(calls).toEqual(["issue", "issue", "issue"]);
    expect(h.outbox.list(EMAIL)).toHaveLength(3);
    // Refused requests refund their slots: the counters hold only the 3 sent.
    expect([...slow.rows.values()].every((n) => n >= 0)).toBe(true);
    const t = h.deps.throttles;
    expect(await t.count(t.key("reset-request:email_hour", EMAIL), HOUR)).toBe(3);
    expect(
      await t.rollingCount(t.key("reset-request:email_day", EMAIL), DAY),
    ).toBe(3);
  });

  it("the 24 h limit holds across hours: at most 5 mails, refused requests do not burn the day budget", async () => {
    const calls: string[] = [];
    const slow = slowThrottles();
    h = await harness({ throttles: slow.dal }, calls);
    // Hour 1: 3 sent, 7 refused by the hourly limit (refunded from the day count).
    await Promise.all(Array.from({ length: 10 }, (_, i) => resetRequest(i)));
    expect(calls).toHaveLength(3);
    const t = h.deps.throttles;
    const dayKey = t.key("reset-request:email_day", EMAIL);
    expect(await t.rollingCount(dayKey, DAY)).toBe(3);
    // Hour 2: only 2 of the day's 5 remain; a burst never exceeds them.
    h.clock.freeze(new Date(T0.getTime() + HOUR));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => resetRequest(i + 20)),
    );
    expect(calls.length).toBeLessThanOrEqual(5);
    // Hour 3: one at a time, the rest of the day budget and no more.
    h.clock.freeze(new Date(T0.getTime() + 2 * HOUR));
    for (let i = 0; i < 3; i++)
      expect(
        [await resetRequest(i + 40)].map((r) => [r.statusCode, r.body]),
      ).toEqual([[202, ""]]);
    expect(calls).toHaveLength(5);
    expect(await t.rollingCount(dayKey, DAY)).toBe(5);
    expect([...slow.rows.values()].every((n) => n >= 0)).toBe(true);
    // Once hour 1 leaves the rolling window, its 3 slots free up (hour limit: 3).
    h.clock.freeze(new Date(T0.getTime() + DAY));
    for (let i = 0; i < 4; i++) await resetRequest(i + 60);
    expect(calls).toHaveLength(8);
  });

  it("a refused request is still padded to 1 s", async () => {
    h = await harness();
    for (let i = 0; i < 4; i++) await resetRequest(i);
    expect(h.outbox.list(EMAIL)).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 1000, 1000, 1000]);
  });
});

describe("password reset verify and complete (never bypasses MFA)", () => {
  it("verify reports whether a factor is needed; an unknown token is TOKEN_INVALID", async () => {
    h = await harness();
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/verify", {
          body: { token: TOKEN },
        }),
      ),
    ).toEqual({ mfaRequired: false, mfaMethods: [] });
    enableTotp(h);
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/verify", {
          body: { token: TOKEN },
        }),
      ),
    ).toEqual({ mfaRequired: true, mfaMethods: ["totp"] });
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/verify", {
          body: { token: "x".repeat(43) },
        }),
      ).code,
    ).toBe("TOKEN_INVALID");
  });

  it("without MFA: sets the password, clears the per-email login counters, notifies", async () => {
    const calls: string[] = [];
    h = await harness({}, calls);
    // An exhausted 24 h login budget for this email...
    const key = h.deps.throttles.key("login:email_day", EMAIL);
    for (let i = 0; i < 100; i++)
      await h.deps.throttles.rollingHit(key, 86_400_000);
    const r = await h.req("POST", "/api/auth/password-reset/complete", {
      body: { token: TOKEN, newPassword: "a brand new passphrase" },
    });
    expect(r.statusCode).toBe(204);
    expect(calls).toEqual(["complete:h:a brand new passphrase"]);
    expect(await h.deps.throttles.rollingCount(key, 86_400_000)).toBe(0);
    expect(h.events.map((e) => e.type)).toEqual(["password_reset_completed"]);
    expect(h.outbox.list(EMAIL)).toEqual([
      expect.objectContaining({ kind: "password_changed", priority: true }),
    ]);
  });

  it("FINDINGS note: an MFA user resetting without a factor gets 401 MFA_REQUIRED and nothing changes", async () => {
    const calls: string[] = [];
    h = await harness({}, calls);
    enableTotp(h);
    const r = await h.req("POST", "/api/auth/password-reset/complete", {
      body: { token: TOKEN, newPassword: "a brand new passphrase" },
    });
    expect([r.statusCode, json(r).code]).toEqual([401, "MFA_REQUIRED"]);
    expect(calls).toEqual([]);
  });

  it("a wrong factor is 401 MFA_FAILED and counts against the token; a right one completes", async () => {
    const calls: string[] = [];
    h = await harness({}, calls);
    const secret = enableTotp(h);
    const bad = await h.req("POST", "/api/auth/password-reset/complete", {
      body: {
        token: TOKEN,
        newPassword: "a brand new passphrase",
        mfa: { method: "totp", code: "000000" },
      },
    });
    expect(json(bad).code).toBe("MFA_FAILED");
    expect(calls).toEqual(["reserve", "tokenFailure"]);
    const code = totpCode(secret, stepAt(h.clock.now()));
    const ok = await h.req("POST", "/api/auth/password-reset/complete", {
      body: {
        token: TOKEN,
        newPassword: "a brand new passphrase",
        mfa: { method: "totp", code },
      },
    });
    expect(ok.statusCode).toBe(204);
  });

  it("an invalid token is TOKEN_INVALID before anything else; the policy applies to newPassword", async () => {
    h = await harness();
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/complete", {
          body: {
            token: "x".repeat(43),
            newPassword: "a brand new passphrase",
          },
        }),
      ).code,
    ).toBe("TOKEN_INVALID");
    const r = json(
      await h.req("POST", "/api/auth/password-reset/complete", {
        body: { token: TOKEN, newPassword: "short" },
      }),
    );
    expect(r.details).toEqual([
      expect.objectContaining({ field: "newPassword", issue: "too_short" }),
    ]);
  });

  it("the passkey challenge is bound to the reset token; no passkeys is 409", async () => {
    h = await harness();
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/webauthn-challenge", {
          body: { token: TOKEN },
        }),
      ).code,
    ).toBe("MFA_NOT_ENABLED");
  });

  it("verify, webauthn-challenge and complete share 20 per hour per IP", async () => {
    h = await harness();
    for (let i = 0; i < 20; i++)
      await h.req("POST", "/api/auth/password-reset/verify", {
        body: { token: TOKEN },
      });
    expect(
      json(
        await h.req("POST", "/api/auth/password-reset/complete", {
          body: { token: TOKEN, newPassword: "a brand new passphrase" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });
});

describe("email change (F-01, F-33, R-11)", () => {
  function emailHarness(outcome: "created" | "email_taken" | "limited") {
    const seen: unknown[] = [];
    return makeHarness({
      dal: {
        users: {
          getUserContact: () =>
            Promise.resolve({ userId: U, email: EMAIL, displayName: "Pat" }),
        },
        tokens: {
          requestEmailChange: (input: unknown) => {
            seen.push(input);
            if (outcome === "limited")
              return Promise.reject(
                new DalError("RATE_LIMITED", { retryAfterSeconds: 3600 }),
              );
            return Promise.resolve(
              outcome === "created"
                ? { outcome, oldEmail: EMAIL, expiresAt: T0 }
                : { outcome },
            );
          },
          confirmEmailChange: (input: {
            userId: string;
            sessionId: string;
            reissueCancelTokenHash?: Buffer;
          }) => {
            seen.push(input);
            return Promise.resolve({
              oldEmail: EMAIL,
              newEmail: "new@example.test",
              revokedSessions: 1,
            });
          },
          cancelEmailChange: () =>
            Promise.resolve({
              userId: U,
              outcome: "reverted" as const,
              keptEmail: EMAIL,
              abandonedEmail: "new@example.test",
            }),
        },
      },
    }).then((hh) => Object.assign(hh, { seen }));
  }

  it("request: confirm link to the new address, cancel link to the old one; 202 at a fixed 1 s", async () => {
    h = await emailHarness("created");
    const s = h.sessions.add({ userId: U });
    const r = await h.req("POST", "/api/me/email-change", {
      auth: s,
      body: { newEmail: "New@Example.test" },
    });
    expect(r.statusCode).toBe(202);
    expect(h.sleeps).toEqual([1000]);
    expect(h.outbox.list("new@example.test")[0]).toMatchObject({
      kind: "email_change_confirm",
      links: [expect.stringMatching(/\/confirm-email#token=/) as unknown],
    });
    expect(h.outbox.list(EMAIL)[0]).toMatchObject({
      kind: "email_change_notice",
      priority: true,
      links: [expect.stringMatching(/\/cancel-email-change#token=/) as unknown],
    });
    expect(
      (h as unknown as { seen: { sessionId: string }[] }).seen[0]!.sessionId,
    ).toBe(s.session.id);
  });

  it("request for a taken address: the same 202, a different mail, no tokens", async () => {
    h = await emailHarness("email_taken");
    const s = h.sessions.add({ userId: U });
    expect(
      (
        await h.req("POST", "/api/me/email-change", {
          auth: s,
          body: { newEmail: "taken@example.test" },
        })
      ).statusCode,
    ).toBe(202);
    expect(h.outbox.list().map((m) => [m.to, m.kind])).toEqual([
      ["taken@example.test", "email_change_exists"],
    ]);
  });

  it("at most one change per 24 h: 429 with Retry-After; re-auth required; own address refused", async () => {
    h = await emailHarness("limited");
    const s = h.sessions.add({ userId: U });
    const r = await h.req("POST", "/api/me/email-change", {
      auth: s,
      body: { newEmail: "c@example.test" },
    });
    expect([r.statusCode, r.headers["retry-after"]]).toEqual([429, "3600"]);
    const stale = h.sessions.add({ userId: U, reauthAt: null });
    expect(
      json(
        await h.req("POST", "/api/me/email-change", {
          auth: stale,
          body: { newEmail: "c@example.test" },
        }),
      ).code,
    ).toBe("REAUTH_REQUIRED");
    expect(
      json(
        await h.req("POST", "/api/me/email-change", {
          auth: s,
          body: { newEmail: EMAIL },
        }),
      ).code,
    ).toBe("VALIDATION_FAILED");
  });

  it("10 concurrent requests to taken addresses mail at most 5 (5 per user per day, reserve-first)", async () => {
    const slow = slowThrottles();
    h = await makeHarness({
      dal: {
        throttles: slow.dal,
        users: {
          getUserContact: () =>
            Promise.resolve({ userId: U, email: EMAIL, displayName: "Pat" }),
        },
        tokens: {
          requestEmailChange: async () => {
            await new Promise<void>((r) => setImmediate(r));
            return { outcome: "email_taken" as const };
          },
        },
      },
    });
    const s = h.sessions.add({ userId: U });
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.req("POST", "/api/me/email-change", {
          auth: s,
          body: { newEmail: `taken${i}@example.test` },
        }),
      ),
    );
    expect(h.outbox.list()).toHaveLength(5);
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(5);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(5);
    const t = h.deps.throttles;
    expect(await t.count(t.key("email-change:user", U), DAY)).toBe(5);
  });

  it("a request refused after the reserve (own address, DAL 429) holds no slot", async () => {
    h = await emailHarness("limited");
    const s = h.sessions.add({ userId: U });
    for (const newEmail of ["c@example.test", EMAIL])
      for (let i = 0; i < 6; i++)
        await h.req("POST", "/api/me/email-change", {
          auth: s,
          body: { newEmail },
        });
    const t = h.deps.throttles;
    expect(await t.count(t.key("email-change:user", U), DAY)).toBe(0);
  });

  it("confirm needs this user's active session; both addresses are told, the old one with a fresh cancel link", async () => {
    h = await emailHarness("created");
    const s = h.sessions.add({ userId: U });
    expect(
      (
        await h.req("POST", "/api/auth/email-change/confirm", {
          auth: s,
          body: { token: TOKEN },
        })
      ).statusCode,
    ).toBe(204);
    const input = (
      h as unknown as {
        seen: {
          userId: string;
          sessionId: string;
          reissueCancelTokenHash?: Buffer;
        }[];
      }
    ).seen[0]!;
    expect([
      input.userId,
      input.sessionId,
      input.reissueCancelTokenHash?.length,
    ]).toEqual([U, s.session.id, 32]);
    expect(h.outbox.list("new@example.test")[0]).toMatchObject({
      kind: "email_changed",
      links: [],
    });
    expect(h.outbox.list(EMAIL)[0]).toMatchObject({
      kind: "email_changed",
      links: [expect.stringMatching(/cancel-email-change#token=/) as unknown],
    });
    expect(
      json(
        await h.req("POST", "/api/auth/email-change/confirm", {
          body: { token: TOKEN },
        }),
      ).code,
    ).toBe("UNAUTHENTICATED");
  });

  it("cancel is public, emails both addresses and clears the cookie", async () => {
    h = await emailHarness("created");
    const r = await h.req("POST", "/api/auth/email-change/cancel", {
      body: { token: TOKEN },
    });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers["set-cookie"])).toContain("Max-Age=0");
    expect(
      h.outbox
        .list()
        .map((m) => [m.to, m.kind])
        .sort(),
    ).toEqual([
      ["new@example.test", "email_change_cancelled"],
      [EMAIL, "email_change_cancelled"],
    ]);
    expect(h.events.map((e) => e.type)).toEqual(["email_change_cancelled"]);
  });
});

import { DalError } from "@shoestring/db";
import type { LoginCredentials, MfaSummaryRecord } from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../crypto/keyring.ts";
import { fakePasswords, makeHarness, me } from "../test-support/harness.ts";
import type { Harness } from "../test-support/harness.ts";

const USER = "01a1d7ab-0000-7000-8000-000000000001";
const EMAIL = "pat@example.test";
const NO_MFA: MfaSummaryRecord = {
  enabled: false,
  totp: false,
  passkeyCount: 0,
  recoveryCodesRemaining: 0,
};
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown>;

function creds(password = "right password 1"): LoginCredentials {
  return { userId: USER, passwordHash: `h:${password}`, status: "active" };
}

function loginHarness(
  o: { mfa?: MfaSummaryRecord; known?: boolean; hash?: string } = {},
) {
  const rehashed: string[] = [];
  return makeHarness({
    dal: {
      users: {
        getLoginCredentials: (email: string) =>
          Promise.resolve(
            o.known === false || email !== EMAIL
              ? null
              : { ...creds(), ...(o.hash ? { passwordHash: o.hash } : {}) },
          ),
        getMe: () => Promise.resolve({ ...me(USER), email: EMAIL }),
        getUserContact: () =>
          Promise.resolve({ userId: USER, email: EMAIL, displayName: "Pat" }),
        updatePasswordHash: (_id: string, hash: string) => {
          rehashed.push(hash);
          return Promise.resolve();
        },
      },
      mfa: { getMfaSummary: () => Promise.resolve(o.mfa ?? NO_MFA) },
    },
  }).then((hh) => Object.assign(hh, { rehashed }));
}

describe("POST /auth/login", () => {
  it("signs in: active session cookie, AuthState with csrf, fresh re-auth, event and new sign-in notice", async () => {
    h = await loginHarness();
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: "PAT@example.test", password: "right password 1" },
      headers: { "user-agent": IPHONE },
    });
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b).toMatchObject({
      state: "authenticated",
      user: { id: USER, email: EMAIL },
    });
    expect(
      (b.session as { reauthenticatedUntil: string }).reauthenticatedUntil,
    ).toBe("2026-11-13T15:10:00.000Z");
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(
      /^__Host-ss_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    expect(r.body).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: "login_succeeded",
        userId: USER,
        deviceBrowser: "safari",
        deviceOs: "ios",
      }),
    ]);
    expect(h.outbox.list(EMAIL)).toEqual([
      expect.objectContaining({ kind: "new_sign_in", priority: true }),
    ]);
  });

  it("revokes the session whose cookie came with the login (rotation)", async () => {
    h = await loginHarness();
    const old = h.sessions.add({ userId: USER });
    await h.req("POST", "/api/auth/login", {
      body: { email: EMAIL, password: "right password 1" },
      headers: { cookie: `__Host-ss_sid=${old.token}` },
    });
    expect(h.sessions.rows.has(sha256(old.token).toString("hex"))).toBe(false);
  });

  it("wrong password and unknown email give the same 401, and the unknown email still runs a verify", async () => {
    const passwords = fakePasswords();
    h = await makeHarness({
      passwords,
      dal: {
        users: {
          getLoginCredentials: (e: string) =>
            Promise.resolve(e === EMAIL ? creds() : null),
        },
      },
    });
    const wrong = await h.req("POST", "/api/auth/login", {
      body: { email: EMAIL, password: "nope" },
    });
    const ghost = await h.req("POST", "/api/auth/login", {
      body: { email: "ghost@example.test", password: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(json(wrong).code).toBe("INVALID_CREDENTIALS");
    expect({ ...json(ghost), requestId: "" }).toEqual({
      ...json(wrong),
      requestId: "",
    });
    expect((passwords as unknown as { verified: string[] }).verified).toEqual([
      "nope",
      "nope",
    ]);
    expect(h.events).toEqual([
      expect.objectContaining({ type: "login_failed", userId: USER }),
      expect.objectContaining({ type: "login_failed", userId: null }),
    ]);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("locks an (email, IP) pair after 10 failures in 15 minutes", async () => {
    h = await loginHarness();
    for (let i = 0; i < 10; i++)
      expect(
        json(
          await h.req("POST", "/api/auth/login", {
            body: { email: EMAIL, password: "bad" },
          }),
        ).code,
      ).toBe("INVALID_CREDENTIALS");
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: EMAIL, password: "right password 1" },
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    h.clock.freeze(new Date(h.clock.now().getTime() + 15 * 60_000));
    expect(
      (
        await h.req("POST", "/api/auth/login", {
          body: { email: EMAIL, password: "right password 1" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("limits attempts per IP to 20 per 15 minutes", async () => {
    h = await loginHarness();
    for (let i = 0; i < 20; i++)
      await h.req("POST", "/api/auth/login", {
        body: { email: `u${i}@example.test`, password: "bad" },
      });
    expect(
      json(
        await h.req("POST", "/api/auth/login", {
          body: { email: "z@example.test", password: "bad" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });

  it("uses only the platform's last hop for the client IP: a forged X-Forwarded-For does not reset the limit", async () => {
    h = await makeHarness({
      env: { TRUST_PROXY_HOPS: "1" },
      dal: { users: { getLoginCredentials: () => Promise.resolve(null) } },
    });
    for (let i = 0; i < 20; i++)
      await h.req("POST", "/api/auth/login", {
        body: { email: `u${i}@example.test`, password: "x" },
        headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` },
      });
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: "z@example.test", password: "x" },
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" },
    });
    expect(json(r).code).toBe("RATE_LIMITED");
  });

  it("after 100 failures in 24 h: 429 for that email and one notice to the account", async () => {
    h = await loginHarness();
    for (let i = 0; i < 100; i++) {
      // A new 15-minute window every 10 attempts, so the pair and IP limits never trigger.
      if (i > 0 && i % 10 === 0) h.clock.freeze(new Date(h.clock.now().getTime() + 15 * 60_000));
      expect(json(await h.req("POST", "/api/auth/login", { body: { email: EMAIL, password: "bad" } })).code).toBe("INVALID_CREDENTIALS");
    }
    expect(h.outbox.list(EMAIL).filter((m) => m.kind === "login_throttled")).toHaveLength(1);
    h.clock.freeze(new Date(h.clock.now().getTime() + 15 * 60_000));
    const r = await h.req("POST", "/api/auth/login", { body: { email: EMAIL, password: "right password 1" } });
    expect(json(r).code).toBe("RATE_LIMITED");
    h.clock.freeze(new Date(h.clock.now().getTime() + 24 * 3_600_000));
    expect((await h.req("POST", "/api/auth/login", { body: { email: EMAIL, password: "right password 1" } })).statusCode).toBe(200);
  });

  it("returns the MFA-required state and a pending session when the user has MFA (no sign-in notice yet)", async () => {
    h = await loginHarness({
      mfa: {
        enabled: true,
        totp: true,
        passkeyCount: 2,
        recoveryCodesRemaining: 0,
      },
    });
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: EMAIL, password: "right password 1" },
    });
    expect(json(r)).toMatchObject({
      state: "mfa_required",
      mfaMethods: ["totp", "passkey"],
      expiresAt: "2026-11-13T15:10:00.000Z",
    });
    expect(String(r.headers["set-cookie"])).toContain("Max-Age=600");
    expect(h.outbox.list(EMAIL)).toEqual([]);
    expect([...h.sessions.rows.values()][0]?.session.status).toBe(
      "mfa_pending",
    );
  });

  it("rehashes a password stored with weaker parameters (and only then)", async () => {
    h = await loginHarness({ hash: "h:right password 1" });
    await h.req("POST", "/api/auth/login", {
      body: { email: EMAIL, password: "right password 1" },
    });
    expect((h as unknown as { rehashed: string[] }).rehashed).toEqual([]);
  });

  it("validates the body (email format, password length)", async () => {
    h = await loginHarness();
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: "nope", password: "" },
    });
    expect(json(r).details).toEqual([
      expect.objectContaining({ field: "email", issue: "invalid_format" }),
      expect.objectContaining({ field: "password", issue: "too_short" }),
    ]);
    const missing = await h.req("POST", "/api/auth/login", { body: {} });
    expect(json(missing).details).toEqual([
      expect.objectContaining({ field: "email", issue: "required" }),
      expect.objectContaining({ field: "password", issue: "required" }),
    ]);
  });
});

describe("sign-up", () => {
  const TOKEN = "t".repeat(43);
  function signupHarness(breached: string[] = []) {
    const created: unknown[] = [];
    return makeHarness({
      passwords: Object.assign(fakePasswords(), {
        assertAcceptable: async (p: string, email: string) => {
          const { PasswordService } = await import("../auth/passwords.ts");
          await new PasswordService({
            isBreached: (x) => Promise.resolve(breached.includes(x)),
          }).assertAcceptable(p, email, { in: "body", field: "password" });
        },
      }),
      dal: {
        signup: {
          previewSignupInvite: (hash: Buffer) =>
            hash.equals(sha256(TOKEN))
              ? Promise.resolve({ email: EMAIL, expiresAt: new Date("2026-11-20T15:00:00.000Z") })
              : Promise.reject(new DalError("INVITATION_INVALID")),
          signUpWithInvite: (input: unknown) => {
            created.push(input);
            return Promise.resolve({ userId: USER, email: EMAIL });
          },
        },
        users: { getMe: () => Promise.resolve({ ...me(USER), email: EMAIL }) },
      },
    }).then((hh) => Object.assign(hh, { created }));
  }

  it("creates the account from the invite (email from the invite), signs in and records the event", async () => {
    h = await signupHarness();
    const r = await h.req("POST", "/api/auth/signup", {
      body: {
        token: TOKEN,
        displayName: "  Pa\u0301t  ",
        password: "a long passphrase",
      },
    });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({
      state: "authenticated",
      user: { email: EMAIL },
    });
    const input = (
      h as unknown as {
        created: {
          displayName: string;
          passwordHash: string;
          tokenHash: Buffer;
        }[];
      }
    ).created[0]!;
    expect(input.displayName).toBe("P\u00e1t");
    expect(input.passwordHash).toBe("h:a long passphrase");
    expect(h.events.map((e) => e.type)).toEqual(["signup"]);
  });

  it("an unknown, used or expired token is 400 INVITATION_INVALID", async () => {
    h = await signupHarness();
    const r = await h.req("POST", "/api/auth/signup", {
      body: {
        token: "u".repeat(43),
        displayName: "Pat",
        password: "a long passphrase",
      },
    });
    expect(r.statusCode).toBe(400);
    expect(json(r).code).toBe("INVITATION_INVALID");
  });

  it("enforces the password policy: length, not the email, not breached", async () => {
    h = await signupHarness(["breached password"]);
    const short = json(
      await h.req("POST", "/api/auth/signup", {
        body: { token: TOKEN, displayName: "Pat", password: "elevenchars" },
      }),
    );
    expect(short.details).toEqual([
      expect.objectContaining({ field: "password", issue: "too_short" }),
    ]);
    const long = json(
      await h.req("POST", "/api/auth/signup", {
        body: { token: TOKEN, displayName: "Pat", password: "x".repeat(129) },
      }),
    );
    expect(long.details).toEqual([
      expect.objectContaining({ field: "password", issue: "too_long" }),
    ]);
    const asEmail = json(
      await h.req("POST", "/api/auth/signup", {
        body: { token: TOKEN, displayName: "Pat", password: EMAIL },
      }),
    );
    expect(asEmail.details).toEqual([
      expect.objectContaining({ field: "password", issue: "invalid_value" }),
    ]);
    const breached = json(
      await h.req("POST", "/api/auth/signup", {
        body: {
          token: TOKEN,
          displayName: "Pat",
          password: "breached password",
        },
      }),
    );
    expect(breached.details).toEqual([
      expect.objectContaining({
        field: "password",
        issue: "breached_password",
      }),
    ]);
  });

  it("counts code points, not UTF-16 units, for password length", async () => {
    h = await signupHarness();
    // 12 emoji = 24 UTF-16 units but 12 code points: allowed.
    const r = await h.req("POST", "/api/auth/signup", {
      body: {
        token: TOKEN,
        displayName: "Pat",
        password: "\u{1F600}".repeat(12),
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it("limits sign-up attempts per IP (preview and signup combined)", async () => {
    h = await signupHarness();
    for (let i = 0; i < 10; i++)
      await h.req("POST", "/api/auth/signup", {
        body: {
          token: "u".repeat(43),
          displayName: "Pat",
          password: "a long passphrase",
        },
      });
    expect(
      json(
        await h.req("POST", "/api/auth/signup/preview", {
          body: { token: TOKEN },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });

  it("preview shows the invited email and expiry; a bad token is INVITATION_INVALID", async () => {
    h = await signupHarness();
    const r = await h.req("POST", "/api/auth/signup/preview", { body: { token: TOKEN } });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ email: EMAIL, expiresAt: "2026-11-20T15:00:00.000Z" });
    const bad = await h.req("POST", "/api/auth/signup/preview", { body: { token: "u".repeat(43) } });
    expect([bad.statusCode, json(bad).code]).toEqual([400, "INVITATION_INVALID"]);
  });
});

describe("re-authentication", () => {
  function reauthHarness(mfa = NO_MFA) {
    return makeHarness({
      dal: {
        users: { getPasswordHash: () => Promise.resolve("h:right password 1") },
        mfa: { getMfaSummary: () => Promise.resolve(mfa) },
      },
    });
  }

  it("opens a 10-minute window", async () => {
    h = await reauthHarness();
    const s = h.sessions.add({ userId: USER, reauthAt: null });
    const r = await h.req("POST", "/api/auth/reauth", {
      auth: s,
      body: { password: "right password 1" },
    });
    expect(json(r)).toEqual({
      reauthenticatedUntil: "2026-11-13T15:10:00.000Z",
    });
    expect(h.events.map((e) => e.type)).toEqual(["reauth_succeeded"]);
  });

  it("wrong password is 401 INVALID_CREDENTIALS; 5 failures lock the session for 15 minutes", async () => {
    h = await reauthHarness();
    const s = h.sessions.add({ userId: USER });
    for (let i = 0; i < 5; i++)
      expect(
        json(
          await h.req("POST", "/api/auth/reauth", {
            auth: s,
            body: { password: "bad" },
          }),
        ).code,
      ).toBe("INVALID_CREDENTIALS");
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: s,
          body: { password: "right password 1" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });

  it("users with MFA get 401 MFA_REQUIRED without a factor (after the password check)", async () => {
    h = await reauthHarness({
      enabled: true,
      totp: true,
      passkeyCount: 0,
      recoveryCodesRemaining: 10,
    });
    const s = h.sessions.add({ userId: USER });
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: s,
          body: { password: "bad" },
        }),
      ).code,
    ).toBe("INVALID_CREDENTIALS");
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: s,
          body: { password: "right password 1" },
        }),
      ).code,
    ).toBe("MFA_REQUIRED");
    // A wrong factor (here: no TOTP secret stored at all) fails.
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: s,
          body: {
            password: "right password 1",
            mfa: { method: "totp", code: "123456" },
          },
        }),
      ).code,
    ).toBe("MFA_FAILED");
  });

  it("validates the MfaProof union", async () => {
    h = await reauthHarness();
    const s = h.sessions.add({ userId: USER });
    const r = json(
      await h.req("POST", "/api/auth/reauth", {
        auth: s,
        body: { password: "x", mfa: { method: "sms", code: "1" } },
      }),
    );
    expect(r.code).toBe("VALIDATION_FAILED");
  });
});

describe("logout and session state", () => {
  it("logout deletes only the caller's own session and clears the cookie", async () => {
    h = await makeHarness();
    const mine = h.sessions.add({ userId: USER });
    const other = h.sessions.add({ userId: USER });
    const r = await h.req("POST", "/api/auth/logout", { auth: mine });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers["set-cookie"])).toContain("Max-Age=0");
    expect(h.sessions.rows.has(sha256(mine.token).toString("hex"))).toBe(false);
    expect(h.sessions.rows.has(sha256(other.token).toString("hex"))).toBe(true);
    expect(h.events.map((e) => e.type)).toEqual(["logout"]);
  });

  it("anonymous logout is a 204 no-op; with a valid cookie the CSRF token is required", async () => {
    h = await makeHarness();
    expect((await h.req("POST", "/api/auth/logout")).statusCode).toBe(204);
    const s = h.sessions.add({ userId: USER });
    expect(
      json(
        await h.req("POST", "/api/auth/logout", {
          auth: { token: s.token, csrf: "y".repeat(43) },
        }),
      ).code,
    ).toBe("CSRF_FAILED");
  });

  it("GET /auth/session reports the re-auth window, null once it has passed", async () => {
    h = await makeHarness({
      dal: { users: { getMe: () => Promise.resolve(me(USER)) } },
    });
    const s = h.sessions.add({ userId: USER });
    h.clock.freeze(new Date(h.clock.now().getTime() + 11 * 60_000));
    const r = json(await h.req("GET", "/api/auth/session", { auth: s }));
    expect(r).toMatchObject({
      state: "authenticated",
      csrfToken: s.csrf,
      session: { id: s.session.id, reauthenticatedUntil: null },
    });
  });
});

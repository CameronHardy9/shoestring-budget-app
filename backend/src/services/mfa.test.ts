import { afterEach, describe, expect, it } from "vitest";
import { base32Decode, stepAt, totpCode } from "../auth/totp.ts";
import { SoftAuthenticator } from "../test-support/authenticator.ts";
import { ORIGIN, makeHarness, me } from "../test-support/harness.ts";
import type { Harness } from "../test-support/harness.ts";

const U = "01a1d7ab-0000-7000-8000-000000000001";
const EMAIL = "pat@example.test";
let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { code?: string };

function harness() {
  return makeHarness({
    dal: {
      users: {
        getUserContact: () =>
          Promise.resolve({ userId: U, email: EMAIL, displayName: "Pat" }),
        getMe: () => Promise.resolve({ ...me(U), email: EMAIL }),
        getPasswordHash: () => Promise.resolve("h:right password 1"),
      },
    },
  });
}

/** Enrolls TOTP through the API and returns the base32 secret and recovery codes. */
async function enrollTotp(active: { token: string; csrf: string }) {
  const setup = json(await h.req("POST", "/api/me/mfa/totp", { auth: active }));
  const secret = base32Decode(setup.secret as string);
  const code = totpCode(secret, stepAt(h.clock.now()));
  const r = await h.req("POST", "/api/me/mfa/totp/confirm", {
    auth: active,
    body: { code },
  });
  expect(r.statusCode).toBe(200);
  h.clock.freeze(new Date(h.clock.now().getTime() + 30_000)); // next step for later codes
  return { secret, recoveryCodes: json(r).recoveryCodes as string[] };
}
const codeNow = (secret: Buffer) => totpCode(secret, stepAt(h.clock.now()));

describe("TOTP enrollment", () => {
  it("setup -> confirm returns 10 recovery codes on the first factor, records events, notifies", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const setup = await h.req("POST", "/api/me/mfa/totp", { auth: s });
    expect(setup.statusCode).toBe(201);
    expect(json(setup)).toMatchObject({
      otpauthUri: expect.stringContaining("issuer=Shoestring") as unknown,
      expiresAt: "2026-11-13T15:15:00.000Z",
    });
    const { recoveryCodes } = await enrollTotp(s);
    expect(recoveryCodes).toHaveLength(10);
    expect(h.events.map((e) => e.type)).toEqual([
      "mfa_factor_added",
      "mfa_enabled",
    ]);
    expect(h.outbox.list(EMAIL)).toEqual([
      expect.objectContaining({ kind: "mfa_factor_added", priority: true }),
    ]);
    // stored encrypted, never the raw secret
    const stored = h.mfa.totp.get(U)!;
    expect(stored.keyId).toBe("k1");
    const mfa = json(await h.req("GET", "/api/me/mfa", { auth: s }));
    expect(mfa).toMatchObject({
      enabled: true,
      totp: { enabled: true },
      recoveryCodesRemaining: 10,
    });
  });

  it("wrong code is 401 MFA_FAILED; no setup is 404; a second TOTP is 409; all need re-auth", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    expect(
      json(
        await h.req("POST", "/api/me/mfa/totp/confirm", {
          auth: s,
          body: { code: "123456" },
        }),
      ).code,
    ).toBe("NOT_FOUND");
    await h.req("POST", "/api/me/mfa/totp", { auth: s });
    expect(
      json(
        await h.req("POST", "/api/me/mfa/totp/confirm", {
          auth: s,
          body: { code: "000000" },
        }),
      ).code,
    ).toBe("MFA_FAILED");
    await enrollTotp(s);
    expect(
      json(await h.req("POST", "/api/me/mfa/totp", { auth: s })).code,
    ).toBe("ALREADY_EXISTS");
    const stale = h.sessions.add({ userId: U, reauthAt: null });
    expect(
      json(await h.req("POST", "/api/me/mfa/totp", { auth: stale })).code,
    ).toBe("REAUTH_REQUIRED");
    expect(
      json(await h.req("DELETE", "/api/me/mfa/totp", { auth: stale })).code,
    ).toBe("REAUTH_REQUIRED");
  });

  it("confirm failures are limited to 5 per session per 15 minutes", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    await h.req("POST", "/api/me/mfa/totp", { auth: s });
    for (let i = 0; i < 5; i++)
      await h.req("POST", "/api/me/mfa/totp/confirm", {
        auth: s,
        body: { code: "000000" },
      });
    expect(
      json(
        await h.req("POST", "/api/me/mfa/totp/confirm", {
          auth: s,
          body: { code: "000000" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });

  it("removing the last factor disables MFA (recovery codes go) and notifies", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    await enrollTotp(s);
    expect(
      (await h.req("DELETE", "/api/me/mfa/totp", { auth: s })).statusCode,
    ).toBe(204);
    expect(h.events.map((e) => e.type).slice(-2)).toEqual([
      "mfa_factor_removed",
      "mfa_disabled",
    ]);
    expect(json(await h.req("GET", "/api/me/mfa", { auth: s }))).toMatchObject({
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    expect(
      json(await h.req("POST", "/api/me/mfa/recovery-codes", { auth: s })).code,
    ).toBe("MFA_NOT_ENABLED");
  });
});

describe("sign-in with a second factor", () => {
  async function pending() {
    const active = h.sessions.add({ userId: U });
    const totp = await enrollTotp(active);
    const p = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    return { ...totp, p };
  }

  it("a valid TOTP rotates to a new active session with a new CSRF token and sends the sign-in notice", async () => {
    h = await harness();
    const { secret, p } = await pending();
    const r = await h.req("POST", "/api/auth/mfa/verify", {
      auth: p,
      body: { method: "totp", code: codeNow(secret) },
    });
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b.state).toBe("authenticated");
    expect(b.csrfToken).not.toBe(p.csrf);
    expect(String(r.headers["set-cookie"])).toMatch(
      /^__Host-ss_sid=[A-Za-z0-9_-]{43};.*Max-Age=2592000/,
    );
    expect(json(await h.req("GET", "/api/me", { auth: p })).code).toBe(
      "UNAUTHENTICATED",
    ); // old token is dead
    expect(h.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["mfa_succeeded", "login_succeeded"]),
    );
    expect(h.outbox.list(EMAIL).map((m) => m.kind)).toContain("new_sign_in");
  });

  it("a replayed TOTP code is rejected", async () => {
    h = await harness();
    const { secret, p } = await pending();
    const code = codeNow(secret);
    expect(
      (
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p,
          body: { method: "totp", code },
        })
      ).statusCode,
    ).toBe(200);
    const p2 = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p2,
          body: { method: "totp", code },
        }),
      ).code,
    ).toBe("MFA_FAILED");
  });

  it("5 failures delete the pending session and email the user", async () => {
    h = await harness();
    const { p } = await pending();
    for (let i = 0; i < 5; i++)
      expect(
        json(
          await h.req("POST", "/api/auth/mfa/verify", {
            auth: p,
            body: { method: "totp", code: "000000" },
          }),
        ).code,
      ).toBe("MFA_FAILED");
    expect(h.outbox.list(EMAIL).map((m) => m.kind)).toContain("mfa_failures");
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p,
          body: { method: "totp", code: "000000" },
        }),
      ).code,
    ).toBe("UNAUTHENTICATED");
  });

  it("a recovery code works once and notifies", async () => {
    h = await harness();
    const { recoveryCodes, p } = await pending();
    const code = recoveryCodes[0]!.toUpperCase();
    expect(
      (
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p,
          body: { method: "recovery_code", code },
        })
      ).statusCode,
    ).toBe(200);
    expect(h.outbox.list(EMAIL).map((m) => m.kind)).toContain(
      "recovery_code_used",
    );
    const p2 = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p2,
          body: { method: "recovery_code", code },
        }),
      ).code,
    ).toBe("MFA_FAILED");
  });

  it("an active session calling /auth/mfa/verify is 403 FORBIDDEN", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: s,
          body: { method: "totp", code: "000000" },
        }),
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("per-user failure budget (F-05): 20 failures in 24 h lock every factor check with 429, record mfa_locked and email once", async () => {
    h = await harness();
    const { secret } = await pending();
    for (let i = 0; i < 20; i++) {
      const p = h.sessions.add({
        userId: U,
        status: "mfa_pending",
        reauthAt: null,
      });
      expect(
        json(
          await h.req("POST", "/api/auth/mfa/verify", {
            auth: p,
            body: { method: "totp", code: "000000" },
          }),
        ).code,
      ).toBe("MFA_FAILED");
    }
    expect(h.events.filter((e) => e.type === "mfa_locked")).toHaveLength(1);
    expect(
      h.outbox.list(EMAIL).filter((m) => m.kind === "mfa_locked"),
    ).toHaveLength(1);
    const p = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    const locked = await h.req("POST", "/api/auth/mfa/verify", {
      auth: p,
      body: { method: "totp", code: codeNow(secret) },
    });
    expect(json(locked).code).toBe("RATE_LIMITED");
    expect(locked.headers["retry-after"]).toBeDefined();
    // ... shared with re-auth
    const active = h.sessions.add({ userId: U });
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: active,
          body: {
            password: "right password 1",
            mfa: { method: "totp", code: codeNow(secret) },
          },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
    h.clock.freeze(new Date(h.clock.now().getTime() + 25 * 3_600_000));
    const later = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    expect(
      (
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: later,
          body: { method: "totp", code: codeNow(secret) },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("re-authentication with MFA", () => {
  it("needs the password and a factor; success opens the window", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const { secret } = await enrollTotp(s);
    const stale = h.sessions.add({ userId: U, reauthAt: null });
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: stale,
          body: { password: "right password 1" },
        }),
      ).code,
    ).toBe("MFA_REQUIRED");
    expect(
      json(
        await h.req("POST", "/api/auth/reauth", {
          auth: stale,
          body: {
            password: "right password 1",
            mfa: { method: "totp", code: "000000" },
          },
        }),
      ).code,
    ).toBe("MFA_FAILED");
    const ok = await h.req("POST", "/api/auth/reauth", {
      auth: stale,
      body: {
        password: "right password 1",
        mfa: { method: "totp", code: codeNow(secret) },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await h.req("DELETE", "/api/me/mfa/totp", { auth: stale })).statusCode,
    ).toBe(204);
  });
});

describe("passkeys", () => {
  async function registerPasskey(s: { token: string; csrf: string }) {
    const auth = new SoftAuthenticator();
    const opts = json(
      await h.req("POST", "/api/me/mfa/passkeys/options", { auth: s }),
    ) as { challenge: string; rp: { id: string } };
    expect(opts.rp.id).toBe("app.test");
    const r = await h.req("POST", "/api/me/mfa/passkeys", {
      auth: s,
      body: { name: " Phone ", credential: auth.register(opts, ORIGIN) },
    });
    return { auth, r };
  }

  it("registers (recovery codes on the first factor), signs in with an assertion, and records the counter", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const { auth, r } = await registerPasskey(s);
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({
      passkey: { name: "Phone", lastUsedAt: null },
    });
    expect((json(r).recoveryCodes as string[]).length).toBe(10);
    const p = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    const chOpts = json(
      await h.req("POST", "/api/auth/webauthn/challenge", {
        auth: p,
        body: { purpose: "mfa" },
      }),
    ) as { challenge: string; rpId: string };
    expect(chOpts).toMatchObject({
      rpId: "app.test",
      userVerification: "preferred",
    });
    const v = await h.req("POST", "/api/auth/mfa/verify", {
      auth: p,
      body: { method: "passkey", assertion: auth.assert(chOpts, ORIGIN) },
    });
    expect(v.statusCode).toBe(200);
    expect([...h.mfa.passkeys.get(U)!][0]!.signCount).toBe(1);
  });

  it("a challenge is single-use; a counter regression is rejected and recorded", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const { auth } = await registerPasskey(s);
    h.mfa.passkeys.get(U)![0]!.signCount = 10;
    const p = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    const opts = json(
      await h.req("POST", "/api/auth/webauthn/challenge", {
        auth: p,
        body: { purpose: "mfa" },
      }),
    ) as { challenge: string };
    const assertion = auth.assert(opts, ORIGIN, 3);
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p,
          body: { method: "passkey", assertion },
        }),
      ).code,
    ).toBe("MFA_FAILED");
    expect(h.events.map((e) => e.type)).toContain("passkey_counter_regression");
    expect(
      json(
        await h.req("POST", "/api/auth/mfa/verify", {
          auth: p,
          body: { method: "passkey", assertion: auth.assert(opts, ORIGIN, 20) },
        }),
      ).code,
    ).toBe("MFA_FAILED");
  });

  it("challenge purpose must match the session state; no passkeys is 409", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    expect(
      json(
        await h.req("POST", "/api/auth/webauthn/challenge", {
          auth: s,
          body: { purpose: "mfa" },
        }),
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      json(
        await h.req("POST", "/api/auth/webauthn/challenge", {
          auth: s,
          body: { purpose: "reauth" },
        }),
      ).code,
    ).toBe("MFA_NOT_ENABLED");
    const p = h.sessions.add({
      userId: U,
      status: "mfa_pending",
      reauthAt: null,
    });
    expect(
      json(
        await h.req("POST", "/api/auth/webauthn/challenge", {
          auth: p,
          body: { purpose: "reauth" },
        }),
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("a forged or replayed registration fails; 10 passkeys is LIMIT_REACHED", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const auth = new SoftAuthenticator();
    const bad = await h.req("POST", "/api/me/mfa/passkeys", {
      auth: s,
      body: {
        name: "x",
        credential: auth.register(
          { challenge: "AAAA", rp: { id: "app.test" } },
          ORIGIN,
        ),
      },
    });
    expect(json(bad).code).toBe("MFA_FAILED");
    for (let i = 0; i < 10; i++)
      expect((await registerPasskey(s)).r.statusCode).toBe(201);
    const limit = await h.req("POST", "/api/me/mfa/passkeys/options", {
      auth: s,
    });
    expect([limit.statusCode, json(limit).code]).toEqual([
      422,
      "LIMIT_REACHED",
    ]);
  });

  it("removing someone else's passkey is 404", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    expect(
      json(
        await h.req(
          "DELETE",
          "/api/me/mfa/passkeys/01a1d7ab-0000-7000-8000-0000000000ff",
          { auth: s },
        ),
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("recovery-code regeneration returns 10 new codes and notifies", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    await enrollTotp(s);
    const r = json(
      await h.req("POST", "/api/me/mfa/recovery-codes", { auth: s }),
    );
    expect((r.recoveryCodes as string[]).length).toBe(10);
    expect(h.outbox.list(EMAIL).map((m) => m.kind)).toContain(
      "recovery_codes_regenerated",
    );
  });
});

describe("F-45: failure limits hold under parallel requests", () => {
  const codes = (rs: { body: string }[]) => {
    const out: Record<string, number> = {};
    for (const r of rs) {
      const c = json(r).code ?? "OK";
      out[c] = (out[c] ?? 0) + 1;
    }
    return out;
  };

  it("50 parallel wrong re-auth passwords: exactly 5 are checked, the rest are 429", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => h.req("POST", "/api/auth/reauth", { auth: s, body: { password: "wrong" } })),
    );
    expect(codes(rs)).toEqual({ INVALID_CREDENTIALS: 5, RATE_LIMITED: 45 });
  });

  it("50 parallel wrong factors across sessions: the per-user budget allows at most 20 checks", async () => {
    h = await harness();
    const active = h.sessions.add({ userId: U });
    const { secret } = await enrollTotp(active);
    const sessions = Array.from({ length: 50 }, () => h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null }));
    const rs = await Promise.all(sessions.map((p) => h.req("POST", "/api/auth/mfa/verify", { auth: p, body: { method: "totp", code: "000000" } })));
    expect(codes(rs)).toEqual({ MFA_FAILED: 20, RATE_LIMITED: 30 });
    expect(h.events.filter((e) => e.type === "mfa_locked")).toHaveLength(1);
    expect(h.outbox.list(EMAIL).filter((m) => m.kind === "mfa_locked")).toHaveLength(1);
    // A right code is refused too while the budget is spent.
    const p = h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null });
    expect(json(await h.req("POST", "/api/auth/mfa/verify", { auth: p, body: { method: "totp", code: codeNow(secret) } })).code).toBe("RATE_LIMITED");
  });

  it("successes and refused attempts are refunded: they never consume the budget", async () => {
    h = await harness();
    const active = h.sessions.add({ userId: U });
    const { secret } = await enrollTotp(active);
    for (let i = 0; i < 19; i++) {
      const p = h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null });
      await h.req("POST", "/api/auth/mfa/verify", { auth: p, body: { method: "totp", code: "000000" } });
    }
    for (let i = 0; i < 3; i++) {
      h.clock.freeze(new Date(h.clock.now().getTime() + 30_000));
      const p = h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null });
      expect((await h.req("POST", "/api/auth/mfa/verify", { auth: p, body: { method: "totp", code: codeNow(secret) } })).statusCode).toBe(200);
    }
    const last = h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null });
    expect(json(await h.req("POST", "/api/auth/mfa/verify", { auth: last, body: { method: "totp", code: "000000" } })).code).toBe("MFA_FAILED");
    expect(h.events.filter((e) => e.type === "mfa_locked")).toHaveLength(1);
  });

  it("50 parallel wrong factors on ONE pending session: exactly 5 checks, then the session is gone", async () => {
    h = await harness();
    const active = h.sessions.add({ userId: U });
    await enrollTotp(active);
    const p = h.sessions.add({ userId: U, status: "mfa_pending", reauthAt: null });
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => h.req("POST", "/api/auth/mfa/verify", { auth: p, body: { method: "totp", code: "000000" } })),
    );
    const c = codes(rs);
    expect(c.MFA_FAILED).toBe(5);
    expect((c.MFA_FAILED ?? 0) + (c.RATE_LIMITED ?? 0) + (c.UNAUTHENTICATED ?? 0)).toBe(50);
    expect(h.outbox.list(EMAIL).filter((m) => m.kind === "mfa_failures")).toHaveLength(1);
    expect(json(await h.req("GET", "/api/auth/session", { auth: p })).code).toBe("UNAUTHENTICATED");
  });

  it("50 parallel wrong TOTP confirmations: exactly 5 are checked", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    await h.req("POST", "/api/me/mfa/totp", { auth: s });
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => h.req("POST", "/api/me/mfa/totp/confirm", { auth: s, body: { code: "000000" } })),
    );
    expect(codes(rs)).toEqual({ MFA_FAILED: 5, RATE_LIMITED: 45 });
  });
});

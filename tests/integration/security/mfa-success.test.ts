// Successful second-factor paths against real Postgres (task 9). The backend's
// unit tests run on a fake DAL; this gap hid the throttle-refund 500 fixed in
// PR #6 (every successful MFA check refunds its reservation, auth.md §6).
import { describe, expect, it } from "vitest";
import {
  createUserWithTotp,
  enrollTotp,
  mfaSignIn,
  nextTotpStep,
  startMfaSignIn,
} from "../../support/auth.ts";
import { createUser } from "../../support/factories.ts";
import { codeOf } from "../../support/http.ts";
import {
  advanceClock,
  emails,
  MINUTE,
  now,
  testLogin,
} from "../../support/hooks.ts";
import { totp, wrongTotp } from "../../support/totp.ts";
import { enrollPasskey } from "../../support/webauthn.ts";

describe("TOTP setup confirm (PR #6 regression)", () => {
  it("confirms TOTP with a current code, returns 10 recovery codes once and mails mfa_factor_added", async () => {
    const user = await createUser();
    const client = await testLogin(user.email);
    const { recoveryCodes } = await enrollTotp(client);
    expect(new Set(recoveryCodes).size).toBe(10);

    const mfa = await client.get<{
      enabled: boolean;
      totp: { enabled: boolean };
    }>("/me/mfa");
    expect(mfa.body).toMatchObject({
      enabled: true,
      totp: { enabled: true },
      recoveryCodesRemaining: 10,
    });
    expect((await emails(user.email)).map((e) => e.kind)).toContain(
      "mfa_factor_added",
    );
  });

  it("rejects a wrong confirm code with MFA_FAILED and still accepts the right one afterwards", async () => {
    const user = await createUser();
    const client = await testLogin(user.email);
    const setup = await client.post<{ secret: string }>("/me/mfa/totp");
    const wrong = await client.post("/me/mfa/totp/confirm", {
      code: wrongTotp(setup.body.secret, now()),
    });
    expect([wrong.status, codeOf(wrong)]).toEqual([401, "MFA_FAILED"]);
    const ok = await client.post("/me/mfa/totp/confirm", {
      code: totp(setup.body.secret, now()),
    });
    expect(ok.status, ok.describe).toBe(200);
  });
});

describe("MFA sign-in (auth.md §5)", () => {
  it("signs in with password + TOTP: rotates the session, returns a new CSRF token and mails new_sign_in", async () => {
    const user = await createUserWithTotp();
    const pending = await startMfaSignIn(user);
    const pendingToken = pending.sessionToken;
    const pendingCsrf = pending.csrfToken;

    // An mfa_pending session reaches nothing but the MFA endpoints.
    const me = await pending.get("/me");
    expect([me.status, codeOf(me)]).toEqual([401, "MFA_REQUIRED"]);

    const res = await pending.post<{ state: string; user: { id: string } }>(
      "/auth/mfa/verify",
      {
        method: "totp",
        code: totp(user.secret, now()),
      },
    );
    expect(res.status, res.describe).toBe(200);
    expect(res.body.state).toBe("authenticated");
    expect(res.body.user.id).toBe(user.userId);
    expect(pending.sessionToken).not.toBe(pendingToken);
    expect(pending.csrfToken).not.toBe(pendingCsrf);
    expect((await pending.get("/me")).status).toBe(200);
    expect(
      (await emails(user.email)).filter((e) => e.kind === "new_sign_in"),
    ).toHaveLength(1);
  });

  it("refuses a replayed TOTP code (step already used) with MFA_FAILED", async () => {
    const user = await createUserWithTotp();
    const first = await startMfaSignIn(user);
    const code = totp(user.secret, now());
    expect(
      (await first.post("/auth/mfa/verify", { method: "totp", code })).status,
    ).toBe(200);
    const second = await startMfaSignIn(user);
    const replay = await second.post("/auth/mfa/verify", {
      method: "totp",
      code,
    });
    expect([replay.status, codeOf(replay)]).toEqual([401, "MFA_FAILED"]);
  });

  it("signs in with a recovery code once, mails recovery_code_used, and refuses the same code again", async () => {
    const user = await createUserWithTotp();
    const code = user.recoveryCodes[0]!;
    const a = await startMfaSignIn(user);
    const ok = await a.post("/auth/mfa/verify", {
      method: "recovery_code",
      code: code.toUpperCase().replace("-", ""),
    });
    expect(ok.status, ok.describe).toBe(200);
    expect((await emails(user.email)).map((e) => e.kind)).toContain(
      "recovery_code_used",
    );
    const b = await startMfaSignIn(user);
    const again = await b.post("/auth/mfa/verify", {
      method: "recovery_code",
      code,
    });
    expect([again.status, codeOf(again)]).toEqual([401, "MFA_FAILED"]);
  });
});

describe("re-authentication with MFA (auth.md §10)", () => {
  it("re-authenticates with password + TOTP and opens a 10-minute window", async () => {
    const user = await createUserWithTotp();
    const client = await mfaSignIn(user);
    await advanceClock(11 * MINUTE);
    const stale = await client.post("/me/mfa/recovery-codes");
    expect([stale.status, codeOf(stale)]).toEqual([403, "REAUTH_REQUIRED"]);

    const noFactor = await client.post("/auth/reauth", {
      password: user.password,
    });
    expect([noFactor.status, codeOf(noFactor)]).toEqual([401, "MFA_REQUIRED"]);

    const res = await client.post<{ reauthenticatedUntil: string }>(
      "/auth/reauth",
      {
        password: user.password,
        mfa: { method: "totp", code: totp(user.secret, now()) },
      },
    );
    expect(res.status, res.describe).toBe(200);
    expect(res.body.reauthenticatedUntil).toBe(
      new Date(now().getTime() + 10 * MINUTE).toISOString(),
    );
    await nextTotpStep();
    const fresh = await client.post<{ recoveryCodes: string[] }>(
      "/me/mfa/recovery-codes",
    );
    expect(fresh.status, fresh.describe).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
  });
});

describe("passkey as second factor (real WebAuthn signatures)", () => {
  it("signs in with a passkey assertion from the MFA challenge, and re-authenticates with one", async () => {
    const user = await createUser({ prefix: "passkey" });
    const setup = await testLogin(user.email);
    const { authenticator, recoveryCodes } = await enrollPasskey(setup);
    expect(recoveryCodes).toHaveLength(10);

    const pending = await startMfaSignIn(user);
    const challenge = await pending.post<{ challenge: string; rpId: string }>("/auth/webauthn/challenge", { purpose: "mfa" });
    expect(challenge.status).toBe(200);
    const res = await pending.post("/auth/mfa/verify", { method: "passkey", assertion: authenticator.assert(challenge.body) });
    expect(res.status, res.describe).toBe(200);

    await advanceClock(11 * MINUTE);
    const rc = await pending.post<{ challenge: string; rpId: string }>("/auth/webauthn/challenge", { purpose: "reauth" });
    const reauth = await pending.post("/auth/reauth", {
      password: user.password,
      mfa: { method: "passkey", assertion: authenticator.assert(rc.body) },
    });
    expect(reauth.status, reauth.describe).toBe(200);
  });

  // Proves session binding, not single use: the assertion is never used on its
  // own session first (security review 2026-11-16).
  it("a passkey assertion is bound to its session's challenge: another MFA-pending session cannot use it (401 MFA_FAILED)", async () => {
    const user = await createUser({ prefix: "passkey" });
    const { authenticator } = await enrollPasskey(await testLogin(user.email));
    const pending = await startMfaSignIn(user);
    const challenge = await pending.post<{ challenge: string; rpId: string }>("/auth/webauthn/challenge", { purpose: "mfa" });
    const assertion = authenticator.assert(challenge.body);
    const second = await startMfaSignIn(user);
    await second.post("/auth/webauthn/challenge", { purpose: "mfa" });
    const replay = await second.post("/auth/mfa/verify", { method: "passkey", assertion });
    expect([replay.status, codeOf(replay)]).toEqual([401, "MFA_FAILED"]);
  });
});

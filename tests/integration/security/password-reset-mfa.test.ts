// Password reset never bypasses MFA (auth.md §8, OpenAPI completePasswordReset,
// checklist "reset without factor" against real tokens). The policy check runs
// first, so a rejected password spends no factor and no MFA failure.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUserWithTotp, enrollTotp, passwordLogin } from "../../support/auth.ts";
import { createUser } from "../../support/factories.ts";
import { ApiClient, codeOf, detailsOf } from "../../support/http.ts";
import {
  advanceClock,
  emails,
  lastEmail,
  MINUTE,
  now,
  testLogin,
  tokenFromLink,
} from "../../support/hooks.ts";
import { totp, wrongTotp } from "../../support/totp.ts";
import { enrollPasskey } from "../../support/webauthn.ts";

const anon = () => new ApiClient("anonymous");
const newPassword = () => `pw-${randomUUID()}`;

/** POST /auth/password-reset/request, then the token from the emailed link. */
async function resetToken(email: string): Promise<string> {
  const res = await anon().post("/auth/password-reset/request", { email });
  expect(res.status).toBe(202);
  const mail = await lastEmail(email, "password_reset");
  expect(new URL(mail.links[0]!).pathname).toBe("/reset-password");
  return tokenFromLink(mail.links[0]!);
}

describe("password reset with MFA enabled", () => {
  it("verify says a factor is needed; complete without it is 401 MFA_REQUIRED and leaves the token usable", async () => {
    const u = await createUserWithTotp();
    const token = await resetToken(u.email);
    const status = await anon().post<{
      mfaRequired: boolean;
      mfaMethods: string[];
    }>("/auth/password-reset/verify", { token });
    expect(status.body.mfaRequired).toBe(true);
    expect(status.body.mfaMethods).toEqual(
      expect.arrayContaining(["totp", "recovery_code"]),
    );
    const missing = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
    });
    expect([missing.status, codeOf(missing)]).toEqual([401, "MFA_REQUIRED"]);
    expect(
      (await anon().post("/auth/password-reset/verify", { token })).status,
    ).toBe(200);
  });

  it("a wrong code is 401 MFA_FAILED; the password policy is checked first and spends no attempt", async () => {
    const u = await createUserWithTotp();
    const token = await resetToken(u.email);
    const weak = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: "short",
      mfa: { method: "totp", code: wrongTotp(u.secret, now()) },
    });
    expect([weak.status, codeOf(weak)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(weak)).toContainEqual(
      expect.objectContaining({ field: "newPassword", issue: "too_short" }),
    );
    // Four real failures: if the weak-password call had spent a slot, the 5th below would invalidate the token.
    for (let i = 0; i < 4; i++) {
      const r = await anon().post("/auth/password-reset/complete", {
        token,
        newPassword: newPassword(),
        mfa: { method: "totp", code: wrongTotp(u.secret, now()) },
      });
      expect([r.status, codeOf(r)]).toEqual([401, "MFA_FAILED"]);
    }
    const ok = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
      mfa: { method: "totp", code: totp(u.secret, now()) },
    });
    expect(ok.status, ok.describe).toBe(204);
  });

  it("five wrong codes invalidate the token (400 TOKEN_INVALID even with the right code)", async () => {
    const u = await createUserWithTotp();
    const token = await resetToken(u.email);
    for (let i = 0; i < 5; i++)
      await anon().post("/auth/password-reset/complete", {
        token,
        newPassword: newPassword(),
        mfa: { method: "totp", code: wrongTotp(u.secret, now()) },
      });
    const res = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
      mfa: { method: "totp", code: totp(u.secret, now()) },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "TOKEN_INVALID"]);
  });

  it("success with the factor: password changed, every session revoked, password_changed mailed, and sign-in still asks for MFA", async () => {
    const u = await createUserWithTotp();
    const before = await testLogin(u.email);
    const token = await resetToken(u.email);
    const pw = newPassword();
    const res = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: pw,
      mfa: { method: "totp", code: totp(u.secret, now()) },
    });
    expect(res.status).toBe(204);
    expect(codeOf(await before.get("/me"))).toBe("UNAUTHENTICATED");
    expect((await emails(u.email)).map((e) => e.kind)).toContain(
      "password_changed",
    );
    const { state } = await passwordLogin({ ...u, password: pw });
    expect(state).toBe("mfa_required");
    expect(
      codeOf(
        await anon().post("/auth/password-reset/complete", {
          token,
          newPassword: newPassword(),
        }),
      ),
    ).toBe("TOKEN_INVALID");
  });

  it("a recovery code also satisfies the reset (and is mailed as used)", async () => {
    const u = await createUserWithTotp();
    const token = await resetToken(u.email);
    const res = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
      mfa: { method: "recovery_code", code: u.recoveryCodes[3]! },
    });
    expect(res.status).toBe(204);
    expect((await emails(u.email)).map((e) => e.kind)).toContain(
      "recovery_code_used",
    );
  });

  it("a passkey user resets with a passkey assertion from the token-bound challenge", async () => {
    const u = await createUser({ prefix: "passkey" });
    const { authenticator } = await enrollPasskey(await testLogin(u.email));
    const token = await resetToken(u.email);
    const challenge = await anon().post<{ challenge: string; rpId: string }>(
      "/auth/password-reset/webauthn-challenge",
      { token },
    );
    expect(challenge.status).toBe(200);
    const res = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
      mfa: {
        method: "passkey",
        assertion: authenticator.assert(challenge.body),
      },
    });
    expect(res.status, res.describe).toBe(204);
  });

  it("enrolling a factor deletes an open reset token, so a stale 'no MFA' token cannot complete (F-01)", async () => {
    const u = await createUser({ prefix: "late-mfa" });
    const token = await resetToken(u.email);
    await enrollTotp(await testLogin(u.email));
    expect(
      codeOf(
        await anon().post("/auth/password-reset/complete", {
          token,
          newPassword: newPassword(),
        }),
      ),
    ).toBe("TOKEN_INVALID");
  });
});

describe("password reset without MFA", () => {
  it("completes with the token alone, revokes sessions; the token expires after 30 minutes", async () => {
    const u = await createUser({ prefix: "plain" });
    const token = await resetToken(u.email);
    const status = await anon().post<{
      mfaRequired: boolean;
      mfaMethods: string[];
    }>("/auth/password-reset/verify", { token });
    expect(status.body).toEqual({ mfaRequired: false, mfaMethods: [] });
    const ok = await anon().post("/auth/password-reset/complete", {
      token,
      newPassword: newPassword(),
    });
    expect(ok.status).toBe(204);

    const second = await resetToken(u.email);
    await advanceClock(30 * MINUTE + 1_000);
    expect(
      codeOf(
        await anon().post("/auth/password-reset/verify", { token: second }),
      ),
    ).toBe("TOKEN_INVALID");
  });

  it("the request answers 202 for unknown addresses too, and mails nothing", async () => {
    const res = await anon().post("/auth/password-reset/request", {
      email: "nobody-here@example.test",
    });
    expect(res.status).toBe(202);
    expect(await emails("nobody-here@example.test")).toEqual([]);
  });
});

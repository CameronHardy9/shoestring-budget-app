// F-45 regression (auth.md §6 "Attempt slots", §14 mfa-verify / mfa-failures):
// concurrent wrong MFA attempts through HTTP can never run more than 5 checks
// per pending session or reset token, or more than 20 failed checks per user
// per 24 h; the 5th slot can still succeed; refused attempts and successes are
// refunded, so they never count toward the per-user budget.
//
// "In flight" is made deterministic, not timed: an EXCLUSIVE lock on
// auth_throttles stops a verify after it reserved its session slot and before
// it charges the per-user budget (the reserve-first order of auth.md §6).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createUserWithTotp,
  nextTotpStep,
  startMfaSignIn,
} from "../../support/auth.ts";
import type { MfaUser } from "../../support/auth.ts";
import { holdExclusiveLock } from "../../support/db-locks.ts";
import { ApiClient, codeOf } from "../../support/http.ts";
import type { ApiResponse } from "../../support/http.ts";
import { dal, emails, now, testLogin } from "../../support/hooks.ts";
import { totp, wrongTotp } from "../../support/totp.ts";
import { oneTimeToken } from "../../support/world.ts";

const verify = (c: ApiClient, code: string) =>
  c.post("/auth/mfa/verify", { method: "totp", code });
const outcome = (r: ApiResponse) => `${r.status} ${codeOf(r) ?? ""}`.trim();

async function fail(c: ApiClient, u: MfaUser): Promise<ApiResponse> {
  return verify(c, wrongTotp(u.secret, now()));
}

describe("F-45: at most 5 checks per MFA-pending session", () => {
  it("with 4 slots used and the 5th in flight, a 6th call gets 429 RATE_LIMITED with Retry-After: 1", async () => {
    const u = await createUserWithTotp();
    const pending = await startMfaSignIn(u);
    for (let i = 0; i < 4; i++)
      expect(outcome(await fail(pending, u))).toBe("401 MFA_FAILED");

    const lock = await holdExclusiveLock("auth_throttles");
    let fifth: Promise<ApiResponse> | undefined;
    try {
      fifth = fail(pending, u);
      await lock.waitForWaiters(1);
      const sixth = await fail(pending, u);
      expect(outcome(sixth)).toBe("429 RATE_LIMITED");
      expect(sixth.header("retry-after")).toBe("1");
    } finally {
      await lock.release();
    }
    expect(outcome(await fifth)).toBe("401 MFA_FAILED");
    // The 5th failure deleted the pending session: sign in again.
    expect(outcome(await fail(pending, u))).toBe("401 UNAUTHENTICATED");
    expect(
      (await emails(u.email)).filter((e) => e.kind === "mfa_failures"),
    ).toHaveLength(1);
  });

  it("the 5th slot can still succeed, while it is in flight and after 4 failures", async () => {
    const u = await createUserWithTotp();
    const pending = await startMfaSignIn(u);
    for (let i = 0; i < 4; i++)
      expect(outcome(await fail(pending, u))).toBe("401 MFA_FAILED");
    const lock = await holdExclusiveLock("auth_throttles");
    let fifth: Promise<ApiResponse> | undefined;
    try {
      fifth = verify(pending, totp(u.secret, now()));
      await lock.waitForWaiters(1);
      expect(outcome(await fail(pending, u))).toBe("429 RATE_LIMITED");
    } finally {
      await lock.release();
    }
    const ok = await fifth;
    expect(ok.status, ok.describe).toBe(200);
    expect((await pending.get("/me")).status).toBe(200);
  });

  it("a parallel burst of 12 wrong codes runs exactly 5 checks; the rest are 429 (Retry-After: 1) or 401 after the session is gone", async () => {
    const u = await createUserWithTotp();
    const pending = await startMfaSignIn(u);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => fail(pending, u)),
    );
    const kinds = results.map(outcome);
    expect(kinds.filter((k) => k === "401 MFA_FAILED")).toHaveLength(5);
    for (const r of results.filter((x) => codeOf(x) !== "MFA_FAILED")) {
      expect(["429 RATE_LIMITED", "401 UNAUTHENTICATED"]).toContain(outcome(r));
      if (r.status === 429) expect(r.header("retry-after")).toBe("1");
    }
  });
});

describe("F-45: the per-user budget of 20 failed checks per 24 h", () => {
  it("counts only real failed checks: refused attempts and successes are refunded; the 21st check is 429 (Retry-After: 3600)", async () => {
    const u = await createUserWithTotp();
    let failures = 0;

    // Session 1: 4 failures, then 3 attempts refused while the 5th is in flight, then that 5th fails.
    const s1 = await startMfaSignIn(u);
    for (let i = 0; i < 4; i++)
      expect(outcome(await fail(s1, u))).toBe("401 MFA_FAILED");
    const lock = await holdExclusiveLock("auth_throttles");
    let fifth: Promise<ApiResponse> | undefined;
    try {
      fifth = fail(s1, u);
      await lock.waitForWaiters(1);
      for (let i = 0; i < 3; i++)
        expect(outcome(await fail(s1, u))).toBe("429 RATE_LIMITED");
    } finally {
      await lock.release();
    }
    expect(outcome(await fifth)).toBe("401 MFA_FAILED");
    failures += 5;

    // A successful sign-in (refunded) in between.
    const ok = await startMfaSignIn(u);
    expect((await verify(ok, totp(u.secret, now()))).status).toBe(200);
    await nextTotpStep();

    // Sessions 2-4: 14 more failures → 19 so far, never locked.
    for (const n of [5, 5, 4]) {
      const s = await startMfaSignIn(u);
      for (let i = 0; i < n; i++)
        expect(outcome(await fail(s, u)), `failure ${failures + i + 1}`).toBe(
          "401 MFA_FAILED",
        );
      failures += n;
    }
    expect(failures).toBe(19);
    expect(
      (await emails(u.email)).filter((e) => e.kind === "mfa_locked"),
    ).toHaveLength(0);

    // The 20th failure is still checked (the session above has a free 5th slot).
    const last = await startMfaSignIn(u);
    expect(outcome(await fail(last, u))).toBe("401 MFA_FAILED");
    expect(
      (await emails(u.email)).filter((e) => e.kind === "mfa_locked"),
    ).toHaveLength(1);

    // Now every factor check of this user answers 429 for the window, even a correct code.
    const locked = await verify(last, totp(u.secret, now()));
    expect(outcome(locked)).toBe("429 RATE_LIMITED");
    expect(locked.header("retry-after")).toBe("3600");
  });

  it("the budget is shared with re-auth and password-reset completion (auth.md §6)", async () => {
    const u = await createUserWithTotp();
    for (let s = 0; s < 4; s++) {
      const p = await startMfaSignIn(u);
      for (let i = 0; i < 5; i++) await fail(p, u);
    }
    // Budget exhausted (20). Re-auth with the right password and code: 429.
    const active = await testLogin(u.email);
    const reauth = await active.post("/auth/reauth", {
      password: u.password,
      mfa: { method: "totp", code: totp(u.secret, now()) },
    });
    expect(outcome(reauth)).toBe("429 RATE_LIMITED");
    expect(reauth.header("retry-after")).toBe("3600");
    // Password reset with the right code: 429 too, and the token is not consumed.
    const t = oneTimeToken();
    await dal().tokens.issuePasswordResetToken(u.userId, t.hash);
    const reset = await new ApiClient("anon").post(
      "/auth/password-reset/complete",
      {
        token: t.token,
        newPassword: `pw-${randomUUID()}`,
        mfa: { method: "totp", code: totp(u.secret, now()) },
      },
    );
    expect(outcome(reset)).toBe("429 RATE_LIMITED");
    expect(
      (
        await new ApiClient("anon").post("/auth/password-reset/verify", {
          token: t.token,
        })
      ).status,
    ).toBe(200);
  });
});

describe("F-45: at most 5 checks per password-reset token", () => {
  it("a parallel burst of 10 wrong codes on one reset token runs at most 5 checks, then the token is invalid", async () => {
    const u = await createUserWithTotp();
    const t = oneTimeToken();
    await dal().tokens.issuePasswordResetToken(u.userId, t.hash);
    const c = new ApiClient("anon");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        c.post("/auth/password-reset/complete", {
          token: t.token,
          newPassword: `pw-${randomUUID()}`,
          mfa: { method: "totp", code: wrongTotp(u.secret, now()) },
        }),
      ),
    );
    const kinds = results.map(outcome);
    expect(kinds.filter((k) => k === "401 MFA_FAILED").length).toBe(5);
    for (const r of results.filter((x) => codeOf(x) !== "MFA_FAILED")) {
      expect(["429 RATE_LIMITED", "400 TOKEN_INVALID"]).toContain(outcome(r));
      if (r.status === 429) expect(r.header("retry-after")).toBe("1");
    }
    const after = await c.post("/auth/password-reset/verify", {
      token: t.token,
    });
    expect(outcome(after)).toBe("400 TOKEN_INVALID");
  });
});

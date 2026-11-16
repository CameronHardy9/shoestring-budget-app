// Notification emails vs auth.md §15 (closed `kind` vocabulary, the P column,
// link paths; test-hooks.md revision 4). support/setup.ts already checks every
// captured email of every test against the table; this file proves the
// vocabulary is actually exercised end to end, kind by kind, and pins the
// sending rules that are easy to regress (F-12, F-34, F-09 priority).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createUserWithTotp,
  enrollTotp,
  signIn,
  startMfaSignIn,
} from "../../support/auth.ts";
import { NOTIFICATIONS } from "../../support/emails.ts";
import { createUser, uniqueEmail } from "../../support/factories.ts";
import { ApiClient, codeOf } from "../../support/http.ts";
import {
  advanceClock,
  DAY,
  dal,
  emails,
  lastEmail,
  MINUTE,
  now,
  signupInvite,
  testLogin,
  tokenFromLink,
} from "../../support/hooks.ts";
import { totp, wrongTotp } from "../../support/totp.ts";
import { enrollPasskey } from "../../support/webauthn.ts";
import { seedWorld } from "../../support/world.ts";

/** Sent only by admin commands (admin-commands.md), never over HTTP. */
const ADMIN_ONLY = new Set(["recovery_codes_retired", "mfa_reset"]);

describe("auth.md §15 vocabulary, exercised through HTTP", () => {
  it("every non-admin kind is sent by the flow the table names, with its priority and link path", async () => {
    const kinds = new Set<string>();
    const collect = async () =>
      (await emails()).forEach((e) => kinds.add(e.kind));
    const anon = new ApiClient("anonymous");

    // signup_invite (the test hook stands in for the admin command)
    const address = uniqueEmail("invitee");
    const token = await signupInvite(address);
    expect(
      (
        await anon.post("/auth/signup", {
          token,
          displayName: "Invitee",
          password: `pw-${randomUUID()}`,
        })
      ).status,
    ).toBe(201);

    // new_sign_in, password_changed, mfa_factor_added/removed, recovery_codes_regenerated, recovery_code_used
    const u = await createUser({ prefix: "notify" });
    const c = await signIn(u);
    const { recoveryCodes } = await enrollTotp(c);
    const { passkeyId } = await enrollPasskey(c);
    expect((await c.post("/me/mfa/recovery-codes")).status).toBe(200);
    expect((await c.delete(`/me/mfa/passkeys/${passkeyId}`)).status).toBe(204);
    const mfaUser = { ...u, secret: "", recoveryCodes };
    const p = await startMfaSignIn(mfaUser);
    const fresh = await c.post<{ recoveryCodes: string[] }>(
      "/me/mfa/recovery-codes",
    );
    expect(
      (
        await p.post("/auth/mfa/verify", {
          method: "recovery_code",
          code: fresh.body.recoveryCodes[0]!,
        })
      ).status,
    ).toBe(200);
    expect(
      (await c.post("/me/password", { newPassword: `pw-${randomUUID()}` }))
        .status,
    ).toBe(204);

    // mfa_failures (5th consecutive failure) and mfa_locked (budget exhausted)
    const m = await createUserWithTotp();
    for (let s = 0; s < 4; s++) {
      const pending = await startMfaSignIn(m);
      for (let i = 0; i < 5; i++)
        await pending.post("/auth/mfa/verify", {
          method: "totp",
          code: wrongTotp(m.secret, now()),
        });
    }

    // password_reset
    expect(
      (await anon.post("/auth/password-reset/request", { email: m.email }))
        .status,
    ).toBe(202);

    // email_change_confirm, email_change_notice, email_changed, email_change_cancelled, email_change_exists
    const e = await createUser({ prefix: "mover" });
    const ec = await testLogin(e.email);
    const target = uniqueEmail("moved");
    await ec.post("/me/email-change", { newEmail: target });
    await ec.post("/auth/email-change/confirm", {
      token: tokenFromLink(
        (await lastEmail(target, "email_change_confirm")).links[0]!,
      ),
    });
    await anon.post("/auth/email-change/cancel", {
      token: tokenFromLink(
        (await lastEmail(e.email, "email_change_notice")).links[0]!,
      ),
    });
    await (
      await testLogin(m.email)
    ).post("/me/email-change", { newEmail: u.email });

    // budget_invitation, invitation_accepted, member_removed, ownership_transferred, budget_deleted, budget_restored
    const w = await seedWorld();
    const invitee = await createUser({ prefix: "joiner" });
    const inv = await w.owner.client.post<{ id: string }>(
      `/budgets/${w.budget.id}/invitations`,
      { email: invitee.email },
    );
    await (
      await testLogin(invitee.email)
    ).post(`/me/invitations/${inv.body.id}/accept`);
    await w.owner.client.delete(
      `/budgets/${w.budget.id}/members/${invitee.userId}`,
    );
    await w.owner.client.post(`/budgets/${w.budget.id}/transfer-ownership`, {
      userId: w.member.user.userId,
    });
    const newOwner = w.member.client;
    await newOwner.delete(`/budgets/${w.budget.id}`, {
      query: {
        version: (
          await newOwner.get<{ version: number }>(`/budgets/${w.budget.id}`)
        ).body.version,
      },
    });
    await newOwner.post(`/me/deleted-budgets/${w.budget.id}/restore`);

    // account_deletion_scheduled, account_deletion_cancelled
    const leaver = await createUser({ prefix: "leaver" });
    await (await testLogin(leaver.email)).post("/me/deletion");
    await (await testLogin(leaver.email)).delete("/me/deletion");
    await collect();

    // login_throttled: 100 failed logins for one email in 24 h. The (email, IP)
    // pair allows 10 per 15 min, so the clock moves 15 minutes every 10 attempts.
    const victim = await createUser({ prefix: "throttled" });
    for (let i = 0; i < 100; i++) {
      if (i > 0 && i % 10 === 0) await advanceClock(15 * MINUTE);
      const r = await anon.post("/auth/login", {
        email: victim.email,
        password: "definitely wrong",
      });
      expect(codeOf(r), `attempt ${i + 1}`).toBe("INVALID_CREDENTIALS");
    }
    expect((await emails(victim.email)).map((x) => x.kind)).toEqual([
      "login_throttled",
    ]);
    await advanceClock(15 * MINUTE);
    const blocked = await anon.post("/auth/login", {
      email: victim.email,
      password: victim.password,
    });
    expect(codeOf(blocked)).toBe("RATE_LIMITED");
    await collect();

    const expected = [...NOTIFICATIONS.keys()]
      .filter((k) => !ADMIN_ONLY.has(k))
      .sort();
    expect([...kinds].sort()).toEqual(expected);
  });
});

describe("sending rules", () => {
  it("F-34: every successful sign-in sends new_sign_in, even from the same browser again; sign-up sends none", async () => {
    const u = await createUser({ prefix: "again" });
    await signIn(u);
    await signIn(u);
    await signIn(u);
    expect(
      (await emails(u.email)).filter((e) => e.kind === "new_sign_in"),
    ).toHaveLength(3);

    const address = uniqueEmail("fresh");
    const token = await signupInvite(address);
    await new ApiClient("x").post("/auth/signup", {
      token,
      displayName: "Fresh",
      password: `pw-${randomUUID()}`,
    });
    expect((await emails(address)).map((e) => e.kind)).toEqual([
      "signup_invite",
    ]);
  });

  it("an MFA sign-in sends new_sign_in only after the second factor, not after the password", async () => {
    const u = await createUserWithTotp();
    const pending = await startMfaSignIn(u);
    expect(
      (await emails(u.email)).filter((e) => e.kind === "new_sign_in"),
    ).toHaveLength(0);
    await pending.post("/auth/mfa/verify", {
      method: "totp",
      code: totp(u.secret, now()),
    });
    expect(
      (await emails(u.email)).filter((e) => e.kind === "new_sign_in"),
    ).toHaveLength(1);
  });

  it("a member leaving by themself mails nobody; budget_invitation goes only to existing accounts", async () => {
    const w = await seedWorld();
    await w.member.client.delete(
      `/budgets/${w.budget.id}/members/${w.member.user.userId}`,
    );
    expect(await emails()).toEqual([]);
    const ghost = uniqueEmail("ghost");
    await w.owner.client.post(`/budgets/${w.budget.id}/invitations`, {
      email: ghost,
    });
    expect(await emails(ghost)).toEqual([]);
  });

  it("F-09: past 60% of the daily email budget only priority mail is sent; at the quota nothing is", async () => {
    // The app-wide counter (auth.md §14 email-budget) is keyed by SHA-256 of a
    // fixed constant shared by the server and the admin jobs; it is seeded here
    // through the DAL instead of sending 60 real mails. Quota in e2e: 100.
    const key = { scope: "email:daily", keyHash: createHash("sha256").update("email:daily\0app").digest() };
    const day = new Date(Math.floor(now().getTime() / DAY) * DAY);
    const u = await createUser({ prefix: "busy" });
    expect(await dal().throttles.hitThrottle(key, day, 60)).toBe(60);

    const reset = await new ApiClient("x").post("/auth/password-reset/request", { email: u.email });
    expect(reset.status).toBe(202); // same answer, mail silently dropped
    await signIn(u);
    expect((await emails(u.email)).map((e) => e.kind), "non-priority password_reset must be dropped, priority new_sign_in sent").toEqual(["new_sign_in"]);

    expect(await dal().throttles.hitThrottle(key, day, 39)).toBe(100);
    await signIn(u);
    expect((await emails(u.email)).map((e) => e.kind), "nothing is sent at the quota").toEqual(["new_sign_in"]);
  });
});

import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../context.ts";
import {
  csrf,
  expectDalError,
  expectPgError,
  fakePasswordHash,
  hash32,
  newBudget,
  newUser,
  uniqueEmail,
} from "../test-support/fixtures.ts";
import { START, useTestDb } from "../test-support/harness.ts";

const t = useTestDb();

const session = (userId: string, status: "active" | "mfa_pending" = "active") =>
  t.dal.sessions.createSession({
    userId,
    tokenHash: hash32(),
    csrfToken: csrf(),
    status,
    deviceBrowser: "safari",
    deviceOs: "ios",
  });

const codes = () => ({
  keyId: "k1",
  hashes: Array.from({ length: 10 }, hash32),
});

describe("sign-up invites", () => {
  it("consumes the invite once, uses its email, and revokes older open invites", async () => {
    const email = uniqueEmail();
    const first = hash32();
    const second = hash32();
    await t.dal.signup.createSignupInvite(email, first);
    await t.dal.signup.createSignupInvite(email.toUpperCase(), second);
    await expectDalError(
      t.dal.signup.previewSignupInvite(first),
      "INVITATION_INVALID",
    );
    expect(await t.dal.signup.previewSignupInvite(second)).toEqual({ email });
    const { userId } = await t.dal.signup.signUpWithInvite({
      tokenHash: second,
      displayName: "New Person",
      passwordHash: fakePasswordHash(),
    });
    const me = await t.dal.users.getMe(userId);
    expect(me).toMatchObject({
      email,
      displayName: "New Person",
      status: "active",
      deletion: null,
      mfa: { enabled: false },
    });
    await expectDalError(
      t.dal.signup.signUpWithInvite({
        tokenHash: second,
        displayName: "Again",
        passwordHash: fakePasswordHash(),
      }),
      "INVITATION_INVALID",
    );
    await expectDalError(
      t.dal.signup.createSignupInvite(email, hash32()),
      "ALREADY_EXISTS",
    );
  });

  it("expires after 7 days and stores only argon2id hashes", async () => {
    const tok = hash32();
    await t.dal.signup.createSignupInvite(uniqueEmail(), tok);
    t.clock.advance(7 * DAY_MS);
    await expectDalError(
      t.dal.signup.previewSignupInvite(tok),
      "INVITATION_INVALID",
    );
    t.clock.set(START);
    const { userId } = await newUser(t.dal);
    await expectPgError(
      t.app.query(
        "update users set password_hash = 'plaintext' where id = $1",
        [userId],
      ),
      "23514",
    );
  });
});

describe("sessions", () => {
  it("creates active sessions with 30-day sliding and 90-day absolute expiry", async () => {
    const { userId } = await newUser(t.dal);
    const tokenHash = hash32();
    const s = await t.dal.sessions.createSession({
      userId,
      tokenHash,
      csrfToken: csrf(),
      status: "active",
      deviceBrowser: "chrome",
      deviceOs: "android",
    });
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBe(30 * DAY_MS);
    expect(s.absoluteExpiresAt.getTime() - s.createdAt.getTime()).toBe(
      90 * DAY_MS,
    );
    expect(s.reauthAt).toEqual(s.createdAt);
    expect(
      (await t.dal.sessions.findSessionByTokenHash(tokenHash))?.session.id,
    ).toBe(s.id);

    expect(await t.dal.sessions.touchSession(s.id)).toBeNull(); // seen less than an hour ago
    for (let day = 1; day <= 89; day++) {
      t.clock.set(new Date(Date.parse(START) + day * DAY_MS));
      await t.dal.sessions.touchSession(s.id);
    }
    const after = await t.dal.sessions.findSessionByTokenHash(tokenHash);
    expect(after?.session.expiresAt).toEqual(s.absoluteExpiresAt); // capped, never extended
    t.clock.set(new Date(s.absoluteExpiresAt.getTime()));
    expect(await t.dal.sessions.findSessionByTokenHash(tokenHash)).toBeNull();
    t.clock.set(START);
  });

  it("expires after 30 idle days", async () => {
    const { userId } = await newUser(t.dal);
    const tokenHash = hash32();
    await t.dal.sessions.createSession({
      userId,
      tokenHash,
      csrfToken: csrf(),
      status: "active",
      deviceBrowser: "chrome",
      deviceOs: "android",
    });
    t.clock.advance(30 * DAY_MS);
    expect(await t.dal.sessions.findSessionByTokenHash(tokenHash)).toBeNull();
    t.clock.set(START);
  });

  it("caps active sessions at 20 and pending at 5 without pending evicting active", async () => {
    const { userId } = await newUser(t.dal);
    const actives: { id: string }[] = [];
    for (let i = 0; i < 21; i++) {
      t.clock.advance(1000);
      actives.push(await session(userId));
    }
    const listed = await t.dal.sessions.listSessions(userId);
    expect(listed).toHaveLength(20);
    expect(listed.some((s) => s.id === actives[0]?.id)).toBe(false); // least recently seen evicted
    for (let i = 0; i < 6; i++) await session(userId, "mfa_pending");
    const counts = await t.admin.query<{ status: string; n: number }>(
      "select status, count(*)::int as n from sessions where user_id = $1 group by status order by status",
      [userId],
    );
    expect(counts.rows).toEqual([
      { status: "mfa_pending", n: 5 },
      { status: "active", n: 20 },
    ]);
    t.clock.set(START);
  });

  it("completes MFA by replacing the pending session; 5 failures delete it", async () => {
    const { userId } = await newUser(t.dal);
    const pending = await session(userId, "mfa_pending");
    expect(pending.expiresAt.getTime() - pending.createdAt.getTime()).toBe(
      10 * MINUTE_MS,
    );
    expect(await t.dal.sessions.touchSession(pending.id)).toBeNull();
    const active = await t.dal.sessions.completeMfaSession(pending.id, {
      tokenHash: hash32(),
      csrfToken: csrf(),
    });
    expect(active).toMatchObject({ status: "active", deviceBrowser: "safari" });
    expect(active?.mfaVerifiedAt).toEqual(active?.createdAt);
    expect(
      await t.dal.sessions.completeMfaSession(pending.id, {
        tokenHash: hash32(),
        csrfToken: csrf(),
      }),
    ).toBeNull();

    const p2 = await session(userId, "mfa_pending");
    for (let i = 1; i <= 4; i++)
      expect(await t.dal.sessions.recordSessionMfaFailure(p2.id)).toEqual({
        attempts: i,
        deleted: false,
      });
    expect(await t.dal.sessions.recordSessionMfaFailure(p2.id)).toEqual({
      attempts: 5,
      deleted: true,
    });
    await expectPgError(
      t.app.query(
        "insert into sessions (id, user_id, token_hash, csrf_token, status, created_at, updated_at, last_seen_at, expires_at, absolute_expires_at, reauth_at, device_browser, device_os) values (gen_random_uuid(), $1, $2, $3, 'mfa_pending', now(), now(), now(), now() + interval '1 day', now() + interval '90 days', now(), 'other', 'other')",
        [userId, hash32(), csrf()],
      ),
      "23514",
    );
  });

  it("revokes one, others, or all, and only the caller's own", async () => {
    const { userId } = await newUser(t.dal);
    const other = await newUser(t.dal);
    const [a, b, c] = [
      await session(userId),
      await session(userId),
      await session(userId),
    ];
    const theirs = await session(other.userId);
    await expectDalError(
      t.dal.sessions.revokeSession(userId, theirs.id),
      "NOT_FOUND",
    );
    await t.dal.sessions.revokeSession(userId, a.id);
    expect(await t.dal.sessions.revokeOtherSessions(userId, b.id)).toEqual({
      revokedSessions: 1,
    });
    expect(
      (await t.dal.sessions.listSessions(userId)).map((s) => s.id),
    ).toEqual([b.id]);
    expect(c.id).toBeDefined();
    expect(
      await t.dal.sessions.revokeAllSessionsForUser(userId, { dryRun: true }),
    ).toEqual({ sessions: 1, tokens: 0 });
    expect(await t.dal.sessions.revokeAllSessionsForUser(userId)).toEqual({
      sessions: 1,
      tokens: 0,
    });
    await t.dal.sessions.markReauthenticated(theirs.id, { mfaVerified: true });
  });
});

describe("password reset and F-01", () => {
  it("replaces open reset tokens, invalidates after 5 MFA failures, and revokes everything on completion", async () => {
    const { userId } = await newUser(t.dal);
    const s1 = await session(userId);
    const first = hash32();
    await t.dal.tokens.issuePasswordResetToken(userId, first);
    const second = hash32();
    const { tokenId } = await t.dal.tokens.issuePasswordResetToken(
      userId,
      second,
    );
    expect(
      await t.dal.tokens.findValidUserToken(first, "password_reset"),
    ).toBeNull();
    expect(
      (await t.dal.tokens.findValidUserToken(second, "password_reset"))?.id,
    ).toBe(tokenId);
    const res = await t.dal.tokens.completePasswordReset(
      second,
      fakePasswordHash(),
    );
    expect(res).toEqual({ userId, revokedSessions: 1 });
    expect(await t.dal.sessions.findSessionByTokenHash(hash32())).toBeNull();
    await expectDalError(
      t.dal.tokens.completePasswordReset(second, fakePasswordHash()),
      "TOKEN_INVALID",
    );
    expect(s1.id).toBeDefined();

    const third = hash32();
    const issued = await t.dal.tokens.issuePasswordResetToken(userId, third);
    for (let i = 1; i < 5; i++)
      expect(
        (await t.dal.tokens.recordTokenMfaFailure(issued.tokenId)).invalidated,
      ).toBe(false);
    expect(await t.dal.tokens.recordTokenMfaFailure(issued.tokenId)).toEqual({
      attempts: 5,
      invalidated: true,
    });
    await expectDalError(
      t.dal.tokens.completePasswordReset(third, fakePasswordHash()),
      "TOKEN_INVALID",
    );
    const fourth = hash32();
    await t.dal.tokens.issuePasswordResetToken(userId, fourth);
    t.clock.advance(30 * MINUTE_MS);
    expect(
      await t.dal.tokens.findValidUserToken(fourth, "password_reset"),
    ).toBeNull();
    t.clock.set(START);
  });

  it("a password change kills an open reset token (then confirm gives TOKEN_INVALID)", async () => {
    const { userId } = await newUser(t.dal);
    const s = await session(userId);
    const reset = hash32();
    await t.dal.tokens.issuePasswordResetToken(userId, reset);
    await t.dal.users.changePassword(userId, fakePasswordHash(), s.id);
    await expectDalError(
      t.dal.tokens.completePasswordReset(reset, fakePasswordHash()),
      "TOKEN_INVALID",
    );
  });
});

describe("email change (F-01, F-33)", () => {
  it("confirms only from a session of the same user, then rate-limits for 24 h", async () => {
    const user = await newUser(t.dal);
    const other = await newUser(t.dal);
    const s = await session(user.userId);
    const s2 = await session(user.userId);
    const theirs = await session(other.userId);
    const change = hash32();
    const newEmail = uniqueEmail("new");
    const req = await t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail,
      changeTokenHash: change,
      cancelTokenHash: hash32(),
    });
    expect(req).toMatchObject({ outcome: "created", oldEmail: user.email });
    await expectDalError(
      t.dal.tokens.confirmEmailChange({
        tokenHash: change,
        userId: other.userId,
        sessionId: theirs.id,
      }),
      "TOKEN_INVALID",
    );
    const done = await t.dal.tokens.confirmEmailChange({
      tokenHash: change,
      userId: user.userId,
      sessionId: s.id,
    });
    expect(done).toEqual({
      oldEmail: user.email,
      newEmail,
      revokedSessions: 1,
    });
    expect(s2.id).toBeDefined();
    const limited = t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail: uniqueEmail(),
      changeTokenHash: hash32(),
      cancelTokenHash: hash32(),
    });
    await expect(limited).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 24 * 3600,
    });
    const taken = await t.dal.tokens.requestEmailChange({
      userId: other.userId,
      sessionId: theirs.id,
      newEmail,
      changeTokenHash: hash32(),
      cancelTokenHash: hash32(),
    });
    expect(taken).toEqual({ outcome: "email_taken" });
  });

  it("revoking the requesting session deletes the change token", async () => {
    const user = await newUser(t.dal);
    const s = await session(user.userId);
    const change = hash32();
    await t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail: uniqueEmail(),
      changeTokenHash: change,
      cancelTokenHash: hash32(),
    });
    await t.dal.sessions.deleteSession(s.id);
    expect(
      await t.dal.tokens.findValidUserToken(change, "email_change"),
    ).toBeNull();
  });

  it("chain: cancel_B cancels B->C and keeps cancel_A; cancel_A then reverts to A", async () => {
    const user = await newUser(t.dal);
    const a = user.email;
    const b = uniqueEmail("b");
    const c = uniqueEmail("c");
    const s = await session(user.userId);
    const cancelA = hash32();
    const changeB = hash32();
    await t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail: b,
      changeTokenHash: changeB,
      cancelTokenHash: cancelA,
    });
    await t.dal.tokens.confirmEmailChange({
      tokenHash: changeB,
      userId: user.userId,
      sessionId: s.id,
    });
    // The API refuses a second change within 24 h, so the pending B->C and its
    // newer cancel_B are inserted directly (auth.md §9 regression test 2).
    t.clock.advance(MINUTE_MS);
    const cancelB = hash32();
    const changeC = hash32();
    const now = t.clock.clock();
    await t.admin.query(
      `insert into user_tokens (id, user_id, purpose, token_hash, email, requested_by_session_id, created_at, updated_at, expires_at)
       values (gen_random_uuid(), $1, 'email_change', $2, $3, $4, $5, $5, $5::timestamptz + interval '24 hours'),
              (gen_random_uuid(), $1, 'email_change_cancel', $6, $7, null, $5, $5, $5::timestamptz + interval '24 hours')`,
      [user.userId, changeC, c, s.id, now, cancelB, b],
    );

    const r1 = await t.dal.tokens.cancelEmailChange(cancelB);
    expect(r1).toMatchObject({
      outcome: "cancelled",
      keptEmail: b,
      abandonedEmail: c,
    });
    expect((await t.dal.users.getMe(user.userId)).email).toBe(b);
    expect(
      await t.dal.tokens.findValidUserToken(cancelA, "email_change_cancel"),
    ).not.toBeNull();
    expect(
      await t.dal.tokens.findValidUserToken(changeC, "email_change"),
    ).toBeNull();

    const r2 = await t.dal.tokens.cancelEmailChange(cancelA);
    expect(r2).toMatchObject({
      outcome: "reverted",
      keptEmail: a,
      abandonedEmail: b,
    });
    expect((await t.dal.users.getMe(user.userId)).email).toBe(a);
    expect(await t.dal.sessions.listSessions(user.userId)).toEqual([]);
    await expectDalError(
      t.dal.tokens.cancelEmailChange(cancelA),
      "TOKEN_INVALID",
    );
    t.clock.set(START);
  });

  it("using an earlier cancel token deletes later cancel tokens; a later one never deletes an earlier one", async () => {
    const user = await newUser(t.dal);
    const s = await session(user.userId);
    const early = hash32();
    await t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail: uniqueEmail(),
      changeTokenHash: hash32(),
      cancelTokenHash: early,
    });
    t.clock.advance(1000);
    const late = hash32();
    const now = t.clock.clock();
    await t.admin.query(
      "insert into user_tokens (id, user_id, purpose, token_hash, email, created_at, updated_at, expires_at) values (gen_random_uuid(), $1, 'email_change_cancel', $2, $3, $4, $4, $4::timestamptz + interval '24 hours')",
      [user.userId, late, user.email, now],
    );
    await t.dal.tokens.cancelEmailChange(early);
    expect(
      await t.dal.tokens.findValidUserToken(late, "email_change_cancel"),
    ).toBeNull();
    t.clock.set(START);
  });

  it("cancel tokens survive revocation events; restore mode deletes them", async () => {
    const user = await newUser(t.dal);
    const s = await session(user.userId);
    const cancel = hash32();
    await t.dal.tokens.requestEmailChange({
      userId: user.userId,
      sessionId: s.id,
      newEmail: uniqueEmail(),
      changeTokenHash: hash32(),
      cancelTokenHash: cancel,
    });
    await t.dal.users.changePassword(user.userId, fakePasswordHash(), s.id);
    await t.dal.sessions.revokeAllSessionsForUser(user.userId);
    await t.dal.users.requestAccountDeletion(user.userId);
    expect(
      await t.dal.tokens.findValidUserToken(cancel, "email_change_cancel"),
    ).not.toBeNull();
    await t.dal.sessions.revokeAllSessions({ restore: true });
    expect(
      await t.dal.tokens.findValidUserToken(cancel, "email_change_cancel"),
    ).toBeNull();
  });
});

describe("MFA", () => {
  it("TOTP: setup, first-factor recovery codes, replay protection, removal", async () => {
    const { userId } = await newUser(t.dal);
    await t.dal.mfa.beginTotpSetup(userId, {
      keyId: "k1",
      ciphertext: hash32(),
    });
    expect(await t.dal.mfa.getTotpSecret(userId, "confirmed")).toBeNull();
    expect(
      await t.dal.mfa.getTotpSecret(userId, "pending_setup"),
    ).toMatchObject({ keyId: "k1", confirmed: false });
    const reset = hash32();
    await t.dal.tokens.issuePasswordResetToken(userId, reset);
    expect(
      await t.dal.mfa.confirmTotpSetup(userId, {
        step: 100,
        recoveryCodes: codes(),
      }),
    ).toEqual({ recoveryCodesCreated: true });
    expect(
      await t.dal.tokens.findValidUserToken(reset, "password_reset"),
    ).toBeNull(); // F-01
    await expectDalError(
      t.dal.mfa.beginTotpSetup(userId, { keyId: "k1", ciphertext: hash32() }),
      "ALREADY_EXISTS",
    );
    expect(await t.dal.mfa.useTotpStep(userId, 100)).toBe(false);
    expect(await t.dal.mfa.useTotpStep(userId, 101)).toBe(true);
    expect(await t.dal.mfa.useTotpStep(userId, 101)).toBe(false);
    expect(await t.dal.mfa.getMfaSummary(userId)).toEqual({
      enabled: true,
      totp: true,
      passkeyCount: 0,
      recoveryCodesRemaining: 10,
    });

    const unused = await t.dal.mfa.listUnusedRecoveryCodes(userId);
    expect(await t.dal.mfa.useRecoveryCode(userId, unused[0]!.id)).toBe(true);
    expect(await t.dal.mfa.useRecoveryCode(userId, unused[0]!.id)).toBe(false);
    expect(await t.dal.mfa.removeTotp(userId)).toEqual({ mfaDisabled: true });
    expect(await t.dal.mfa.getMfaSummary(userId)).toEqual({
      enabled: false,
      totp: false,
      passkeyCount: 0,
      recoveryCodesRemaining: 0,
    });
    await expectDalError(t.dal.mfa.removeTotp(userId), "NOT_FOUND");
    await expectDalError(
      t.dal.mfa.regenerateRecoveryCodes(userId, codes()),
      "MFA_NOT_ENABLED",
    );
  });

  it("TOTP setup expires after 15 minutes", async () => {
    const { userId } = await newUser(t.dal);
    await t.dal.mfa.beginTotpSetup(userId, {
      keyId: "k1",
      ciphertext: hash32(),
    });
    t.clock.advance(15 * MINUTE_MS);
    await expectDalError(
      t.dal.mfa.confirmTotpSetup(userId, { step: 1, recoveryCodes: codes() }),
      "NOT_FOUND",
    );
    t.clock.set(START);
  });

  it("passkeys: limit 10, duplicates, second factor keeps codes, challenges are single use", async () => {
    const { userId } = await newUser(t.dal);
    const first = await t.dal.mfa.addPasskey(userId, {
      credentialId: hash32(),
      publicKey: hash32(),
      signCount: 0,
      transports: ["internal"],
      name: "Phone",
      recoveryCodes: codes(),
    });
    expect(first.recoveryCodesCreated).toBe(true);
    const dup = hash32();
    const second = await t.dal.mfa.addPasskey(userId, {
      credentialId: dup,
      publicKey: hash32(),
      signCount: 0,
      transports: [],
      name: "Key",
      recoveryCodes: codes(),
    });
    expect(second.recoveryCodesCreated).toBe(false);
    await expectDalError(
      t.dal.mfa.addPasskey(userId, {
        credentialId: dup,
        publicKey: hash32(),
        signCount: 0,
        transports: [],
        name: "Dup",
        recoveryCodes: codes(),
      }),
      "ALREADY_EXISTS",
    );
    for (let i = 2; i < 10; i++)
      await t.dal.mfa.addPasskey(userId, {
        credentialId: hash32(),
        publicKey: hash32(),
        signCount: 0,
        transports: [],
        name: `K${i}`,
        recoveryCodes: codes(),
      });
    await expectDalError(
      t.dal.mfa.addPasskey(userId, {
        credentialId: hash32(),
        publicKey: hash32(),
        signCount: 0,
        transports: [],
        name: "K10",
        recoveryCodes: codes(),
      }),
      "LIMIT_REACHED",
    );
    await t.dal.mfa.recordPasskeyUse(userId, first.passkeyId, 5);
    expect(
      (await t.dal.mfa.listPasskeyCredentials(userId)).find(
        (p) => p.id === first.passkeyId,
      )?.signCount,
    ).toBe(5);
    const other = await newUser(t.dal);
    await expectDalError(
      t.dal.mfa.removePasskey(other.userId, first.passkeyId),
      "NOT_FOUND",
    );
    expect(await t.dal.mfa.removePasskey(userId, first.passkeyId)).toEqual({
      mfaDisabled: false,
    });

    const s = await session(userId);
    await t.dal.mfa.createWebAuthnChallenge(
      userId,
      { purpose: "reauth", sessionId: s.id },
      hash32(),
    );
    const ch = hash32();
    await t.dal.mfa.createWebAuthnChallenge(
      userId,
      { purpose: "reauth", sessionId: s.id },
      ch,
    );
    expect(
      await t.dal.mfa.consumeWebAuthnChallenge({
        purpose: "mfa",
        sessionId: s.id,
      }),
    ).toBeNull(); // wrong purpose consumes it
    await t.dal.mfa.createWebAuthnChallenge(
      userId,
      { purpose: "reauth", sessionId: s.id },
      ch,
    );
    expect(
      await t.dal.mfa.consumeWebAuthnChallenge({
        purpose: "reauth",
        sessionId: s.id,
      }),
    ).toEqual({ userId, challenge: ch });
    expect(
      await t.dal.mfa.consumeWebAuthnChallenge({
        purpose: "reauth",
        sessionId: s.id,
      }),
    ).toBeNull();
    await t.dal.mfa.createWebAuthnChallenge(
      userId,
      { purpose: "reauth", sessionId: s.id },
      ch,
    );
    t.clock.advance(5 * MINUTE_MS);
    expect(
      await t.dal.mfa.consumeWebAuthnChallenge({
        purpose: "reauth",
        sessionId: s.id,
      }),
    ).toBeNull();
    t.clock.set(START);
  });

  it("keyring: key IDs in use, rewrap, retire recovery codes, admin reset", async () => {
    const { userId } = await newUser(t.dal);
    await t.dal.mfa.beginTotpSetup(userId, {
      keyId: "k7",
      ciphertext: hash32(),
    });
    await t.dal.mfa.confirmTotpSetup(userId, {
      step: 1,
      recoveryCodes: {
        keyId: "k7",
        hashes: Array.from({ length: 10 }, hash32),
      },
    });
    expect(await t.dal.mfa.listKeyIdsInUse()).toContain("k7");
    expect(
      (await t.dal.mfa.countMfaRowsByKeyId()).find((r) => r.keyId === "k7"),
    ).toEqual({ keyId: "k7", totp: 1, recoveryCodes: 10 });
    const batch = await t.dal.mfa.listTotpSecretsToRewrap("k8");
    expect(batch.some((b) => b.userId === userId)).toBe(true);
    expect(
      await t.dal.mfa.rewrapTotpSecret(userId, {
        fromKeyId: "k7",
        toKeyId: "k8",
        ciphertext: hash32(),
      }),
    ).toBe(true);
    expect(
      await t.dal.mfa.rewrapTotpSecret(userId, {
        fromKeyId: "k7",
        toKeyId: "k8",
        ciphertext: hash32(),
      }),
    ).toBe(false);
    expect(await t.dal.mfa.retireRecoveryCodes("k7", { dryRun: true })).toEqual(
      { affectedUserIds: [userId], codes: 10 },
    );
    expect(await t.dal.mfa.retireRecoveryCodes("k7")).toEqual({
      affectedUserIds: [userId],
      codes: 10,
    });
    expect(await t.dal.mfa.retireRecoveryCodes("k7")).toEqual({
      affectedUserIds: [],
      codes: 0,
    });
    expect(await t.dal.mfa.listKeyIdsInUse()).not.toContain("k7");
    const events = await t.dal.securityEvents.listSecurityEventsForUser(userId);
    expect(events.map((e) => e.type)).toContain("recovery_codes_retired");

    await session(userId);
    expect(await t.dal.mfa.resetMfa(userId)).toEqual({ revokedSessions: 1 });
    expect((await t.dal.mfa.getMfaSummary(userId)).enabled).toBe(false);
    await expectDalError(t.dal.mfa.resetMfa(userId), "MFA_NOT_ENABLED");
  });
});

describe("account deletion request", () => {
  it("refuses while owning a shared budget, else revokes access and invitations", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const { invitation } = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      member.email,
    );
    await t.dal.invitations.acceptInvitation(member.userId, invitation.id);
    await expectDalError(
      t.dal.users.requestAccountDeletion(owner.userId),
      "OWNS_SHARED_BUDGET",
    );
    await t.dal.members.removeMember(f.scope, member.userId);
    await t.dal.invitations.createBudgetInvitation(f.scope, uniqueEmail());
    await session(owner.userId);
    const res = await t.dal.users.requestAccountDeletion(owner.userId);
    expect(res).toMatchObject({ revokedInvitations: 1, revokedSessions: 1 });
    expect(res.purgeAfter.getTime() - res.requestedAt.getTime()).toBe(
      30 * DAY_MS,
    );
    expect((await t.dal.users.getMe(owner.userId)).deletion).toEqual({
      requestedAt: res.requestedAt,
      purgeAfter: res.purgeAfter,
    });
    expect(
      await t.dal.users.requestAccountDeletion(owner.userId),
    ).toMatchObject({ requestedAt: res.requestedAt });
    await t.dal.users.cancelAccountDeletion(owner.userId);
    await expectDalError(
      t.dal.users.cancelAccountDeletion(owner.userId),
      "NOT_FOUND",
    );
  });

  it("a soft-deleted shared budget does not block the request (F-35)", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const { invitation } = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      member.email,
    );
    await t.dal.invitations.acceptInvitation(member.userId, invitation.id);
    await t.dal.budgets.deleteBudget(f.scope, 1);
    await t.dal.users.requestAccountDeletion(owner.userId);
    // ...and the owner can no longer restore it (restore needs an active owner).
    await expectDalError(
      t.dal.requireDeletedBudgetOwnership(owner.userId, f.budget.id),
      "NOT_FOUND",
    );
  });
});

describe("throttles and security events", () => {
  it("counts per window, sums a rolling range and clears", async () => {
    const key = { scope: "login:email_ip", keyHash: hash32() };
    const w1 = new Date("2026-11-13T15:00:00Z");
    const w2 = new Date("2026-11-13T15:15:00Z");
    expect(await t.dal.throttles.hitThrottle(key, w1)).toBe(1);
    expect(await t.dal.throttles.hitThrottle(key, w1)).toBe(2);
    expect(await t.dal.throttles.hitThrottle(key, w2, 3)).toBe(3);
    expect(await t.dal.throttles.sumThrottle(key, w1)).toBe(5);
    expect(await t.dal.throttles.sumThrottle(key, w2)).toBe(3);
    await t.dal.throttles.clearThrottle(key);
    expect(await t.dal.throttles.sumThrottle(key, w1)).toBe(0);
  });

  it("records events; the app role cannot change or delete them", async () => {
    const { userId } = await newUser(t.dal);
    await t.dal.securityEvents.recordSecurityEvent({
      type: "login_succeeded",
      userId,
      deviceBrowser: "safari",
      deviceOs: "ios",
      ip: "203.0.113.7",
    });
    await t.dal.securityEvents.recordSecurityEvent({
      type: "login_failed",
      userId: null,
      ip: "203.0.113.8",
    });
    const events = await t.dal.securityEvents.listSecurityEventsForUser(userId);
    expect(events[0]).toMatchObject({
      type: "login_succeeded",
      ip: "203.0.113.7",
      deviceOs: "ios",
    });
    await expectPgError(
      t.app.query(
        "update security_events set type = 'logout' where user_id = $1",
        [userId],
      ),
      "42501",
    );
    await expectPgError(
      t.app.query("delete from security_events where user_id = $1", [userId]),
      "42501",
    );
    await expectPgError(t.app.query("truncate security_events"), "42501");
    t.clock.advance(HOUR_MS);
    t.clock.set(START);
  });
});

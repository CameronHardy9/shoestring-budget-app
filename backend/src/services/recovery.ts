// Password reset (auth.md §8: never bypasses MFA) and email change with
// cancel/revert (auth.md §9, F-01, F-33, R-11). One-time tokens are 32 random
// bytes in the URL fragment of an APP_ORIGIN link; only SHA-256 is stored.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../auth/session.ts";
import { clearCookie } from "../auth/session.ts";
import { authenticationOptions, newChallenge } from "../auth/webauthn.ts";
import { randomToken, sha256 } from "../crypto/keyring.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError, fieldError, validationFailed } from "../errors.ts";
import { DAY, HOUR, ipKey } from "../http/rate-limit.ts";
import type { MfaProofInput } from "./mfa.ts";
import { assertMfaBudget, refusedAttempt, relyingParty, verifySecondFactor } from "./mfa.ts";
import { mfaMethods } from "../auth/session.ts";

// ---------------------------------------------------------------- password reset

/** password-reset-request, IP row: 5 per hour (429). */
export async function resetRequestIpLimit(
  deps: AppDeps,
  req: FastifyRequest,
): Promise<void> {
  await deps.throttles.hitOrThrow(
    deps.throttles.key("reset-request:ip", ipKey(req.ip)),
    5,
    HOUR,
  );
}

/** password-reset-complete row: 20 per hour per IP across verify, webauthn-challenge and complete. */
export async function resetTokenIpLimit(
  deps: AppDeps,
  req: FastifyRequest,
): Promise<void> {
  await deps.throttles.hitOrThrow(
    deps.throttles.key("reset-complete:ip", ipKey(req.ip)),
    20,
    HOUR,
  );
}

/**
 * POST /auth/password-reset/request: always 202 (the route pads to 1 s).
 * Mails a 30-minute token when the account exists and the silent per-email
 * limits (3 per hour, 5 per 24 h, F-09) allow it.
 */
export async function requestPasswordReset(
  deps: AppDeps,
  req: FastifyRequest,
  email: string,
): Promise<void> {
  const t = deps.throttles;
  const hourKey = t.key("reset-request:email_hour", email);
  const dayKey = t.key("reset-request:email_day", email);
  if (
    (await t.count(hourKey, HOUR)) >= 3 ||
    (await t.rollingCount(dayKey, DAY)) >= 5
  )
    return;
  await t.hit(hourKey, HOUR);
  await t.rollingHit(dayKey, DAY);
  const userId = await deps.dal.users.findUserIdByEmail(email);
  if (!userId) return;
  const token = randomToken();
  await deps.dal.tokens.issuePasswordResetToken(userId, sha256(token));
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "password_reset_requested",
    userId,
    ip: req.ip,
  });
  await deps.mailer.send(deps.notifications.passwordReset(email, token));
}

async function validResetToken(deps: AppDeps, token: string) {
  const row = await deps.dal.tokens.findValidUserToken(
    sha256(token),
    "password_reset",
  );
  if (!row) throw new ApiError("TOKEN_INVALID");
  return row;
}

export async function verifyResetToken(deps: AppDeps, token: string) {
  const row = await validResetToken(deps, token);
  const mfa = await deps.dal.mfa.getMfaSummary(row.userId);
  return {
    mfaRequired: mfa.enabled,
    mfaMethods: mfa.enabled ? mfaMethods(mfa) : [],
  };
}

export async function resetWebauthnChallenge(deps: AppDeps, token: string) {
  const row = await validResetToken(deps, token);
  await assertMfaBudget(deps, row.userId);
  const creds = await deps.dal.mfa.listPasskeyCredentials(row.userId);
  if (creds.length === 0) throw new ApiError("MFA_NOT_ENABLED");
  const challenge = newChallenge();
  await deps.dal.mfa.createWebAuthnChallenge(
    row.userId,
    { purpose: "password_reset", userTokenId: row.id },
    challenge,
  );
  return authenticationOptions(relyingParty(deps), creds, challenge);
}

/**
 * POST /auth/password-reset/complete. With MFA enabled a factor is mandatory:
 * missing -> 401 MFA_REQUIRED, wrong -> 401 MFA_FAILED (5 failures invalidate
 * the token; failures count toward the per-user budget). Success sets the
 * password, revokes every session, deletes other open tokens (DAL), clears
 * the per-email login counters and sends the "password changed" notice.
 */
export async function completePasswordReset(
  deps: AppDeps,
  req: FastifyRequest,
  input: {
    token: string;
    newPassword: string;
    mfa?: MfaProofInput | undefined;
  },
): Promise<void> {
  const { dal } = deps;
  const row = await validResetToken(deps, input.token);
  const contact = await dal.users.getUserContact(row.userId);
  // Policy first, so a rejected password does not spend a second factor.
  await deps.passwords.assertAcceptable(input.newPassword, contact.email, {
    in: "body",
    field: "newPassword",
  });
  const mfa = await dal.mfa.getMfaSummary(row.userId);
  if (mfa.enabled) {
    if (input.mfa === undefined) throw new ApiError("MFA_REQUIRED");
    // Per-token slots reserved atomically before the check (F-45); the 5th
    // failure invalidates the token. findValidUserToken already refused a
    // token with 5 recorded failures.
    await verifySecondFactor(deps, row.userId, input.mfa, { kind: "reset", userTokenId: row.id }, {
      async reserve() {
        const r = await dal.tokens.reserveTokenMfaAttempt(row.id);
        if (!r.granted) throw refusedAttempt(r.reason, () => new ApiError("TOKEN_INVALID"));
      },
      async failed() {
        await dal.tokens.failTokenMfaAttempt(row.id);
      },
      release: () => dal.tokens.releaseTokenMfaAttempt(row.id),
    });  }
  const hash = await deps.passwords.hash(input.newPassword);
  const { userId } = await dal.tokens.completePasswordReset(
    sha256(input.token),
    hash,
  );
  const t = deps.throttles;
  await t.clear(t.key("login:email_day", contact.email));
  await t.clear(t.key("login:email_ip", `${contact.email}\0${ipKey(req.ip)}`));
  await dal.securityEvents.recordSecurityEvent({
    type: "password_reset_completed",
    userId,
    ip: req.ip,
  });
  await deps.mailer.send(deps.notifications.passwordChanged(contact.email));
}

// ---------------------------------------------------------------- email change

/** email-change-request: 5 per user per day (429); the DAL adds the one-per-24 h rule (F-33). */
export async function emailChangeRequestLimit(
  deps: AppDeps,
  auth: AuthContext,
): Promise<void> {
  await deps.throttles.assertUnder(
    deps.throttles.key("email-change:user", auth.session.userId),
    5,
    DAY,
  );
}

/** email-change-confirm row: 20 per hour per IP across confirm and cancel. */
export async function emailChangeIpLimit(
  deps: AppDeps,
  req: FastifyRequest,
): Promise<void> {
  await deps.throttles.hitOrThrow(
    deps.throttles.key("email-change:ip", ipKey(req.ip)),
    20,
    HOUR,
  );
}

/** POST /me/email-change: 202 either way (the route pads to 1 s). */
export async function requestEmailChange(
  deps: AppDeps,
  auth: AuthContext,
  newEmail: string,
): Promise<void> {
  const { dal } = deps;
  const userId = auth.session.userId;
  const me = await dal.users.getUserContact(userId);
  if (me.email === newEmail)
    throw validationFailed([fieldError("body", "newEmail", "invalid_value")]);
  const changeToken = randomToken();
  const cancelToken = randomToken();
  const r = await dal.tokens.requestEmailChange({
    userId,
    sessionId: auth.session.id,
    newEmail,
    changeTokenHash: sha256(changeToken),
    cancelTokenHash: sha256(cancelToken),
  });
  await deps.throttles.hit(
    deps.throttles.key("email-change:user", userId),
    DAY,
  );
  await dal.securityEvents.recordSecurityEvent({
    type: "email_change_requested",
    userId,
    sessionId: auth.session.id,
  });
  if (r.outcome === "email_taken") {
    await deps.mailer.send(deps.notifications.emailChangeExists(newEmail));
    return;
  }
  await deps.mailer.sendAll([
    deps.notifications.emailChangeConfirm(newEmail, changeToken),
    deps.notifications.emailChangeNotice(r.oldEmail, cancelToken),
  ]);
}

/**
 * POST /auth/email-change/confirm (an active session of the same user). The
 * old address gets a FRESH cancel link (reissued; the original stays open and
 * the earliest wins, F-33). Both addresses are notified.
 */
export async function confirmEmailChange(
  deps: AppDeps,
  auth: AuthContext,
  token: string,
): Promise<void> {
  const reissue = randomToken();
  const r = await deps.dal.tokens.confirmEmailChange({
    tokenHash: sha256(token),
    userId: auth.session.userId,
    sessionId: auth.session.id,
    reissueCancelTokenHash: sha256(reissue),
  });
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "email_changed",
    userId: auth.session.userId,
    sessionId: auth.session.id,
  });
  await deps.mailer.sendAll([
    deps.notifications.emailChanged(r.newEmail, null),
    deps.notifications.emailChanged(r.oldEmail, reissue),
  ]);
}

/**
 * POST /auth/email-change/cancel (public; the token is the authorization).
 * Cancels a pending change or reverts a confirmed one, revokes every session,
 * and emails both the address kept/restored and the one abandoned (R-11).
 */
export async function cancelEmailChange(
  deps: AppDeps,
  reply: FastifyReply,
  token: string,
): Promise<void> {
  const r = await deps.dal.tokens.cancelEmailChange(sha256(token));
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "email_change_cancelled",
    userId: r.userId,
  });
  clearCookie(deps, reply);
  const to = [
    r.keptEmail,
    ...(r.abandonedEmail && r.abandonedEmail !== r.keptEmail
      ? [r.abandonedEmail]
      : []),
  ];
  await deps.mailer.sendAll(
    to.map((e) => deps.notifications.emailChangeCancelled(e)),
  );
}


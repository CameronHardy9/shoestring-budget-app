// Account self-service (auth.md §2, §6, §7, §11; ADR-0010): password change,
// sessions, MFA enrollment and removal, CSV export, account deletion, and
// deleted-budget restore. Every security change emails a priority notice.
import type { DeletedBudgetScope } from "@shoestring/db";
import type { FastifyReply } from "fastify";
import { generateRecoveryCodes } from "../auth/recovery-codes.ts";
import type { AuthContext } from "../auth/session.ts";
import { clearCookie } from "../auth/session.ts";
import {
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  matchTotp,
  newTotpSecret,
  otpauthUri,
} from "../auth/totp.ts";
import {
  newChallenge,
  registrationOptions,
  verifyRegistration,
} from "../auth/webauthn.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { HOUR, MINUTE } from "../http/rate-limit.ts";
import { iso, toBudget, toMe } from "../http/mappers.ts";
import { relyingParty } from "./mfa.ts";

const TOTP_SETUP_TTL_MS = 15 * MINUTE;
export const EXPORTS_PER_HOUR = 10;
export const TOTP_CONFIRM_FAILURES = 5; // per session / 15 min (mfa-verify row)

async function contact(deps: AppDeps, userId: string) {
  return deps.dal.users.getUserContact(userId);
}

// ---------------------------------------------------------------- password

/** POST /me/password: revokes other sessions and open tokens (DAL, F-01). Never updatePasswordHash. */
export async function changePassword(
  deps: AppDeps,
  auth: AuthContext,
  newPassword: string,
): Promise<void> {
  const userId = auth.session.userId;
  const me = await contact(deps, userId);
  await deps.passwords.assertAcceptable(newPassword, me.email, {
    in: "body",
    field: "newPassword",
  });
  const hash = await deps.passwords.hash(newPassword);
  await deps.dal.users.changePassword(userId, hash, auth.session.id);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "password_changed",
    userId,
    sessionId: auth.session.id,
  });
  await deps.mailer.send(deps.notifications.passwordChanged(me.email));
}

// ---------------------------------------------------------------- sessions

export async function listSessions(deps: AppDeps, auth: AuthContext) {
  const rows = await deps.dal.sessions.listSessions(auth.session.userId);
  return {
    items: rows.slice(0, 20).map((s) => ({
      id: s.id,
      current: s.id === auth.session.id,
      browser: s.browser,
      os: s.os,
      createdAt: iso(s.createdAt),
      lastSeenAt: iso(s.lastSeenAt),
      expiresAt: iso(s.expiresAt),
    })),
  };
}

/** DELETE /me/sessions/{id}: only the caller's own sessions (others' -> 404). Revoking the current one signs out. */
export async function revokeSession(
  deps: AppDeps,
  reply: FastifyReply,
  auth: AuthContext,
  sessionId: string,
) {
  await deps.dal.sessions.revokeSession(auth.session.userId, sessionId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "session_revoked",
    userId: auth.session.userId,
    sessionId: auth.session.id,
  });
  if (sessionId === auth.session.id) clearCookie(deps, reply);
}

export async function revokeOtherSessions(
  deps: AppDeps,
  auth: AuthContext,
): Promise<void> {
  await deps.dal.sessions.revokeOtherSessions(
    auth.session.userId,
    auth.session.id,
  );
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "sessions_revoked_others",
    userId: auth.session.userId,
    sessionId: auth.session.id,
  });
}

// ---------------------------------------------------------------- MFA

export async function getMfa(deps: AppDeps, userId: string) {
  const d = await deps.dal.mfa.getMfaDetail(userId);
  const confirmedAt = (d as { totpConfirmedAt?: unknown }).totpConfirmedAt;
  return {
    enabled: d.enabled,
    // The DAL does not return the confirmation time yet (cross-area request).
    totp: {
      enabled: d.totp,
      confirmedAt: confirmedAt instanceof Date ? iso(confirmedAt) : null,
    },
    passkeys: d.passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: iso(p.createdAt),
      lastUsedAt: p.lastUsedAt ? iso(p.lastUsedAt) : null,
    })),
    recoveryCodesRemaining: d.recoveryCodesRemaining,
  };
}

async function afterFactorAdded(
  deps: AppDeps,
  auth: AuthContext,
  first: boolean,
): Promise<void> {
  const userId = auth.session.userId;
  const sessionId = auth.session.id;
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "mfa_factor_added",
    userId,
    sessionId,
  });
  if (first)
    await deps.dal.securityEvents.recordSecurityEvent({
      type: "mfa_enabled",
      userId,
      sessionId,
    });
  await deps.mailer.send(
    deps.notifications.mfaFactorChanged(
      (await contact(deps, userId)).email,
      true,
    ),
  );
}

async function afterFactorRemoved(
  deps: AppDeps,
  auth: AuthContext,
  disabled: boolean,
): Promise<void> {
  const userId = auth.session.userId;
  const sessionId = auth.session.id;
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "mfa_factor_removed",
    userId,
    sessionId,
  });
  if (disabled)
    await deps.dal.securityEvents.recordSecurityEvent({
      type: "mfa_disabled",
      userId,
      sessionId,
    });
  await deps.mailer.send(
    deps.notifications.mfaFactorChanged(
      (await contact(deps, userId)).email,
      false,
    ),
  );
}

/** POST /me/mfa/totp: a new unconfirmed secret (replaces an unfinished setup). */
export async function beginTotpSetup(deps: AppDeps, auth: AuthContext) {
  const userId = auth.session.userId;
  const me = await contact(deps, userId);
  const secret = newTotpSecret();
  await deps.dal.mfa.beginTotpSetup(
    userId,
    encryptTotpSecret(deps.config.keyring, userId, secret),
  );
  const b32 = base32Encode(secret);
  return {
    secret: b32,
    otpauthUri: otpauthUri(b32, me.email),
    expiresAt: iso(new Date(deps.clock.now().getTime() + TOTP_SETUP_TTL_MS)),
  };
}

export async function totpConfirmLimit(
  deps: AppDeps,
  auth: AuthContext,
): Promise<void> {
  await deps.throttles.assertUnder(
    deps.throttles.key("totp-confirm:session", auth.session.id),
    TOTP_CONFIRM_FAILURES,
    15 * MINUTE,
  );
}

/** POST /me/mfa/totp/confirm: recovery codes only when this is the first factor. */
export async function confirmTotpSetup(
  deps: AppDeps,
  auth: AuthContext,
  code: string,
) {
  const userId = auth.session.userId;
  const row = await deps.dal.mfa.getTotpSecret(userId, "pending_setup");
  if (!row) throw new ApiError("NOT_FOUND");
  const secret = decryptTotpSecret(
    deps.config.keyring,
    row.keyId,
    userId,
    row.ciphertext,
  );
  const step = matchTotp(secret, code, deps.clock.now());
  if (step === null) {
    await deps.throttles.hit(
      deps.throttles.key("totp-confirm:session", auth.session.id),
      15 * MINUTE,
    );
    throw new ApiError("MFA_FAILED");
  }
  const rc = generateRecoveryCodes(deps.config.keyring);
  const { recoveryCodesCreated } = await deps.dal.mfa.confirmTotpSetup(userId, {
    step,
    recoveryCodes: rc.hashes,
  });
  await afterFactorAdded(deps, auth, recoveryCodesCreated);
  return { recoveryCodes: recoveryCodesCreated ? rc.codes : null };
}

export async function removeTotp(
  deps: AppDeps,
  auth: AuthContext,
): Promise<void> {
  const { mfaDisabled } = await deps.dal.mfa.removeTotp(auth.session.userId);
  await afterFactorRemoved(deps, auth, mfaDisabled);
}

/** POST /me/mfa/passkeys/options: 422 LIMIT_REACHED at 10 passkeys. */
export async function passkeyRegistrationOptions(
  deps: AppDeps,
  auth: AuthContext,
) {
  const userId = auth.session.userId;
  const existing = await deps.dal.mfa.listPasskeyCredentials(userId);
  if (existing.length >= 10)
    throw new ApiError("LIMIT_REACHED", {
      details: [
        {
          in: "body",
          field: "",
          issue: "limit",
          message: "A limit was reached.",
        },
      ],
    });
  const me = await contact(deps, userId);
  const challenge = newChallenge();
  await deps.dal.mfa.createWebAuthnChallenge(
    userId,
    { purpose: "register", sessionId: auth.session.id },
    challenge,
  );
  return registrationOptions(
    relyingParty(deps),
    { id: userId, email: me.email, displayName: me.displayName },
    existing,
    challenge,
  );
}

/** POST /me/mfa/passkeys: verifies the registration against this session's challenge. */
export async function registerPasskey(
  deps: AppDeps,
  auth: AuthContext,
  input: { name: string; credential: unknown },
) {
  const userId = auth.session.userId;
  const challenge = await deps.dal.mfa.consumeWebAuthnChallenge({
    purpose: "register",
    sessionId: auth.session.id,
  });
  if (challenge?.userId !== userId) throw new ApiError("MFA_FAILED");
  const v = await verifyRegistration(
    relyingParty(deps),
    input.credential,
    challenge.challenge,
  );
  if (!v) throw new ApiError("MFA_FAILED");
  const rc = generateRecoveryCodes(deps.config.keyring);
  const r = await deps.dal.mfa.addPasskey(userId, {
    ...v,
    name: input.name,
    recoveryCodes: rc.hashes,
  });
  await afterFactorAdded(deps, auth, r.recoveryCodesCreated);
  return {
    passkey: {
      id: r.passkeyId,
      name: input.name,
      createdAt: iso(deps.clock.now()),
      lastUsedAt: null,
    },
    recoveryCodes: r.recoveryCodesCreated ? rc.codes : null,
  };
}

export async function removePasskey(
  deps: AppDeps,
  auth: AuthContext,
  passkeyId: string,
): Promise<void> {
  const { mfaDisabled } = await deps.dal.mfa.removePasskey(
    auth.session.userId,
    passkeyId,
  );
  await afterFactorRemoved(deps, auth, mfaDisabled);
}

export async function regenerateRecoveryCodes(
  deps: AppDeps,
  auth: AuthContext,
) {
  const userId = auth.session.userId;
  const rc = generateRecoveryCodes(deps.config.keyring);
  await deps.dal.mfa.regenerateRecoveryCodes(userId, rc.hashes);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "recovery_codes_regenerated",
    userId,
    sessionId: auth.session.id,
  });
  await deps.mailer.send(
    deps.notifications.recoveryCodesRegenerated(
      (await contact(deps, userId)).email,
    ),
  );
  return { recoveryCodes: rc.codes };
}

// ---------------------------------------------------------------- export and deletion

export async function exportLimit(
  deps: AppDeps,
  auth: AuthContext,
): Promise<void> {
  await deps.throttles.hitOrThrow(
    deps.throttles.key("export:user", auth.session.userId),
    EXPORTS_PER_HOUR,
    HOUR,
  );
}

/** POST /me/export: the CSV (Sensitive; never logged). Every budget goes through requireMembership in the DAL. */
export async function exportCsv(
  deps: AppDeps,
  auth: AuthContext,
  kind: "transactions" | "plans",
) {
  const userId = auth.session.userId;
  const csv =
    kind === "transactions"
      ? await deps.dal.exports.exportTransactionsCsv(userId)
      : await deps.dal.exports.exportPlansCsv(userId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "data_exported",
    userId,
    sessionId: auth.session.id,
  });
  const day = deps.clock.now().toISOString().slice(0, 10);
  return { csv, filename: `shoestring-${kind}-${day}.csv` };
}

/** POST /me/deletion: 409 OWNS_SHARED_BUDGET; else pending for 30 days, every session revoked, cookie cleared. */
export async function requestDeletion(
  deps: AppDeps,
  reply: FastifyReply,
  auth: AuthContext,
) {
  const userId = auth.session.userId;
  const me = await contact(deps, userId);
  const r = await deps.dal.users.requestAccountDeletion(userId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "account_deletion_requested",
    userId,
    sessionId: auth.session.id,
  });
  clearCookie(deps, reply);
  await deps.mailer.send(
    deps.notifications.accountDeletionScheduled(me.email, r.purgeAfter),
  );
  return { requestedAt: iso(r.requestedAt), purgeAfter: iso(r.purgeAfter) };
}

/** DELETE /me/deletion: 404 when nothing is pending. */
export async function cancelDeletion(deps: AppDeps, auth: AuthContext) {
  const userId = auth.session.userId;
  await deps.dal.users.cancelAccountDeletion(userId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "account_deletion_cancelled",
    userId,
    sessionId: auth.session.id,
  });
  const me = await deps.dal.users.getMe(userId);
  await deps.mailer.send(deps.notifications.accountDeletionCancelled(me.email));
  return toMe(me);
}

// ---------------------------------------------------------------- deleted budgets (ADR-0010, F-36, F-37)

export async function listDeletedBudgets(deps: AppDeps, auth: AuthContext) {
  const rows = await deps.dal.budgets.listDeletedBudgets(auth.session.userId);
  return {
    items: rows.map((b) => ({
      id: b.id,
      name: b.name,
      deletedAt: iso(b.deletedAt),
      restorableUntil: iso(b.restorableUntil),
      memberCount: b.memberCount,
    })),
  };
}

/** Restore through a DeletedBudgetScope only (issued by requireDeletedBudgetOwnership in the route layer). */
export async function restoreDeletedBudget(
  deps: AppDeps,
  auth: AuthContext,
  scope: DeletedBudgetScope,
) {
  const { budget, members } =
    await deps.dal.budgets.restoreDeletedBudget(scope);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_restored",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: budget.id,
  });
  await deps.mailer.sendAll(
    members.map((m) =>
      deps.notifications.budgetRestored(m.email, budget.name, budget.id),
    ),
  );
  return toBudget(budget);
}

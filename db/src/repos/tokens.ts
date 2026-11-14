// One-time email tokens: password reset (auth.md §8) and email change with
// cancel/revert (auth.md §9, F-01, F-33). The DAL stores and compares
// SHA-256 hashes only.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { DAY_MS, MINUTE_MS, assertNoTransaction, withTx } from "../context.ts";
import { DalError, isUniqueViolation } from "../errors.ts";
import type { MfaAttemptReservation } from "../records.ts";
import type { UserTokenPurpose } from "../schema.ts";
import { isUuid } from "../scope.ts";
import {
  LIMITS,
  deleteOpenUserTokens,
  lockUser,
  normalizeEmail,
} from "./common.ts";

const RESET_TTL_MS = 30 * MINUTE_MS;
const EMAIL_TTL_MS = DAY_MS;

const tokenInvalid = (): DalError => new DalError("TOKEN_INVALID");

export interface UserTokenRecord {
  id: string;
  userId: string;
  purpose: UserTokenPurpose;
  /** PII: email_change = new address; email_change_cancel = previous address. */
  email: string | null;
  requestedBySessionId: string | null;
  mfaFailedAttempts: number;
  createdAt: Date;
  expiresAt: Date;
}

/** An open (unused, unexpired, a free MFA attempt slot) token of `purpose`, or null. */
export async function findValidUserToken(
  ctx: Ctx,
  tokenHash: Buffer,
  purpose: UserTokenPurpose,
): Promise<UserTokenRecord | null> {
  const row = await ctx.db
    .selectFrom("user_tokens")
    .select([
      "id",
      "user_id",
      "purpose",
      "email",
      "requested_by_session_id",
      "mfa_failed_attempts",
      "created_at",
      "expires_at",
    ])
    .where("token_hash", "=", tokenHash)
    .where("purpose", "=", purpose)
    .where("used_at", "is", null)
    .where("expires_at", ">", ctx.clock())
    .where("mfa_failed_attempts", "<", LIMITS.mfaAttemptsPerSessionOrToken)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    email: row.email,
    requestedBySessionId: row.requested_by_session_id,
    mfaFailedAttempts: row.mfa_failed_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** POST /auth/password-reset/request: a 30-minute token, replacing any open one. */
export async function issuePasswordResetToken(
  ctx: Ctx,
  userId: string,
  tokenHash: Buffer,
): Promise<{ tokenId: string; expiresAt: Date }> {
  return withTx(ctx, async (tx) => {
    const now = tx.clock();
    await tx.db
      .deleteFrom("user_tokens")
      .where("user_id", "=", userId)
      .where("purpose", "=", "password_reset")
      .where("used_at", "is", null)
      .execute();
    const id = tx.newId();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
    await tx.db
      .insertInto("user_tokens")
      .values({
        id,
        user_id: userId,
        purpose: "password_reset",
        token_hash: tokenHash,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      })
      .execute();
    return { tokenId: id, expiresAt };
  });
}

// F-45: MFA attempts on a password-reset token are reserved BEFORE the factor
// check (reserve -> check -> fail | completePasswordReset | release), like
// pending sessions. mfa_failed_attempts counts failures plus attempts in flight.

/**
 * Reserves one of the 5 attempt slots on an open (unused, unexpired)
 * password_reset token in one atomic UPDATE. Call after findValidUserToken
 * and before checking the factor; check only if `granted`. Must not run
 * inside `dal.transaction` (a rollback would refund the slot).
 */
export async function reserveTokenMfaAttempt(
  ctx: Ctx,
  tokenId: string,
): Promise<MfaAttemptReservation> {
  assertNoTransaction(ctx, "reserveTokenMfaAttempt");
  if (!isUuid(tokenId)) return { granted: false, reason: "invalid" };
  const now = ctx.clock();
  const row = await ctx.db
    .updateTable("user_tokens")
    .set({
      mfa_failed_attempts: sql<number>`mfa_failed_attempts + 1`,
      updated_at: now,
    })
    .where("id", "=", tokenId)
    .where("purpose", "=", "password_reset")
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .where("mfa_failed_attempts", "<", LIMITS.mfaAttemptsPerSessionOrToken)
    .returning("mfa_failed_attempts")
    .executeTakeFirst();
  if (row) return { granted: true, attempt: row.mfa_failed_attempts };
  const open = await ctx.db
    .selectFrom("user_tokens")
    .select("id")
    .where("id", "=", tokenId)
    .where("purpose", "=", "password_reset")
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return { granted: false, reason: open ? "exhausted" : "invalid" };
}

/**
 * The factor check of a granted reservation failed. The slot stays used.
 * Once all 5 slots are used, the token is deleted (invalidated):
 * `invalidated` is true for exactly one caller, `open` is false whenever the
 * token is no longer usable. Must not run inside `dal.transaction`.
 */
export async function failTokenMfaAttempt(
  ctx: Ctx,
  tokenId: string,
): Promise<{ attempts: number; invalidated: boolean; open: boolean }> {
  assertNoTransaction(ctx, "failTokenMfaAttempt");
  if (!isUuid(tokenId)) return { attempts: 0, invalidated: false, open: false };
  const del = await ctx.db
    .deleteFrom("user_tokens")
    .where("id", "=", tokenId)
    .where("purpose", "=", "password_reset")
    .where("used_at", "is", null)
    .where("mfa_failed_attempts", ">=", LIMITS.mfaAttemptsPerSessionOrToken)
    .returning("mfa_failed_attempts")
    .executeTakeFirst();
  if (del)
    return { attempts: del.mfa_failed_attempts, invalidated: true, open: false };
  const row = await ctx.db
    .selectFrom("user_tokens")
    .select("mfa_failed_attempts")
    .where("id", "=", tokenId)
    .where("purpose", "=", "password_reset")
    .where("used_at", "is", null)
    .where("expires_at", ">", ctx.clock())
    .executeTakeFirst();
  return row
    ? { attempts: row.mfa_failed_attempts, invalidated: false, open: true }
    : { attempts: 0, invalidated: false, open: false };
}

/**
 * Gives back a granted slot when the attempt ended WITHOUT a failed factor
 * check (per-user budget 429, an error before or after the check, e.g. the
 * factor was right but completePasswordReset failed). Never after
 * `failTokenMfaAttempt`, at most once per reservation. Not needed after
 * `completePasswordReset`, which consumes the token. No-op if it is gone.
 */
export async function releaseTokenMfaAttempt(
  ctx: Ctx,
  tokenId: string,
): Promise<void> {
  if (!isUuid(tokenId)) return;
  await ctx.db
    .updateTable("user_tokens")
    .set({
      mfa_failed_attempts: sql<number>`mfa_failed_attempts - 1`,
      updated_at: ctx.clock(),
    })
    .where("id", "=", tokenId)
    .where("purpose", "=", "password_reset")
    .where("used_at", "is", null)
    .where("mfa_failed_attempts", ">", 0)
    .execute();
}

/**
 * POST /auth/password-reset/complete (after the backend verified MFA if
 * enabled): consumes the token, sets the password, revokes ALL sessions and
 * deletes the user's other open tokens except cancel tokens. TOKEN_INVALID if
 * the token is no longer valid. Returns the user ID.
 */
export async function completePasswordReset(
  ctx: Ctx,
  tokenHash: Buffer,
  passwordHash: string,
): Promise<{ userId: string; revokedSessions: number }> {
  return withTx(ctx, async (tx) => {
    const now = tx.clock();
    const token = await tx.db
      .selectFrom("user_tokens")
      .select(["id", "user_id", "used_at", "expires_at"])
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", "password_reset")
      .forUpdate()
      .executeTakeFirst();
    // No attempt-count check: a token at 5 is held by the 5th attempt in
    // flight (F-45); the 5th failure deletes the row instead.
    if (!token || token.used_at !== null || token.expires_at <= now)
      throw tokenInvalid();
    await tx.db
      .updateTable("user_tokens")
      .set({ used_at: now, updated_at: now })
      .where("id", "=", token.id)
      .execute();
    await tx.db
      .updateTable("users")
      .set({ password_hash: passwordHash, updated_at: now })
      .where("id", "=", token.user_id)
      .execute();
    const del = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", token.user_id)
      .executeTakeFirst();
    await deleteOpenUserTokens(tx, token.user_id);
    return {
      userId: token.user_id,
      revokedSessions: Number(del.numDeletedRows),
    };
  });
}

export type EmailChangeRequestOutcome =
  | { outcome: "created"; oldEmail: string; expiresAt: Date }
  | { outcome: "email_taken" };

/**
 * POST /me/email-change (F-33). RATE_LIMITED (retryAfterSeconds = until that
 * token expires) while any email_change_cancel token is open. If the new
 * address is free: a 24 h email_change token bound to the requesting session
 * and a 24 h email_change_cancel token holding the old address. If taken: no
 * tokens (the backend emails the new address that an account exists; the HTTP
 * answer is the same either way).
 */
export async function requestEmailChange(
  ctx: Ctx,
  input: {
    userId: string;
    sessionId: string;
    newEmail: string;
    changeTokenHash: Buffer;
    cancelTokenHash: Buffer;
  },
): Promise<EmailChangeRequestOutcome> {
  const newEmail = normalizeEmail(input.newEmail);
  return withTx(ctx, async (tx) => {
    const user = await lockUser(tx, input.userId);
    if (!user) throw tokenInvalid();
    const now = tx.clock();
    const openCancel = await tx.db
      .selectFrom("user_tokens")
      .select(sql<Date>`max(expires_at)`.as("until"))
      .where("user_id", "=", input.userId)
      .where("purpose", "=", "email_change_cancel")
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .executeTakeFirst();
    if (openCancel?.until) {
      const seconds = Math.max(
        1,
        Math.ceil(
          (new Date(openCancel.until).getTime() - now.getTime()) / 1000,
        ),
      );
      throw new DalError("RATE_LIMITED", { retryAfterSeconds: seconds });
    }
    const taken = await tx.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", newEmail)
      .executeTakeFirst();
    if (taken) return { outcome: "email_taken" };
    await tx.db
      .deleteFrom("user_tokens")
      .where("user_id", "=", input.userId)
      .where("purpose", "=", "email_change")
      .where("used_at", "is", null)
      .execute();
    const expiresAt = new Date(now.getTime() + EMAIL_TTL_MS);
    await tx.db
      .insertInto("user_tokens")
      .values([
        {
          id: tx.newId(),
          user_id: input.userId,
          purpose: "email_change",
          token_hash: input.changeTokenHash,
          email: newEmail,
          requested_by_session_id: input.sessionId,
          created_at: now,
          updated_at: now,
          expires_at: expiresAt,
        },
        {
          id: tx.newId(),
          user_id: input.userId,
          purpose: "email_change_cancel",
          token_hash: input.cancelTokenHash,
          email: user.email,
          created_at: now,
          updated_at: now,
          expires_at: expiresAt,
        },
      ])
      .execute();
    return { outcome: "created", oldEmail: user.email, expiresAt };
  });
}

/**
 * POST /auth/email-change/confirm: requires an active session of the same user
 * (`userId`/`sessionId` from the caller's session). TOKEN_INVALID if the token
 * is invalid, belongs to another user, its requesting session was revoked, or
 * the address was taken meanwhile. Swaps the email, sets email_verified_at,
 * deletes other open tokens except cancel tokens, revokes every other session.
 * `reissueCancelTokenHash` (optional) creates a fresh cancel token to the old
 * address so the "email changed" notice can carry the cancel link again.
 */
export async function confirmEmailChange(
  ctx: Ctx,
  input: {
    tokenHash: Buffer;
    userId: string;
    sessionId: string;
    reissueCancelTokenHash?: Buffer;
  },
): Promise<{ oldEmail: string; newEmail: string; revokedSessions: number }> {
  return withTx(ctx, async (tx) => {
    const now = tx.clock();
    const token = await tx.db
      .selectFrom("user_tokens")
      .select([
        "id",
        "user_id",
        "email",
        "requested_by_session_id",
        "used_at",
        "expires_at",
      ])
      .where("token_hash", "=", input.tokenHash)
      .where("purpose", "=", "email_change")
      .forUpdate()
      .executeTakeFirst();
    if (!token?.email || token.used_at !== null || token.expires_at <= now)
      throw tokenInvalid();
    if (
      token.user_id !== input.userId ||
      token.requested_by_session_id === null
    )
      throw tokenInvalid();
    const user = await lockUser(tx, input.userId);
    if (!user) throw tokenInvalid();
    const session = await tx.db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", input.sessionId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "active")
      .where("expires_at", ">", now)
      .executeTakeFirst();
    if (!session) throw tokenInvalid();
    try {
      await tx.db
        .updateTable("users")
        .set({ email: token.email, email_verified_at: now, updated_at: now })
        .where("id", "=", input.userId)
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "users_email_key")) throw tokenInvalid();
      throw e;
    }
    await tx.db
      .updateTable("user_tokens")
      .set({ used_at: now, updated_at: now })
      .where("id", "=", token.id)
      .execute();
    await deleteOpenUserTokens(tx, input.userId);
    const del = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", input.userId)
      .where("id", "<>", input.sessionId)
      .executeTakeFirst();
    if (input.reissueCancelTokenHash) {
      await tx.db
        .insertInto("user_tokens")
        .values({
          id: tx.newId(),
          user_id: input.userId,
          purpose: "email_change_cancel",
          token_hash: input.reissueCancelTokenHash,
          email: user.email,
          created_at: now,
          updated_at: now,
          expires_at: new Date(now.getTime() + EMAIL_TTL_MS),
        })
        .execute();
    }
    return {
      oldEmail: user.email,
      newEmail: token.email,
      revokedSessions: Number(del.numDeletedRows),
    };
  });
}

export interface EmailChangeCancelResult {
  userId: string;
  /** cancelled: the change was still pending; reverted: it had been confirmed. */
  outcome: "cancelled" | "reverted";
  /** The address the account now has (restored or kept). PII. */
  keptEmail: string;
  /** The address reverted away from, or the abandoned pending address (null if none). PII. */
  abandonedEmail: string | null;
}

/**
 * POST /auth/email-change/cancel (public; the cancel token is the
 * authorization). If the account still has the address the link was sent to,
 * any pending change is cancelled; otherwise the email reverts to that address
 * (TOKEN_INVALID if another account now holds it). Either way: all sessions
 * revoked, every open non-cancel token deleted, and among cancel tokens ONLY
 * those created after this one (by created_at, then id) are deleted, so the
 * earliest open cancel token always wins (F-33).
 */
export async function cancelEmailChange(
  ctx: Ctx,
  tokenHash: Buffer,
): Promise<EmailChangeCancelResult> {
  return withTx(ctx, async (tx) => {
    const now = tx.clock();
    const token = await tx.db
      .selectFrom("user_tokens")
      .select(["id", "user_id", "email", "used_at", "expires_at", "created_at"])
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", "email_change_cancel")
      .forUpdate()
      .executeTakeFirst();
    if (!token?.email || token.used_at !== null || token.expires_at <= now)
      throw tokenInvalid();
    const user = await lockUser(tx, token.user_id);
    if (!user) throw tokenInvalid();
    const previous = token.email;

    let result: EmailChangeCancelResult;
    if (normalizeEmail(user.email) === normalizeEmail(previous)) {
      const pending = await tx.db
        .selectFrom("user_tokens")
        .select("email")
        .where("user_id", "=", token.user_id)
        .where("purpose", "=", "email_change")
        .where("used_at", "is", null)
        .where("expires_at", ">", now)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      result = {
        userId: token.user_id,
        outcome: "cancelled",
        keptEmail: user.email,
        abandonedEmail: pending?.email ?? null,
      };
    } else {
      try {
        await tx.db
          .updateTable("users")
          .set({ email: previous, email_verified_at: now, updated_at: now })
          .where("id", "=", token.user_id)
          .execute();
      } catch (e) {
        if (isUniqueViolation(e, "users_email_key")) throw tokenInvalid();
        throw e;
      }
      result = {
        userId: token.user_id,
        outcome: "reverted",
        keptEmail: previous,
        abandonedEmail: user.email,
      };
    }

    await tx.db
      .updateTable("user_tokens")
      .set({ used_at: now, updated_at: now })
      .where("id", "=", token.id)
      .execute();
    await deleteOpenUserTokens(tx, token.user_id);
    await tx.db
      .deleteFrom("user_tokens")
      .where("user_id", "=", token.user_id)
      .where("purpose", "=", "email_change_cancel")
      .where("used_at", "is", null)
      .where(
        sql<boolean>`(created_at, id) > (${token.created_at}::timestamptz, ${token.id}::uuid)`,
      )
      .execute();
    await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", token.user_id)
      .execute();
    return result;
  });
}

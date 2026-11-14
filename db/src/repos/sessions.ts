// Server-side sessions (auth.md §2, OD-2, F-19, F-20). Tokens are stored only
// as SHA-256 hashes computed by the backend.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  assertNoTransaction,
  withTx,
} from "../context.ts";
import { notFound } from "../errors.ts";
import type {
  MfaAttemptReservation,
  SessionInfoRecord,
  SessionRecord,
} from "../records.ts";
import type {
  DeviceBrowser,
  DeviceOs,
  SessionStatus,
  UserStatus,
} from "../schema.ts";
import { isUuid } from "../scope.ts";
import { LIMITS, deleteOpenUserTokens, lockUser } from "./common.ts";

const SLIDING_MS = 30 * DAY_MS;
const ABSOLUTE_MS = 90 * DAY_MS;
const PENDING_MS = 10 * MINUTE_MS;
const TOUCH_AFTER_MS = HOUR_MS;

const COLUMNS = [
  "id",
  "user_id",
  "status",
  "csrf_token",
  "created_at",
  "last_seen_at",
  "expires_at",
  "absolute_expires_at",
  "mfa_verified_at",
  "reauth_at",
  "mfa_failed_attempts",
  "device_browser",
  "device_os",
] as const;

interface SessionRow {
  id: string;
  user_id: string;
  status: SessionStatus;
  csrf_token: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  mfa_verified_at: Date | null;
  reauth_at: Date | null;
  mfa_failed_attempts: number;
  device_browser: DeviceBrowser;
  device_os: DeviceOs;
}

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    csrfToken: r.csrf_token,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    absoluteExpiresAt: r.absolute_expires_at,
    mfaVerifiedAt: r.mfa_verified_at,
    reauthAt: r.reauth_at,
    mfaFailedAttempts: r.mfa_failed_attempts,
    deviceBrowser: r.device_browser,
    deviceOs: r.device_os,
  };
}

export interface CreateSessionInput {
  userId: string;
  /** SHA-256 of the 32-byte cookie token (32 bytes). */
  tokenHash: Buffer;
  /** 32 random bytes, base64url. */
  csrfToken: string;
  status: SessionStatus;
  deviceBrowser: DeviceBrowser;
  deviceOs: DeviceOs;
  /** Active sessions only: the second factor was verified for this sign-in. */
  mfaVerified?: boolean;
  /** The session whose cookie came with this login/signup: revoked (rotation). */
  replacesSessionId?: string | undefined;
}

/**
 * Creates a session after sign-up, login or MFA completion. Active sessions:
 * 30-day sliding expiry, 90-day absolute cap, reauth_at = now (a fresh login
 * counts as re-authentication). Pending: 10 minutes, never extended.
 * Caps (F-20): at most 20 active (evicts the least recently seen) and,
 * separately, 5 mfa_pending (evicts the oldest); pending never evicts active.
 */
export async function createSession(
  ctx: Ctx,
  input: CreateSessionInput,
): Promise<SessionRecord> {
  return withTx(ctx, async (tx) => {
    const user = await lockUser(tx, input.userId);
    if (!user) throw notFound();
    const now = tx.clock();
    if (
      input.replacesSessionId !== undefined &&
      isUuid(input.replacesSessionId)
    ) {
      await tx.db
        .deleteFrom("sessions")
        .where("id", "=", input.replacesSessionId)
        .execute();
    }
    // Expired rows never count toward the caps.
    await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", input.userId)
      .where("expires_at", "<=", now)
      .execute();
    const cap =
      input.status === "active"
        ? LIMITS.activeSessionsPerUser
        : LIMITS.pendingSessionsPerUser;
    const existing = await tx.db
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", input.userId)
      .where("status", "=", input.status)
      .orderBy(input.status === "active" ? "last_seen_at" : "created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const excess = existing.length - (cap - 1);
    if (excess > 0) {
      await tx.db
        .deleteFrom("sessions")
        .where(
          "id",
          "in",
          existing.slice(0, excess).map((s) => s.id),
        )
        .execute();
    }
    const active = input.status === "active";
    const row = await tx.db
      .insertInto("sessions")
      .values({
        id: tx.newId(),
        user_id: input.userId,
        token_hash: input.tokenHash,
        csrf_token: input.csrfToken,
        status: input.status,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        expires_at: new Date(
          now.getTime() + (active ? SLIDING_MS : PENDING_MS),
        ),
        absolute_expires_at: new Date(now.getTime() + ABSOLUTE_MS),
        mfa_verified_at: active && input.mfaVerified === true ? now : null,
        reauth_at: active ? now : null,
        device_browser: input.deviceBrowser,
        device_os: input.deviceOs,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toRecord(row);
  });
}

/** Cookie lookup: the unexpired session for a token hash, with the user's status. */
export async function findSessionByTokenHash(
  ctx: Ctx,
  tokenHash: Buffer,
): Promise<{ session: SessionRecord; userStatus: UserStatus } | null> {
  const row = await ctx.db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select([
      ...COLUMNS.map((c) => `s.${c}` as const),
      "u.status as user_status",
    ])
    .where("s.token_hash", "=", tokenHash)
    .where("s.expires_at", ">", ctx.clock())
    .executeTakeFirst();
  if (!row) return null;
  const { user_status, ...session } = row;
  return { session: toRecord(session), userStatus: user_status };
}

/**
 * Sliding expiry: if last_seen_at is more than an hour old, sets last_seen_at
 * to now and expires_at to min(now + 30 days, absolute cap). Returns the new
 * expiry (re-send the cookie) or null when nothing changed.
 */
export async function touchSession(
  ctx: Ctx,
  sessionId: string,
): Promise<{ expiresAt: Date } | null> {
  if (!isUuid(sessionId)) return null;
  const now = ctx.clock();
  const row = await ctx.db
    .updateTable("sessions")
    .set({
      last_seen_at: now,
      updated_at: now,
      expires_at: sql<Date>`least(${new Date(now.getTime() + SLIDING_MS)}::timestamptz, absolute_expires_at)`,
    })
    .where("id", "=", sessionId)
    .where("status", "=", "active")
    .where("expires_at", ">", now)
    .where("last_seen_at", "<=", new Date(now.getTime() - TOUCH_AFTER_MS))
    .returning("expires_at")
    .executeTakeFirst();
  return row ? { expiresAt: row.expires_at } : null;
}

/**
 * MFA completion: replaces the pending session with a new active one (new
 * token, mfa_verified_at = reauth_at = now; the 90 days start again).
 * Returns null if the pending session no longer exists or expired.
 */
export async function completeMfaSession(
  ctx: Ctx,
  pendingSessionId: string,
  next: { tokenHash: Buffer; csrfToken: string },
): Promise<SessionRecord | null> {
  if (!isUuid(pendingSessionId)) return null;
  return withTx(ctx, async (tx) => {
    const pending = await tx.db
      .deleteFrom("sessions")
      .where("id", "=", pendingSessionId)
      .where("status", "=", "mfa_pending")
      .where("expires_at", ">", tx.clock())
      .returning(["user_id", "device_browser", "device_os"])
      .executeTakeFirst();
    if (!pending) return null;
    return createSession(tx, {
      userId: pending.user_id,
      tokenHash: next.tokenHash,
      csrfToken: next.csrfToken,
      status: "active",
      deviceBrowser: pending.device_browser,
      deviceOs: pending.device_os,
      mfaVerified: true,
    });
  });
}

// F-45: MFA attempts on a pending session are reserved BEFORE the factor
// check (reserve -> check -> fail | complete | release). The counter
// (mfa_failed_attempts) counts failures plus attempts in flight, so at most 5
// checks can ever run per pending session, however many arrive in parallel.

/**
 * Reserves one of the 5 attempt slots on an unexpired mfa_pending session in
 * one atomic UPDATE (concurrent callers re-check `< 5` after each other's
 * commit). Call before checking the factor; check only if `granted`. Must not
 * run inside `dal.transaction` (a rollback would refund the slot).
 */
export async function reserveSessionMfaAttempt(
  ctx: Ctx,
  sessionId: string,
): Promise<MfaAttemptReservation> {
  assertNoTransaction(ctx, "reserveSessionMfaAttempt");
  if (!isUuid(sessionId)) return { granted: false, reason: "invalid" };
  const now = ctx.clock();
  const row = await ctx.db
    .updateTable("sessions")
    .set({
      mfa_failed_attempts: sql<number>`mfa_failed_attempts + 1`,
      updated_at: now,
    })
    .where("id", "=", sessionId)
    .where("status", "=", "mfa_pending")
    .where("expires_at", ">", now)
    .where("mfa_failed_attempts", "<", LIMITS.mfaAttemptsPerSessionOrToken)
    .returning("mfa_failed_attempts")
    .executeTakeFirst();
  if (row) return { granted: true, attempt: row.mfa_failed_attempts };
  const open = await ctx.db
    .selectFrom("sessions")
    .select("id")
    .where("id", "=", sessionId)
    .where("status", "=", "mfa_pending")
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return { granted: false, reason: open ? "exhausted" : "invalid" };
}

/**
 * The factor check of a granted reservation failed. The slot stays used.
 * Once all 5 slots are used, the pending session is deleted: `deleted` is
 * true for exactly one caller (send the mfa_failures email then), `open` is
 * false whenever the pending session no longer exists (clear the cookie).
 * Must not run inside `dal.transaction`.
 */
export async function failSessionMfaAttempt(
  ctx: Ctx,
  sessionId: string,
): Promise<{ attempts: number; deleted: boolean; open: boolean }> {
  assertNoTransaction(ctx, "failSessionMfaAttempt");
  if (!isUuid(sessionId)) return { attempts: 0, deleted: false, open: false };
  const del = await ctx.db
    .deleteFrom("sessions")
    .where("id", "=", sessionId)
    .where("status", "=", "mfa_pending")
    .where("mfa_failed_attempts", ">=", LIMITS.mfaAttemptsPerSessionOrToken)
    .returning("mfa_failed_attempts")
    .executeTakeFirst();
  if (del)
    return { attempts: del.mfa_failed_attempts, deleted: true, open: false };
  const row = await ctx.db
    .selectFrom("sessions")
    .select("mfa_failed_attempts")
    .where("id", "=", sessionId)
    .where("status", "=", "mfa_pending")
    .where("expires_at", ">", ctx.clock())
    .executeTakeFirst();
  return row
    ? { attempts: row.mfa_failed_attempts, deleted: false, open: true }
    : { attempts: 0, deleted: false, open: false };
}

/**
 * Gives back a granted slot when the attempt ended WITHOUT a failed factor
 * check (per-user budget 429, an error before or after the check). Never
 * after `failSessionMfaAttempt`, at most once per reservation. Not needed
 * after `completeMfaSession`, which deletes the pending session. No-op if the
 * session is gone.
 */
export async function releaseSessionMfaAttempt(
  ctx: Ctx,
  sessionId: string,
): Promise<void> {
  if (!isUuid(sessionId)) return;
  await ctx.db
    .updateTable("sessions")
    .set({
      mfa_failed_attempts: sql<number>`mfa_failed_attempts - 1`,
      updated_at: ctx.clock(),
    })
    .where("id", "=", sessionId)
    .where("status", "=", "mfa_pending")
    .where("mfa_failed_attempts", ">", 0)
    .execute();
}

/** POST /auth/reauth success: reauth_at = now (and mfa_verified_at when a factor was checked). */
export async function markReauthenticated(
  ctx: Ctx,
  sessionId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<void> {
  if (!isUuid(sessionId)) throw notFound();
  const now = ctx.clock();
  const res = await ctx.db
    .updateTable("sessions")
    .set({
      reauth_at: now,
      updated_at: now,
      ...(options.mfaVerified === true ? { mfa_verified_at: now } : {}),
    })
    .where("id", "=", sessionId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw notFound();
}

/** GET /me/sessions: the user's unexpired active sessions, most recently seen first. */
export async function listSessions(
  ctx: Ctx,
  userId: string,
): Promise<SessionInfoRecord[]> {
  if (!isUuid(userId)) return [];
  const rows = await ctx.db
    .selectFrom("sessions")
    .select([
      "id",
      "device_browser",
      "device_os",
      "created_at",
      "last_seen_at",
      "expires_at",
    ])
    .where("user_id", "=", userId)
    .where("status", "=", "active")
    .where("expires_at", ">", ctx.clock())
    .orderBy("last_seen_at", "desc")
    .orderBy("id", "desc")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    browser: r.device_browser,
    os: r.device_os,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  }));
}

/** DELETE /me/sessions/{id}: only the caller's own sessions (others' -> NOT_FOUND). */
export async function revokeSession(
  ctx: Ctx,
  userId: string,
  sessionId: string,
): Promise<void> {
  if (!isUuid(userId) || !isUuid(sessionId)) throw notFound();
  const res = await ctx.db
    .deleteFrom("sessions")
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (res.numDeletedRows === 0n) throw notFound();
}

/** Logout: deletes the session (no error if it is already gone). */
export async function deleteSession(
  ctx: Ctx,
  sessionId: string,
): Promise<void> {
  if (!isUuid(sessionId)) return;
  await ctx.db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

/** POST /me/sessions/revoke-others: also deletes open one-time tokens except cancel tokens (F-01). */
export async function revokeOtherSessions(
  ctx: Ctx,
  userId: string,
  currentSessionId: string,
): Promise<{ revokedSessions: number }> {
  return withTx(ctx, async (tx) => {
    const res = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .where("id", "<>", currentSessionId)
      .executeTakeFirst();
    await deleteOpenUserTokens(tx, userId);
    return { revokedSessions: Number(res.numDeletedRows) };
  });
}

/**
 * Admin `revoke-sessions --email`: every session of the user plus open tokens
 * except cancel tokens. dryRun only counts.
 */
export async function revokeAllSessionsForUser(
  ctx: Ctx,
  userId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ sessions: number; tokens: number }> {
  return withTx(ctx, async (tx) => {
    if (options.dryRun === true) {
      const s = await tx.db
        .selectFrom("sessions")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      const t = await tx.db
        .selectFrom("user_tokens")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("user_id", "=", userId)
        .where("used_at", "is", null)
        .where("purpose", "<>", "email_change_cancel")
        .executeTakeFirstOrThrow();
      return { sessions: s.n, tokens: t.n };
    }
    const res = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    const tokens = await deleteOpenUserTokens(tx, userId);
    return { sessions: Number(res.numDeletedRows), tokens };
  });
}

/**
 * Admin `revoke-sessions --all` (F-11): every session of every user and every
 * open one-time token except cancel tokens; with `restore` (post-restore mode)
 * cancel tokens too.
 */
export async function revokeAllSessions(
  ctx: Ctx,
  options: { restore?: boolean } = {},
): Promise<{ sessions: number; tokens: number }> {
  return withTx(ctx, async (tx) => {
    const res = await tx.db.deleteFrom("sessions").executeTakeFirst();
    // Restore mode: every cancel token goes, used or not, because the restored
    // database may hold one whose use happened after the backup (F-11 note).
    const q =
      options.restore === true
        ? tx.db
            .deleteFrom("user_tokens")
            .where((eb) =>
              eb.or([
                eb("used_at", "is", null),
                eb("purpose", "=", "email_change_cancel"),
              ]),
            )
        : tx.db
            .deleteFrom("user_tokens")
            .where("used_at", "is", null)
            .where("purpose", "<>", "email_change_cancel");
    const tokens = await q.executeTakeFirst();
    return {
      sessions: Number(res.numDeletedRows),
      tokens: Number(tokens.numDeletedRows),
    };
  });
}

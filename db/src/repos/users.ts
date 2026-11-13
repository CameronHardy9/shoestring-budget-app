// Users: login lookup, profile, password change, account deletion request
// (auth.md §7, §11; data-model.md "Deletion and purge").
import type { Ctx } from "../context.ts";
import { DAY_MS, withTx } from "../context.ts";
import { DalError, notFound } from "../errors.ts";
import type { MeRecord } from "../records.ts";
import type { UserStatus } from "../schema.ts";
import { isUuid } from "../scope.ts";
import {
  deleteOpenUserTokens,
  lockOwnedBudgetsAndCheckShared,
  lockUser,
  normalizeEmail,
} from "./common.ts";
import { getMfaSummary } from "./mfa.ts";

export interface LoginCredentials {
  userId: string;
  /** Secret: argon2id PHC string. Verify and drop; never log or return. */
  passwordHash: string;
  status: UserStatus;
}

/** POST /auth/login: null for an unknown email (the backend still runs a dummy verify). */
export async function getLoginCredentials(
  ctx: Ctx,
  email: string,
): Promise<LoginCredentials | null> {
  const row = await ctx.db
    .selectFrom("users")
    .select(["id", "password_hash", "status"])
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  return row
    ? { userId: row.id, passwordHash: row.password_hash, status: row.status }
    : null;
}

/** Password hash for re-auth and password change checks (Secret). */
export async function getPasswordHash(
  ctx: Ctx,
  userId: string,
): Promise<string> {
  if (!isUuid(userId)) throw notFound();
  const row = await ctx.db
    .selectFrom("users")
    .select("password_hash")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return row.password_hash;
}

/** GET /me */
export async function getMe(ctx: Ctx, userId: string): Promise<MeRecord> {
  if (!isUuid(userId)) throw notFound();
  const row = await ctx.db
    .selectFrom("users")
    .select([
      "id",
      "email",
      "display_name",
      "status",
      "created_at",
      "deletion_requested_at",
      "purge_after",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    mfa: await getMfaSummary(ctx, userId),
    deletion:
      row.status === "pending_deletion" &&
      row.deletion_requested_at &&
      row.purge_after
        ? {
            requestedAt: row.deletion_requested_at,
            purgeAfter: row.purge_after,
          }
        : null,
  };
}

/** Address and name for a notification email (PII: never log). */
export async function getUserContact(
  ctx: Ctx,
  userId: string,
): Promise<{ userId: string; email: string; displayName: string }> {
  if (!isUuid(userId)) throw notFound();
  const row = await ctx.db
    .selectFrom("users")
    .select(["id", "email", "display_name"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return { userId: row.id, email: row.email, displayName: row.display_name };
}

/** Admin commands and invitations: the user ID for an email, or null. */
export async function findUserIdByEmail(
  ctx: Ctx,
  email: string,
): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("users")
    .select("id")
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  return row?.id ?? null;
}

/** PATCH /me */
export async function updateDisplayName(
  ctx: Ctx,
  userId: string,
  displayName: string,
): Promise<MeRecord> {
  if (!isUuid(userId)) throw notFound();
  const res = await ctx.db
    .updateTable("users")
    .set({ display_name: displayName, updated_at: ctx.clock() })
    .where("id", "=", userId)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw notFound();
  return getMe(ctx, userId);
}

/** Rehash on login when argon2 parameters change. No other side effects. */
export async function updatePasswordHash(
  ctx: Ctx,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await ctx.db
    .updateTable("users")
    .set({ password_hash: passwordHash, updated_at: ctx.clock() })
    .where("id", "=", userId)
    .execute();
}

/**
 * POST /me/password: sets the new hash, revokes every other session and deletes
 * open one-time tokens except cancel tokens (F-01), in one transaction.
 */
export async function changePassword(
  ctx: Ctx,
  userId: string,
  passwordHash: string,
  currentSessionId: string,
): Promise<{ revokedSessions: number }> {
  return withTx(ctx, async (tx) => {
    const res = await tx.db
      .updateTable("users")
      .set({ password_hash: passwordHash, updated_at: tx.clock() })
      .where("id", "=", userId)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw notFound();
    const del = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .where("id", "<>", currentSessionId)
      .executeTakeFirst();
    await deleteOpenUserTokens(tx, userId);
    return { revokedSessions: Number(del.numDeletedRows) };
  });
}

/**
 * POST /me/deletion: OWNS_SHARED_BUDGET if any owned, non-deleted budget has
 * another member. Otherwise: pending_deletion for 30 days, pending invitations
 * of owned budgets revoked, every session deleted, open tokens deleted (F-01).
 * Idempotent for an account that is already pending deletion.
 */
export async function requestAccountDeletion(
  ctx: Ctx,
  userId: string,
): Promise<{
  requestedAt: Date;
  purgeAfter: Date;
  revokedInvitations: number;
  revokedSessions: number;
}> {
  return withTx(ctx, async (tx) => {
    const { ownsSharedBudget, ownedBudgetIds } =
      await lockOwnedBudgetsAndCheckShared(tx, userId);
    if (ownsSharedBudget) throw new DalError("OWNS_SHARED_BUDGET");
    await lockUser(tx, userId);
    const user = await tx.db
      .selectFrom("users")
      .select(["status", "deletion_requested_at", "purge_after"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user) throw notFound();
    const now = tx.clock();
    let requestedAt = now;
    let purgeAfter = new Date(now.getTime() + 30 * DAY_MS);
    if (
      user.status === "pending_deletion" &&
      user.deletion_requested_at &&
      user.purge_after
    ) {
      requestedAt = user.deletion_requested_at;
      purgeAfter = user.purge_after;
    } else {
      await tx.db
        .updateTable("users")
        .set({
          status: "pending_deletion",
          deletion_requested_at: requestedAt,
          purge_after: purgeAfter,
          updated_at: now,
        })
        .where("id", "=", userId)
        .execute();
    }
    let revokedInvitations = 0;
    if (ownedBudgetIds.length > 0) {
      const res = await tx.db
        .updateTable("budget_invitations")
        .set({ status: "revoked", responded_at: now, updated_at: now })
        .where("budget_id", "in", ownedBudgetIds)
        .where("status", "=", "pending")
        .executeTakeFirst();
      revokedInvitations = Number(res.numUpdatedRows);
    }
    const del = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    await deleteOpenUserTokens(tx, userId);
    return {
      requestedAt,
      purgeAfter,
      revokedInvitations,
      revokedSessions: Number(del.numDeletedRows),
    };
  });
}

/** DELETE /me/deletion: NOT_FOUND when nothing is pending. Revoked invitations stay revoked. */
export async function cancelAccountDeletion(
  ctx: Ctx,
  userId: string,
): Promise<void> {
  if (!isUuid(userId)) throw notFound();
  const res = await ctx.db
    .updateTable("users")
    .set({
      status: "active",
      deletion_requested_at: null,
      purge_after: null,
      updated_at: ctx.clock(),
    })
    .where("id", "=", userId)
    .where("status", "=", "pending_deletion")
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw notFound();
}

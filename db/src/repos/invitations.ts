// Budget invitations (ADR-0006, F-13, F-25, F-31). No token: acceptance is
// authorized by the caller's verified email matching the invitation.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { DAY_MS, withTx } from "../context.ts";
import { DalError, limitReached, notFound } from "../errors.ts";
import type {
  BudgetRecord,
  InvitationApiStatus,
  InvitationRecord,
  MemberContact,
  MyInvitationRecord,
} from "../records.ts";
import type { InvitationStatus } from "../schema.ts";
import type { BudgetScope } from "../scope.ts";
import {
  advisoryLock,
  assertOwner,
  isUuid,
  lockBudgetAsOwner,
} from "../scope.ts";
import {
  LIMITS,
  countLiveBudgets,
  loadBudgetRecord,
  loadMemberContacts,
  lockUser,
  normalizeEmail,
} from "./common.ts";

const INVITATION_TTL_MS = 14 * DAY_MS;

function apiStatus(
  status: InvitationStatus,
  expiresAt: Date,
  now: Date,
): InvitationApiStatus {
  return status === "pending" && expiresAt <= now ? "expired" : status;
}

const invalidInvitation = (): DalError => new DalError("INVITATION_INVALID");

/** GET /budgets/{b}/invitations (owner): newest first, at most 100. */
export async function listBudgetInvitations(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<InvitationRecord[]> {
  assertOwner(scope);
  const rows = await ctx.db
    .selectFrom("budget_invitations as i")
    .leftJoin("users as u", "u.id", "i.invited_by_user_id")
    .select([
      "i.id",
      "i.budget_id",
      "i.email",
      "i.status",
      "u.display_name",
      "i.created_at",
      "i.expires_at",
      "i.responded_at",
    ])
    .where("i.budget_id", "=", scope.budgetId)
    .orderBy("i.created_at", "desc")
    .orderBy("i.id", "desc")
    .limit(100)
    .execute();
  const now = ctx.clock();
  return rows.map((r) => ({
    id: r.id,
    budgetId: r.budget_id,
    email: r.email,
    status: apiStatus(r.status, r.expires_at, now),
    invitedByDisplayName: r.display_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    respondedAt: r.responded_at,
  }));
}

/**
 * POST /budgets/{b}/invitations (owner, re-auth checked by the backend).
 * ALREADY_EXISTS (already_member | invitation_pending); LIMIT_REACHED at 10
 * pending per budget or 20 pending per invitee email. An expired pending
 * invitation for the same email is replaced. `inviteeHasAccount` tells the
 * backend whether to send the invitation email; the HTTP response must not
 * reveal it.
 */
export async function createBudgetInvitation(
  ctx: Ctx,
  scope: BudgetScope,
  rawEmail: string,
): Promise<{ invitation: InvitationRecord; inviteeHasAccount: boolean }> {
  const email = normalizeEmail(rawEmail);
  return withTx(ctx, async (tx) => {
    await lockBudgetAsOwner(tx, scope);
    await advisoryLock(tx, `invitation-email:${email}`);
    const now = tx.clock();

    const invitee = await tx.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    if (invitee) {
      const member = await tx.db
        .selectFrom("budget_members")
        .select("user_id")
        .where("budget_id", "=", scope.budgetId)
        .where("user_id", "=", invitee.id)
        .executeTakeFirst();
      if (member)
        throw new DalError("ALREADY_EXISTS", {
          details: [{ in: "body", field: "email", issue: "already_member" }],
        });
    }

    const pending = await tx.db
      .selectFrom("budget_invitations")
      .select(["id", "expires_at"])
      .where("budget_id", "=", scope.budgetId)
      .where("email", "=", email)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (pending && pending.expires_at > now) {
      throw new DalError("ALREADY_EXISTS", {
        details: [{ in: "body", field: "email", issue: "invitation_pending" }],
      });
    }
    if (pending) {
      // Expired: its stored status is still 'pending' (expired is derived), so
      // it would block the unique index. Replace it.
      await tx.db
        .deleteFrom("budget_invitations")
        .where("id", "=", pending.id)
        .execute();
    }

    const perBudget = await tx.db
      .selectFrom("budget_invitations")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("budget_id", "=", scope.budgetId)
      .where("status", "=", "pending")
      .where("expires_at", ">", now)
      .executeTakeFirstOrThrow();
    if (perBudget.n >= LIMITS.pendingInvitationsPerBudget)
      throw limitReached("email");
    const perEmail = await tx.db
      .selectFrom("budget_invitations")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("email", "=", email)
      .where("status", "=", "pending")
      .where("expires_at", ">", now)
      .executeTakeFirstOrThrow();
    if (perEmail.n >= LIMITS.pendingInvitationsPerEmail)
      throw limitReached("email");

    const id = tx.newId();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    await tx.db
      .insertInto("budget_invitations")
      .values({
        id,
        budget_id: scope.budgetId,
        email,
        invited_by_user_id: scope.userId,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      })
      .execute();
    const inviter = await tx.db
      .selectFrom("users")
      .select("display_name")
      .where("id", "=", scope.userId)
      .executeTakeFirst();
    return {
      invitation: {
        id,
        budgetId: scope.budgetId,
        email,
        status: "pending",
        invitedByDisplayName: inviter?.display_name ?? null,
        createdAt: now,
        expiresAt,
        respondedAt: null,
      },
      inviteeHasAccount: invitee !== undefined,
    };
  });
}

/** DELETE /budgets/{b}/invitations/{id} (owner). Not pending or expired -> INVITATION_INVALID. */
export async function revokeBudgetInvitation(
  ctx: Ctx,
  scope: BudgetScope,
  invitationId: string,
): Promise<void> {
  await withTx(ctx, async (tx) => {
    await lockBudgetAsOwner(tx, scope);
    if (!isUuid(invitationId)) throw notFound();
    const now = tx.clock();
    const inv = await tx.db
      .selectFrom("budget_invitations")
      .select(["status", "expires_at"])
      .where("id", "=", invitationId)
      .where("budget_id", "=", scope.budgetId)
      .forUpdate()
      .executeTakeFirst();
    if (!inv) throw notFound();
    if (inv.status !== "pending" || inv.expires_at <= now)
      throw invalidInvitation();
    await tx.db
      .updateTable("budget_invitations")
      .set({ status: "revoked", responded_at: now, updated_at: now })
      .where("id", "=", invitationId)
      .execute();
  });
}

/** GET /me/invitations: pending, unexpired, addressed to my email, budget not deleted; newest first, at most 20. */
export async function listMyInvitations(
  ctx: Ctx,
  userId: string,
): Promise<MyInvitationRecord[]> {
  if (!isUuid(userId)) return [];
  const rows = await ctx.db
    .selectFrom("users as me")
    .innerJoin("budget_invitations as i", "i.email", "me.email")
    .innerJoin("budgets as b", "b.id", "i.budget_id")
    .leftJoin("users as inviter", "inviter.id", "i.invited_by_user_id")
    .select([
      "i.id",
      "i.budget_id",
      "b.name",
      "inviter.display_name",
      "i.expires_at",
    ])
    .where("me.id", "=", userId)
    .where("i.status", "=", "pending")
    .where("i.expires_at", ">", ctx.clock())
    .where("b.deleted_at", "is", null)
    .orderBy("i.created_at", "desc")
    .orderBy("i.id", "desc")
    .limit(LIMITS.pendingInvitationsPerEmail)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    budgetId: r.budget_id,
    budgetName: r.name,
    invitedByDisplayName: r.display_name,
    expiresAt: r.expires_at,
  }));
}

/** Loads an invitation addressed to the caller (else NOT_FOUND). */
async function findMyInvitation(
  ctx: Ctx,
  userId: string,
  invitationId: string,
) {
  if (!isUuid(userId) || !isUuid(invitationId)) throw notFound();
  const row = await ctx.db
    .selectFrom("budget_invitations as i")
    .innerJoin("users as me", "me.email", "i.email")
    .select(["i.id", "i.budget_id"])
    .where("i.id", "=", invitationId)
    .where("me.id", "=", userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

/**
 * POST /me/invitations/{id}/accept (F-25): locks the budget row, then checks
 * pending + unexpired, budget not deleted, owner active (else
 * INVITATION_INVALID), not already a member (ALREADY_EXISTS), fewer than 6
 * members and the caller under 10 budgets (LIMIT_REACHED); inserts the
 * membership and marks the invitation accepted in the same transaction.
 * Returns the budget and the owner's contact (for the "accepted" notice).
 */
export async function acceptInvitation(
  ctx: Ctx,
  userId: string,
  invitationId: string,
): Promise<{ budget: BudgetRecord; owner: MemberContact }> {
  return withTx(ctx, async (tx) => {
    const found = await findMyInvitation(tx, userId, invitationId);
    // The budget lock is the only lock needed on the owner's side (F-25): every
    // path that changes who owns this budget (transferOwnership), the owner's
    // status (requestAccountDeletion locks all owned budgets first, then the
    // user, and revokes their invitations) or its membership takes this lock
    // first. Everything below that depends on those (invitation status, owner
    // status, member count) is read after it, and each READ COMMITTED
    // statement sees what the lock holder committed. So the owner's deletion
    // request and this acceptance serialize: deletion first -> the invitation
    // is revoked (INVITATION_INVALID); acceptance first -> the deletion sees a
    // co-member (OWNS_SHARED_BUDGET). Do not move those reads above this lock,
    // and do not lock the owner's user row here (that adds nothing).
    const budget = await tx.db
      .selectFrom("budgets")
      .select(["deleted_at"])
      .where("id", "=", found.budget_id)
      .forUpdate()
      .executeTakeFirst();
    const inv = await tx.db
      .selectFrom("budget_invitations")
      .select(["status", "expires_at", "email"])
      .where("id", "=", invitationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = tx.clock();
    if (!budget || budget.deleted_at !== null) throw invalidInvitation();
    if (inv.status !== "pending" || inv.expires_at <= now)
      throw invalidInvitation();
    const owner = await tx.db
      .selectFrom("budget_members as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["u.status"])
      .where("m.budget_id", "=", found.budget_id)
      .where("m.role", "=", "owner")
      .executeTakeFirst();
    if (owner?.status !== "active") throw invalidInvitation();

    const members = await tx.db
      .selectFrom("budget_members")
      .select("user_id")
      .where("budget_id", "=", found.budget_id)
      .execute();
    if (members.some((m) => m.user_id === userId)) {
      throw new DalError("ALREADY_EXISTS", {
        details: [
          { in: "path", field: "invitationId", issue: "already_member" },
        ],
      });
    }
    if (members.length >= LIMITS.membersPerBudget) throw limitReached();
    const me = await lockUser(tx, userId);
    if (
      me?.status !== "active" ||
      normalizeEmail(me.email) !== normalizeEmail(inv.email)
    )
      throw notFound();
    if ((await countLiveBudgets(tx, userId)) >= LIMITS.budgetsPerUser)
      throw limitReached();

    await tx.db
      .insertInto("budget_members")
      .values({
        budget_id: found.budget_id,
        user_id: userId,
        role: "member",
        joined_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tx.db
      .updateTable("budget_invitations")
      .set({
        status: "accepted",
        responded_at: now,
        accepted_user_id: userId,
        updated_at: now,
      })
      .where("id", "=", invitationId)
      .execute();
    const contacts = await loadMemberContacts(tx, found.budget_id);
    const ownerContact = contacts.find((c) => c.role === "owner");
    if (!ownerContact) throw invalidInvitation();
    return {
      budget: await loadBudgetRecord(tx, found.budget_id, userId),
      owner: ownerContact,
    };
  });
}

/** POST /me/invitations/{id}/decline. */
export async function declineInvitation(
  ctx: Ctx,
  userId: string,
  invitationId: string,
): Promise<void> {
  await withTx(ctx, async (tx) => {
    await findMyInvitation(tx, userId, invitationId);
    const inv = await tx.db
      .selectFrom("budget_invitations")
      .select(["status", "expires_at"])
      .where("id", "=", invitationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = tx.clock();
    if (inv.status !== "pending" || inv.expires_at <= now)
      throw invalidInvitation();
    await tx.db
      .updateTable("budget_invitations")
      .set({ status: "declined", responded_at: now, updated_at: now })
      .where("id", "=", invitationId)
      .execute();
  });
}

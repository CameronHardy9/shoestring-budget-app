// Budget members: list, remove/leave, ownership transfer (ADR-0010).
import type { Ctx } from "../context.ts";
import { withTx } from "../context.ts";
import { DalError, forbidden, invalid, notFound } from "../errors.ts";
import type { MemberContact, MemberRecord } from "../records.ts";
import type { BudgetScope } from "../scope.ts";
import {
  assertBudgetScope,
  isUuid,
  lockBudget,
  lockBudgetAsOwner,
} from "../scope.ts";
import { loadMemberContacts, lockUser } from "./common.ts";

/** GET /budgets/{b}/members: owner first, then by join time. */
export async function listMembers(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<MemberRecord[]> {
  assertBudgetScope(scope);
  const rows = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "u.display_name", "m.role", "m.joined_at"])
    .where("m.budget_id", "=", scope.budgetId)
    .orderBy("m.role", "asc")
    .orderBy("m.joined_at", "asc")
    .orderBy("m.user_id", "asc")
    .execute();
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    role: r.role,
    joinedAt: r.joined_at,
  }));
}

/**
 * DELETE /budgets/{b}/members/{userId}: the owner removes someone else, or a
 * member leaves. Owner removing themself -> OWNER_CANNOT_LEAVE; a member
 * removing someone else -> FORBIDDEN; not a member -> NOT_FOUND.
 * Returns the removed member's contact (for the removal notice).
 */
export async function removeMember(
  ctx: Ctx,
  scope: BudgetScope,
  targetUserId: string,
): Promise<{ removed: MemberContact }> {
  return withTx(ctx, async (tx) => {
    const { role } = await lockBudget(tx, scope);
    const self = targetUserId === scope.userId;
    if (self && role === "owner") throw new DalError("OWNER_CANNOT_LEAVE");
    if (!self && role !== "owner") throw forbidden();
    if (!isUuid(targetUserId)) throw notFound();
    const contacts = await loadMemberContacts(tx, scope.budgetId);
    const target = contacts.find((c) => c.userId === targetUserId);
    if (!target) throw notFound();
    await tx.db
      .deleteFrom("budget_members")
      .where("budget_id", "=", scope.budgetId)
      .where("user_id", "=", targetUserId)
      .execute();
    return { removed: target };
  });
}

/**
 * POST /budgets/{b}/transfer-ownership: owner only, under a row lock on the
 * budget. Demote the owner, then promote the target (the partial unique index
 * is checked per statement; the deferred trigger confirms one owner at commit).
 * Self -> VALIDATION_FAILED (userId); target not a member or not active -> NOT_FOUND.
 * Locks the target's user row after the budget row (no race with the target's
 * own deletion request).
 * Returns every member's contact for the notice.
 */
export async function transferOwnership(
  ctx: Ctx,
  scope: BudgetScope,
  targetUserId: string,
): Promise<{ members: MemberContact[] }> {
  return withTx(ctx, async (tx) => {
    await lockBudgetAsOwner(tx, scope);
    if (targetUserId === scope.userId)
      throw invalid({ in: "body", field: "userId", issue: "invalid_value" });
    if (!isUuid(targetUserId)) throw notFound();
    const target = await tx.db
      .selectFrom("budget_members")
      .select("role")
      .where("budget_id", "=", scope.budgetId)
      .where("user_id", "=", targetUserId)
      .executeTakeFirst();
    if (!target) throw notFound();
    // Budget lock first, then the target's user row (ADR-0010 lock order). This
    // serializes with the target's own deletion request: if it committed
    // first we see pending_deletion here; if we commit first, it re-checks
    // shared ownership under the same lock and refuses.
    const user = await lockUser(tx, targetUserId);
    if (user?.status !== "active") throw notFound();
    const now = tx.clock();
    await tx.db
      .updateTable("budget_members")
      .set({ role: "member", updated_at: now })
      .where("budget_id", "=", scope.budgetId)
      .where("user_id", "=", scope.userId)
      .execute();
    await tx.db
      .updateTable("budget_members")
      .set({ role: "owner", updated_at: now })
      .where("budget_id", "=", scope.budgetId)
      .where("user_id", "=", targetUserId)
      .execute();
    return { members: await loadMemberContacts(tx, scope.budgetId) };
  });
}

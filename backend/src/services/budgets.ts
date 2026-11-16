// Budget lifecycle, membership, ownership transfer and invitations
// (ADR-0006, ADR-0010, auth.md §12, §14, §15). Authorization is already done
// by the route layer (membership -> BudgetScope, role, re-auth); the DAL
// re-checks owner actions under a row lock.
import type { BudgetScope } from "@shoestring/db";
import type { AuthContext } from "../auth/session.ts";
import type { AppDeps } from "../deps.ts";
import { DAY, rateLimited } from "../http/rate-limit.ts";
import type { Reservation } from "../http/rate-limit.ts";
import { toBudget, toInvitation } from "../http/mappers.ts";
import { idempotencyRequestHash } from "../domain/idempotency.ts";

export const INVITES_PER_BUDGET_PER_DAY = 20;
export const INVITES_PER_USER_PER_DAY = 30;

export async function createBudget(
  deps: AppDeps,
  auth: AuthContext,
  input: {
    name: string;
    timezone: string;
    categories?:
      | {
          name: string;
          kind: "expense" | "income";
          plannedCents?: number | undefined;
        }[]
      | undefined;
  },
  idem: { key: string; path: string; rawBody: unknown },
) {
  const userId = auth.session.userId;
  const res = await deps.dal.budgets.createBudget(userId, input, {
    idempotency: {
      userId,
      key: idem.key,
      requestHash: idempotencyRequestHash("POST", idem.path, {}, idem.rawBody),
    },
  });
  return { replayed: res.replayed, budget: toBudget(res.value) };
}

export async function deleteBudget(
  deps: AppDeps,
  auth: AuthContext,
  scope: BudgetScope,
  version: number,
) {
  const before = await deps.dal.budgets.getBudget(scope);
  const { members } = await deps.dal.budgets.deleteBudget(scope, version);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_deleted",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: scope.budgetId,
  });
  await deps.mailer.sendAll(
    members.map((m) =>
      deps.notifications.budgetDeleted(
        m.email,
        before.name,
        m.userId === scope.userId,
      ),
    ),
  );
}

export async function transferOwnership(
  deps: AppDeps,
  auth: AuthContext,
  scope: BudgetScope,
  targetUserId: string,
) {
  const { members } = await deps.dal.members.transferOwnership(
    scope,
    targetUserId,
  );
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_ownership_transferred",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: scope.budgetId,
  });
  const budget = await deps.dal.budgets.getBudget(scope);
  const newOwner = members.find((m) => m.role === "owner");
  await deps.mailer.sendAll(
    members.map((m) =>
      deps.notifications.ownershipTransferred(
        m.email,
        budget.name,
        newOwner?.displayName ?? "",
        scope.budgetId,
      ),
    ),
  );
  return toBudget(budget);
}

export async function removeMember(
  deps: AppDeps,
  auth: AuthContext,
  scope: BudgetScope,
  targetUserId: string,
) {
  const budget = await deps.dal.budgets.getBudget(scope);
  const { removed } = await deps.dal.members.removeMember(scope, targetUserId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_member_removed",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: scope.budgetId,
  });
  // The notice goes to a member removed by the owner, not to someone leaving.
  if (removed.userId !== scope.userId)
    await deps.mailer.send(
      deps.notifications.memberRemoved(removed.email, budget.name),
    );
}

function inviteKeys(deps: AppDeps, scope: BudgetScope) {
  return {
    budget: deps.throttles.key("invite:budget", scope.budgetId),
    user: deps.throttles.key("invite:user", scope.userId),
  };
}

/**
 * errors.md step 7 for POST /budgets/{b}/invitations: 20 per budget and 30 per
 * user per UTC day. A read-only pre-check (keeps the 429 at step 7 and costs
 * no write when a cap is already spent), so a non-member (who gets 404 at step
 * 8) can never spend another budget's quota. The caps are enforced race-safely
 * by the reservations in createInvitation.
 */
export async function invitationRateLimit(
  deps: AppDeps,
  auth: AuthContext,
  budgetId: string,
): Promise<void> {
  await deps.throttles.assertUnder(
    deps.throttles.key("invite:budget", budgetId),
    INVITES_PER_BUDGET_PER_DAY,
    DAY,
  );
  await deps.throttles.assertUnder(
    deps.throttles.key("invite:user", auth.session.userId),
    INVITES_PER_USER_PER_DAY,
    DAY,
  );
}

/**
 * Same response whether or not the invitee has an account; mail only if they do.
 *
 * Reserve-first (F-45): both daily caps are charged with the atomic upsert
 * before the invitation is created, and the returned counts are compared, so
 * concurrent invites cannot all pass a stale read. Only created invitations
 * keep their slots: a refusal by either cap (429) or by the DAL (ALREADY_EXISTS,
 * LIMIT_REACHED, NOT_FOUND, ...) refunds both before the error propagates.
 */
export async function createInvitation(
  deps: AppDeps,
  auth: AuthContext,
  scope: BudgetScope,
  email: string,
) {
  const t = deps.throttles;
  const k = inviteKeys(deps, scope);
  const slots: Reservation[] = [];
  for (const [key, cap] of [
    [k.budget, INVITES_PER_BUDGET_PER_DAY],
    [k.user, INVITES_PER_USER_PER_DAY],
  ] as const) {
    const r = await t.reserve(key, DAY);
    slots.push(r);
    if (r.count > cap) {
      await t.releaseAll(slots);
      throw rateLimited(t.retryAfter(DAY));
    }
  }
  const { invitation, inviteeHasAccount } = await t.refundOnError(slots, () =>
    deps.dal.invitations.createBudgetInvitation(scope, email),
  );
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_invitation_created",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: scope.budgetId,
  });
  if (inviteeHasAccount) {
    const budget = await deps.dal.budgets.getBudget(scope);
    await deps.mailer.send(
      deps.notifications.budgetInvitation(
        invitation.email,
        invitation.invitedByDisplayName,
        budget.name,
      ),
    );
  }
  return toInvitation(invitation);
}

export async function revokeInvitation(
  deps: AppDeps,
  auth: AuthContext,
  scope: BudgetScope,
  invitationId: string,
) {
  await deps.dal.invitations.revokeBudgetInvitation(scope, invitationId);
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_invitation_revoked",
    userId: auth.session.userId,
    sessionId: auth.session.id,
    budgetId: scope.budgetId,
  });
}

export async function acceptInvitation(
  deps: AppDeps,
  auth: AuthContext,
  invitationId: string,
) {
  const userId = auth.session.userId;
  const { budget, owner } = await deps.dal.invitations.acceptInvitation(
    userId,
    invitationId,
  );
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "budget_invitation_accepted",
    userId,
    sessionId: auth.session.id,
    budgetId: budget.id,
  });
  const me = await deps.dal.users.getUserContact(userId);
  await deps.mailer.send(
    deps.notifications.invitationAccepted(
      owner.email,
      me.displayName,
      budget.name,
      budget.id,
    ),
  );
  return toBudget(budget);
}

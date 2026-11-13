// Budgets: list, create (with starter categories and this month's plan),
// read, rename/timezone, soft delete, deleted-budget list and restore
// (ADR-0006, ADR-0010, data-model.md "budgets" and "Limits").
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { DAY_MS, withTx } from "../context.ts";
import { budgetCalendar } from "../dates.ts";
import { invalid, limitReached, notFound, versionConflict } from "../errors.ts";
import type {
  BudgetRecord,
  DeletedBudgetRecord,
  MemberContact,
} from "../records.ts";
import type { CategoryKind } from "../schema.ts";
import type { BudgetScope, DeletedBudgetScope } from "../scope.ts";
import {
  assertBudgetScope,
  assertDeletedBudgetScope,
  isUuid,
  lockBudgetAsOwner,
  requireDeletedBudgetOwnership,
  requireMembership,
} from "../scope.ts";
import type { IdempotencyInput } from "./common.ts";
import {
  LIMITS,
  claimIdempotencyKey,
  countLiveBudgets,
  loadBudgetRecord,
  loadMemberContacts,
  lockUser,
} from "./common.ts";

/** Budgets the user is a member of (non-deleted), by name. */
export async function listBudgetsForUser(
  ctx: Ctx,
  userId: string,
): Promise<BudgetRecord[]> {
  if (!isUuid(userId)) return [];
  const rows = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("budgets as b", "b.id", "m.budget_id")
    .select([
      "b.id",
      "b.name",
      "b.timezone",
      "b.created_at",
      "b.updated_at",
      "b.version",
      "m.role",
      sql<number>`(select count(*)::int from budget_members c where c.budget_id = b.id)`.as(
        "member_count",
      ),
    ])
    .where("m.user_id", "=", userId)
    .where("b.deleted_at", "is", null)
    .orderBy(sql`lower(b.name)`)
    .orderBy("b.id")
    .limit(LIMITS.budgetsPerUserHard)
    .execute();
  const now = ctx.clock();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    currency: "USD" as const,
    myRole: r.role,
    memberCount: r.member_count,
    ...budgetCalendar(now, r.timezone),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  }));
}

export interface StarterCategoryInput {
  name: string;
  kind: CategoryKind;
  /** Creates a plan entry for the budget's current month when present. */
  plannedCents?: number | undefined;
}

export interface CreateBudgetInput {
  name: string;
  /** IANA zone, already validated by the API. */
  timezone: string;
  categories?: StarterCategoryInput[] | undefined;
}

export interface CreateResult<T> {
  /** true when an earlier request with the same Idempotency-Key created it. */
  replayed: boolean;
  value: T;
}

/**
 * POST /budgets: one transaction creates the budget, the owner membership, the
 * starter categories and this month's plan entries (J1). LIMIT_REACHED at 10
 * non-deleted budgets (the user row is locked so concurrent creates and
 * accepts cannot both pass the count).
 */
export async function createBudget(
  ctx: Ctx,
  userId: string,
  input: CreateBudgetInput,
  options: { idempotency?: IdempotencyInput } = {},
): Promise<CreateResult<BudgetRecord>> {
  const starters = input.categories ?? [];
  const seen = new Set<string>();
  starters.forEach((c, i) => {
    const key = c.name.toLowerCase();
    if (seen.has(key))
      throw invalid({
        in: "body",
        field: `categories.${i}.name`,
        issue: "duplicate",
      });
    seen.add(key);
  });

  const budgetId = ctx.newId();
  const replayId = await withTx(ctx, async (tx) => {
    if (options.idempotency) {
      if (options.idempotency.userId !== userId)
        throw new TypeError("idempotency.userId must be the caller");
      const existing = await claimIdempotencyKey(
        tx,
        options.idempotency,
        "budget",
        budgetId,
      );
      if (existing) return existing;
    }
    const user = await lockUser(tx, userId);
    if (user?.status !== "active") throw notFound();
    if ((await countLiveBudgets(tx, userId)) >= LIMITS.budgetsPerUser)
      throw limitReached();

    const now = tx.clock();
    await tx.db
      .insertInto("budgets")
      .values({
        id: budgetId,
        name: input.name,
        timezone: input.timezone,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tx.db
      .insertInto("budget_members")
      .values({
        budget_id: budgetId,
        user_id: userId,
        role: "owner",
        joined_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (starters.length > 0) {
      const { currentMonth } = budgetCalendar(now, input.timezone);
      const cats = starters.map((c, i) => ({
        ...c,
        id: tx.newId(),
        sortOrder: i,
      }));
      await tx.db
        .insertInto("categories")
        .values(
          cats.map((c) => ({
            id: c.id,
            budget_id: budgetId,
            name: c.name,
            kind: c.kind,
            sort_order: c.sortOrder,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
      const planned = cats.filter((c) => c.plannedCents !== undefined);
      if (planned.length > 0) {
        await tx.db
          .insertInto("plan_entries")
          .values(
            planned.map((c) => ({
              id: tx.newId(),
              budget_id: budgetId,
              category_id: c.id,
              month: `${currentMonth}-01`,
              amount_cents: c.plannedCents ?? 0,
              updated_by_user_id: userId,
              created_at: now,
              updated_at: now,
            })),
          )
          .execute();
      }
    }
    return null;
  });

  if (replayId) {
    // Replays go through the current membership check (F-18): a budget that
    // was deleted or left since then is NOT_FOUND.
    const scope = await requireMembership(ctx, userId, replayId);
    return {
      replayed: true,
      value: await loadBudgetRecord(ctx, scope.budgetId, userId),
    };
  }
  return {
    replayed: false,
    value: await loadBudgetRecord(ctx, budgetId, userId),
  };
}

export async function getBudget(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<BudgetRecord> {
  assertBudgetScope(scope);
  return loadBudgetRecord(ctx, scope.budgetId, scope.userId);
}

export interface UpdateBudgetInput {
  name?: string | undefined;
  timezone?: string | undefined;
  version: number;
}

/** PATCH /budgets/{b}: owner only; optimistic version. */
export async function updateBudget(
  ctx: Ctx,
  scope: BudgetScope,
  input: UpdateBudgetInput,
): Promise<BudgetRecord> {
  return withTx(ctx, async (tx) => {
    await lockBudgetAsOwner(tx, scope);
    const changes = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      updated_at: tx.clock(),
    };
    const updated = await tx.db
      .updateTable("budgets")
      .set(changes)
      .where("id", "=", scope.budgetId)
      .where("version", "=", input.version)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw versionConflict();
    return loadBudgetRecord(tx, scope.budgetId, scope.userId);
  });
}

/**
 * DELETE /budgets/{b}: owner only, soft delete (restorable for 30 days).
 * Returns every member's contact for the deletion notice.
 */
export async function deleteBudget(
  ctx: Ctx,
  scope: BudgetScope,
  version: number,
): Promise<{ members: MemberContact[] }> {
  return withTx(ctx, async (tx) => {
    await lockBudgetAsOwner(tx, scope);
    const now = tx.clock();
    const updated = await tx.db
      .updateTable("budgets")
      .set({ deleted_at: now, updated_at: now })
      .where("id", "=", scope.budgetId)
      .where("version", "=", version)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw versionConflict();
    return { members: await loadMemberContacts(tx, scope.budgetId) };
  });
}

/** GET /me/deleted-budgets: budgets the caller owns, deleted <= 30 days ago, newest first, at most 20. */
export async function listDeletedBudgets(
  ctx: Ctx,
  userId: string,
): Promise<DeletedBudgetRecord[]> {
  if (!isUuid(userId)) return [];
  const windowStart = new Date(ctx.clock().getTime() - 30 * DAY_MS);
  const rows = await ctx.db
    .selectFrom("budgets as b")
    .innerJoin("budget_members as m", (j) =>
      j
        .onRef("m.budget_id", "=", "b.id")
        .on("m.user_id", "=", userId)
        .on("m.role", "=", "owner"),
    )
    .select([
      "b.id",
      "b.name",
      "b.deleted_at",
      sql<number>`(select count(*)::int from budget_members c where c.budget_id = b.id)`.as(
        "member_count",
      ),
    ])
    .where("b.deleted_at", "is not", null)
    .where("b.deleted_at", ">=", windowStart)
    .orderBy("b.deleted_at", "desc")
    .orderBy("b.id", "desc")
    .limit(LIMITS.deletedBudgetsListed)
    .execute();
  return rows.flatMap((r) =>
    r.deleted_at
      ? [
          {
            id: r.id,
            name: r.name,
            deletedAt: r.deleted_at,
            restorableUntil: new Date(r.deleted_at.getTime() + 30 * DAY_MS),
            memberCount: r.member_count,
          },
        ]
      : [],
  );
}

/**
 * POST /me/deleted-budgets/{id}/restore (OD-5, F-36, F-37). Accepts only a
 * DeletedBudgetScope; re-validates it under a row lock in this transaction.
 * LIMIT_REACHED when the owner already has 10 non-deleted budgets, or any other
 * member would exceed 20 (the member is never named). Returns the restored
 * budget and every member's contact for the restore notice.
 */
export async function restoreDeletedBudget(
  ctx: Ctx,
  scope: DeletedBudgetScope,
): Promise<{ budget: BudgetRecord; members: MemberContact[] }> {
  assertDeletedBudgetScope(scope);
  return withTx(ctx, async (tx) => {
    await requireDeletedBudgetOwnership(tx, scope.userId, scope.budgetId);
    const memberIds = (
      await tx.db
        .selectFrom("budget_members")
        .select("user_id")
        .where("budget_id", "=", scope.budgetId)
        .orderBy("user_id")
        .execute()
    ).map((r) => r.user_id);
    for (const id of memberIds) {
      await lockUser(tx, id); // sorted order: no deadlock with other restores
      const live = await countLiveBudgets(tx, id);
      const bound =
        id === scope.userId ? LIMITS.budgetsPerUser : LIMITS.budgetsPerUserHard;
      if (live >= bound) throw limitReached();
    }
    const now = tx.clock();
    await tx.db
      .updateTable("budgets")
      .set({ deleted_at: null, updated_at: now })
      .where("id", "=", scope.budgetId)
      .execute();
    return {
      budget: await loadBudgetRecord(tx, scope.budgetId, scope.userId),
      members: await loadMemberContacts(tx, scope.budgetId),
    };
  });
}

/** Contacts of every member, for sharing notices (PII: never log). */
export async function listMemberContacts(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<MemberContact[]> {
  assertBudgetScope(scope);
  return loadMemberContacts(ctx, scope.budgetId);
}

// Monthly plan entries (ADR-0004): at most one entry per category and month;
// a missing entry means 0 planned; no rollover.
import type { Ctx } from "../context.ts";
import { withTx } from "../context.ts";
import { addMonths, monthOfDate, monthStart } from "../dates.ts";
import type { Month } from "../dates.ts";
import {
  DalError,
  isUniqueViolation,
  notFound,
  versionConflict,
} from "../errors.ts";
import type {
  MonthPlanRecord,
  PlanCopyResult,
  PlanEntryRecord,
} from "../records.ts";
import type { BudgetScope } from "../scope.ts";
import { assertBudgetScope, isUuid } from "../scope.ts";

interface PlanRow {
  category_id: string;
  month: string;
  amount_cents: number;
  updated_at: Date;
  updated_by_user_id: string | null;
  version: number;
}

const COLUMNS = [
  "category_id",
  "month",
  "amount_cents",
  "updated_at",
  "updated_by_user_id",
  "version",
] as const;

function toRecord(r: PlanRow): PlanEntryRecord {
  return {
    categoryId: r.category_id,
    month: monthOfDate(r.month),
    amountCents: r.amount_cents,
    updatedAt: r.updated_at,
    updatedByUserId: r.updated_by_user_id,
    version: r.version,
  };
}

async function loadPlan(
  ctx: Ctx,
  budgetId: string,
  month: Month,
): Promise<PlanEntryRecord[]> {
  const rows = await ctx.db
    .selectFrom("plan_entries as p")
    .innerJoin("categories as c", (j) =>
      j
        .onRef("c.budget_id", "=", "p.budget_id")
        .onRef("c.id", "=", "p.category_id"),
    )
    .select(COLUMNS.map((c) => `p.${c}` as const))
    .where("p.budget_id", "=", budgetId)
    .where("p.month", "=", monthStart(month))
    .orderBy("c.kind")
    .orderBy("c.sort_order")
    .orderBy("c.id")
    .execute();
  return rows.map(toRecord);
}

/** GET /budgets/{b}/months/{m}/plan */
export async function getMonthPlan(
  ctx: Ctx,
  scope: BudgetScope,
  month: Month,
): Promise<MonthPlanRecord> {
  assertBudgetScope(scope);
  monthStart(month);
  return {
    budgetId: scope.budgetId,
    month,
    items: await loadPlan(ctx, scope.budgetId, month),
  };
}

export interface PutPlanEntryInput {
  amountCents: number;
  /** Current version, or null to create. */
  version: number | null;
}

/**
 * PUT /budgets/{b}/months/{m}/plan/{c}. Unknown category -> NOT_FOUND;
 * archived -> CATEGORY_ARCHIVED; version null but an entry exists, or a stale
 * version -> VERSION_CONFLICT.
 */
export async function putPlanEntry(
  ctx: Ctx,
  scope: BudgetScope,
  month: Month,
  categoryId: string,
  input: PutPlanEntryInput,
): Promise<PlanEntryRecord> {
  assertBudgetScope(scope);
  const monthDate = monthStart(month);
  if (!isUuid(categoryId)) throw notFound();
  return withTx(ctx, async (tx) => {
    const category = await tx.db
      .selectFrom("categories")
      .select(["archived_at"])
      .where("budget_id", "=", scope.budgetId)
      .where("id", "=", categoryId)
      .executeTakeFirst();
    if (!category) throw notFound();
    const now = tx.clock();
    if (input.version === null) {
      if (category.archived_at !== null) {
        throw new DalError("CATEGORY_ARCHIVED", {
          details: [{ in: "body", field: "", issue: "archived" }],
        });
      }
      try {
        const row = await tx.db
          .insertInto("plan_entries")
          .values({
            id: tx.newId(),
            budget_id: scope.budgetId,
            category_id: categoryId,
            month: monthDate,
            amount_cents: input.amountCents,
            updated_by_user_id: scope.userId,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) => oc.columns(["category_id", "month"]).doNothing())
          .returning(COLUMNS)
          .executeTakeFirst();
        if (!row) throw versionConflict();
        return toRecord(row);
      } catch (e) {
        if (isUniqueViolation(e)) throw versionConflict();
        throw e;
      }
    }
    const existing = await tx.db
      .selectFrom("plan_entries")
      .select(["version"])
      .where("budget_id", "=", scope.budgetId)
      .where("category_id", "=", categoryId)
      .where("month", "=", monthDate)
      .executeTakeFirst();
    if (existing?.version !== input.version) throw versionConflict();
    if (category.archived_at !== null) {
      throw new DalError("CATEGORY_ARCHIVED", {
        details: [{ in: "body", field: "", issue: "archived" }],
      });
    }
    const row = await tx.db
      .updateTable("plan_entries")
      .set({
        amount_cents: input.amountCents,
        updated_by_user_id: scope.userId,
        updated_at: now,
      })
      .where("budget_id", "=", scope.budgetId)
      .where("category_id", "=", categoryId)
      .where("month", "=", monthDate)
      .where("version", "=", input.version)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!row) throw versionConflict();
    return toRecord(row);
  });
}

/**
 * POST /budgets/{b}/months/{m}/plan/copy-previous (J5). Copies month-1 entries
 * of non-archived categories. overwrite=false fills only categories with no
 * entry this month; overwrite=true replaces (no version check). Atomic.
 */
export async function copyPreviousMonthPlan(
  ctx: Ctx,
  scope: BudgetScope,
  month: Month,
  options: { overwrite?: boolean } = {},
): Promise<PlanCopyResult> {
  assertBudgetScope(scope);
  const target = monthStart(month);
  const sourceMonth = addMonths(month, -1);
  const source = monthStart(sourceMonth);
  return withTx(ctx, async (tx) => {
    // Serialize concurrent copies and plan edits for this budget.
    await tx.db
      .selectFrom("budgets")
      .select("id")
      .where("id", "=", scope.budgetId)
      .forNoKeyUpdate()
      .execute();
    const rows = await tx.db
      .selectFrom("plan_entries as s")
      .innerJoin("categories as c", (j) =>
        j
          .onRef("c.budget_id", "=", "s.budget_id")
          .onRef("c.id", "=", "s.category_id"),
      )
      .leftJoin("plan_entries as t", (j) =>
        j
          .onRef("t.category_id", "=", "s.category_id")
          .on("t.month", "=", target),
      )
      .select([
        "s.category_id",
        "s.amount_cents",
        "c.archived_at",
        "t.id as target_id",
      ])
      .where("s.budget_id", "=", scope.budgetId)
      .where("s.month", "=", source)
      .execute();
    const now = tx.clock();
    let copied = 0;
    let skipped = 0;
    for (const r of rows) {
      if (
        r.archived_at !== null ||
        (r.target_id !== null && options.overwrite !== true)
      ) {
        skipped++;
        continue;
      }
      if (r.target_id === null) {
        await tx.db
          .insertInto("plan_entries")
          .values({
            id: tx.newId(),
            budget_id: scope.budgetId,
            category_id: r.category_id,
            month: target,
            amount_cents: r.amount_cents,
            updated_by_user_id: scope.userId,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await tx.db
          .updateTable("plan_entries")
          .set({
            amount_cents: r.amount_cents,
            updated_by_user_id: scope.userId,
            updated_at: now,
          })
          .where("id", "=", r.target_id)
          .execute();
      }
      copied++;
    }
    return {
      budgetId: scope.budgetId,
      month,
      sourceMonth,
      copiedCount: copied,
      skippedCount: skipped,
      items: await loadPlan(tx, scope.budgetId, month),
    };
  });
}

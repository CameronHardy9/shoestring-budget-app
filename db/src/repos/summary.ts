// Month summary (ADR-0004 formulas, J3). The totals are computed only here:
// the client never recomputes them.
import type { Ctx } from "../context.ts";
import type { Month } from "../dates.ts";
import type { MonthSummaryRecord } from "../records.ts";
import type { BudgetScope } from "../scope.ts";
import { monthSummaryQuery, monthTransactionCountQuery } from "../queries.ts";
import { assertBudgetScope } from "../scope.ts";
import { summarize } from "../summary-math.ts";

/**
 * GET /budgets/{b}/months/{m}/summary. One query over non-deleted
 * transactions dated in the month (transactions_list_idx range scan) joined to
 * their splits (transaction_splits_transaction_category_key) and the month's
 * plan (plan_entries_budget_month_idx). Lists every non-archived category plus
 * archived ones with a plan entry or activity; ordered expense first, then
 * sortOrder, then name.
 */
export async function getMonthSummary(
  ctx: Ctx,
  scope: BudgetScope,
  month: Month,
): Promise<MonthSummaryRecord> {
  assertBudgetScope(scope);
  const result = await monthSummaryQuery(scope.budgetId, month).execute(ctx.db);
  const count = await monthTransactionCountQuery(
    ctx.db,
    scope.budgetId,
    month,
  ).executeTakeFirstOrThrow();

  const { categories, totals } = summarize(
    result.rows.map((r) => ({
      categoryId: r.category_id,
      name: r.name,
      kind: r.kind,
      archived: r.archived,
      plannedCents: r.planned_cents,
      outCents: r.out_cents,
      inCents: r.in_cents,
    })),
  );
  return {
    budgetId: scope.budgetId,
    month,
    categories,
    totals,
    transactionCount: count.n,
  };
}

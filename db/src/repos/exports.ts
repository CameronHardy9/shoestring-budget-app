// CSV export (data-model.md "CSV export"). Scope: every non-deleted budget the
// user is a member of; each budget is read through requireMembership() (F-18),
// never through a raw join. Output is the user's file: Sensitive, never logged.
import type { Ctx } from "../context.ts";
import { monthOfDate } from "../dates.ts";
import { csvCell, formatCents } from "../csv.ts";
import { requireMembership } from "../scope.ts";

function csv(rows: [string, boolean][][]): string {
  return (
    rows
      .map((r) => r.map(([v, user]) => csvCell(v, user)).join(","))
      .join("\r\n") + "\r\n"
  );
}

async function memberBudgetIds(ctx: Ctx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("budgets as b", "b.id", "m.budget_id")
    .select("m.budget_id")
    .where("m.user_id", "=", userId)
    .where("b.deleted_at", "is", null)
    .orderBy("b.created_at")
    .orderBy("b.id")
    .execute();
  return rows.map((r) => r.budget_id);
}

const TX_HEADER = [
  "budget_name",
  "transaction_id",
  "date",
  "direction",
  "total_amount",
  "split_category",
  "split_amount",
  "payee",
  "memo",
  "created_by",
  "created_at_utc",
];

/** POST /me/export {kind: transactions}: one row per split, oldest first. */
export async function exportTransactionsCsv(
  ctx: Ctx,
  userId: string,
): Promise<string> {
  const rows: [string, boolean][][] = [TX_HEADER.map((h) => [h, false])];
  for (const budgetId of await memberBudgetIds(ctx, userId)) {
    const scope = await requireMembership(ctx, userId, budgetId);
    const data = await ctx.db
      .selectFrom("transactions as t")
      .innerJoin("budgets as b", "b.id", "t.budget_id")
      .innerJoin("transaction_splits as s", (j) =>
        j
          .onRef("s.transaction_id", "=", "t.id")
          .onRef("s.budget_id", "=", "t.budget_id"),
      )
      .innerJoin("categories as c", (j) =>
        j
          .onRef("c.id", "=", "s.category_id")
          .onRef("c.budget_id", "=", "s.budget_id"),
      )
      .leftJoin("users as u", "u.id", "t.created_by_user_id")
      .select([
        "b.name as budget_name",
        "t.id",
        "t.date",
        "t.direction",
        "t.amount_cents",
        "c.name as category_name",
        "s.amount_cents as split_cents",
        "t.payee",
        "t.memo",
        "u.display_name",
        "t.created_at",
      ])
      .where("t.budget_id", "=", scope.budgetId)
      .where("t.deleted_at", "is", null)
      .orderBy("t.date")
      .orderBy("t.id")
      .orderBy("s.amount_cents", "desc")
      .orderBy("s.category_id")
      .execute();
    for (const r of data) {
      rows.push([
        [r.budget_name, true],
        [r.id, false],
        [r.date, false],
        [r.direction, false],
        [formatCents(r.amount_cents), false],
        [r.category_name, true],
        [formatCents(r.split_cents), false],
        [r.payee ?? "", true],
        [r.memo ?? "", true],
        [r.display_name ?? "", true],
        [r.created_at.toISOString(), false],
      ]);
    }
  }
  return csv(rows);
}

/** POST /me/export {kind: plans}: every plan entry, by month. */
export async function exportPlansCsv(
  ctx: Ctx,
  userId: string,
): Promise<string> {
  const rows: [string, boolean][][] = [
    ["budget_name", "month", "category", "category_kind", "planned_amount"].map(
      (h) => [h, false],
    ),
  ];
  for (const budgetId of await memberBudgetIds(ctx, userId)) {
    const scope = await requireMembership(ctx, userId, budgetId);
    const data = await ctx.db
      .selectFrom("plan_entries as p")
      .innerJoin("budgets as b", "b.id", "p.budget_id")
      .innerJoin("categories as c", (j) =>
        j
          .onRef("c.id", "=", "p.category_id")
          .onRef("c.budget_id", "=", "p.budget_id"),
      )
      .select([
        "b.name as budget_name",
        "p.month",
        "c.name as category_name",
        "c.kind",
        "p.amount_cents",
      ])
      .where("p.budget_id", "=", scope.budgetId)
      .orderBy("p.month")
      .orderBy("c.kind")
      .orderBy("c.sort_order")
      .orderBy("c.id")
      .execute();
    for (const r of data) {
      rows.push([
        [r.budget_name, true],
        [monthOfDate(r.month), false],
        [r.category_name, true],
        [r.kind, false],
        [formatCents(r.amount_cents), false],
      ]);
    }
  }
  return csv(rows);
}

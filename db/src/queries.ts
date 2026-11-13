// The two hot read queries, as builders, so the EXPLAIN test (queries.explain
// .test.ts) plans exactly the SQL the DAL runs. Internal to db/.
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { CalendarDate, Month } from "./dates.ts";
import { monthRange, monthStart } from "./dates.ts";
import type { CategoryKind, Database } from "./schema.ts";

type Db = Kysely<Database> | Transaction<Database>;

export const TX_COLUMNS = [
  "id",
  "budget_id",
  "date",
  "direction",
  "amount_cents",
  "payee",
  "memo",
  "created_by_user_id",
  "updated_by_user_id",
  "created_at",
  "updated_at",
  "version",
] as const;

export interface TransactionListFilter {
  month?: Month | undefined;
  categoryId?: string | undefined;
  after?: { date: CalendarDate; id: string } | undefined;
}

/**
 * Transaction list: keyset over transactions_list_idx
 * (budget_id, date DESC, id DESC) WHERE deleted_at IS NULL; the category
 * filter probes transaction_splits by (transaction_id, category_id).
 */
export function transactionListQuery(
  db: Db,
  budgetId: string,
  filter: TransactionListFilter,
  limit: number,
) {
  let q = db
    .selectFrom("transactions as t")
    .select(TX_COLUMNS.map((c) => `t.${c}` as const))
    .where("t.budget_id", "=", budgetId)
    .where("t.deleted_at", "is", null);
  if (filter.month !== undefined) {
    const { from, to } = monthRange(filter.month);
    q = q.where("t.date", ">=", from).where("t.date", "<", to);
  }
  if (filter.categoryId !== undefined) {
    const categoryId = filter.categoryId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("transaction_splits as s")
          .select(sql`1`.as("one"))
          .whereRef("s.transaction_id", "=", "t.id")
          .where("s.budget_id", "=", budgetId)
          .where("s.category_id", "=", categoryId),
      ),
    );
  }
  if (filter.after) {
    q = q.where(
      sql<boolean>`(t.date, t.id) < (${filter.after.date}::date, ${filter.after.id}::uuid)`,
    );
  }
  return q.orderBy("t.date", "desc").orderBy("t.id", "desc").limit(limit);
}

export interface MonthSummaryRow {
  category_id: string;
  name: string;
  kind: CategoryKind;
  archived: boolean;
  planned_cents: number;
  out_cents: number;
  in_cents: number;
}

/**
 * Month summary: non-deleted transactions dated in the month (range scan on
 * transactions_list_idx) joined to their splits (unique index on
 * (transaction_id, category_id)), plus the month's plan
 * (plan_entries_budget_month_idx) and the budget's categories.
 */
export function monthSummaryQuery(budgetId: string, month: Month) {
  const { from, to } = monthRange(month);
  const monthDate = monthStart(month);
  return sql<MonthSummaryRow>`
    with activity as (
      select s.category_id,
             sum(s.amount_cents) filter (where t.direction = 'outflow')::bigint as out_cents,
             sum(s.amount_cents) filter (where t.direction = 'inflow')::bigint as in_cents
        from transactions t
        join transaction_splits s on s.transaction_id = t.id and s.budget_id = t.budget_id
       where t.budget_id = ${budgetId}
         and t.deleted_at is null
         and t.date >= ${from}::date
         and t.date < ${to}::date
       group by s.category_id
    ), plan as (
      select category_id, amount_cents
        from plan_entries
       where budget_id = ${budgetId}
         and month = ${monthDate}::date
    )
    select c.id as category_id,
           c.name,
           c.kind,
           c.archived_at is not null as archived,
           coalesce(p.amount_cents, 0)::bigint as planned_cents,
           coalesce(a.out_cents, 0)::bigint as out_cents,
           coalesce(a.in_cents, 0)::bigint as in_cents
      from categories c
      left join plan p on p.category_id = c.id
      left join activity a on a.category_id = c.id
     where c.budget_id = ${budgetId}
       and (c.archived_at is null or p.category_id is not null or a.category_id is not null)
     order by c.kind, c.sort_order, lower(c.name), c.id
  `;
}

export function monthTransactionCountQuery(
  db: Db,
  budgetId: string,
  month: Month,
) {
  const { from, to } = monthRange(month);
  return db
    .selectFrom("transactions")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("budget_id", "=", budgetId)
    .where("deleted_at", "is", null)
    .where("date", ">=", from)
    .where("date", "<", to);
}

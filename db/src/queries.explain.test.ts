// EXPLAIN checks (data-model.md "Required indexes for performance"): the
// transaction list and the month summary, exactly as the DAL builds them,
// must use their indexes on a realistically sized database: 40 budgets with
// 2,000 transactions in the busiest month (the ARCHITECTURE p95 target) and
// ~3,000 more across other months each.
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  monthSummaryQuery,
  monthTransactionCountQuery,
  transactionListQuery,
} from "./queries.ts";
import type { Database } from "./schema.ts";
import { useTestDb } from "./test-support/harness.ts";

const t = useTestDb();
let db: Kysely<Database> | undefined;
const kdb = (): Kysely<Database> => {
  if (!db) throw new Error("not initialized");
  return db;
};
let budgetId: string;
let categoryId: string;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodes(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(nodes)];
}

async function explain(compiled: {
  sql: string;
  parameters: readonly unknown[];
}): Promise<PlanNode[]> {
  const r = await t.app.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    `explain (format json) ${compiled.sql}`,
    [...compiled.parameters],
  );
  const plan = r.rows[0]?.["QUERY PLAN"][0]?.Plan;
  if (!plan) throw new Error("no plan");
  return nodes(plan);
}

const seqScans = (ns: PlanNode[], table: string) =>
  ns.filter(
    (n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === table,
  );
const usesIndex = (ns: PlanNode[], index: string) =>
  ns.some((n) => n["Index Name"] === index);

beforeAll(async () => {
  // Bulk load as superuser with triggers off (the generated data is valid by
  // construction: one split per transaction carrying the full amount).
  const c = await t.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`
      insert into users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at)
      select gen_random_uuid(), 'perf' || g || '@example.test', 'Perf', '$argon2id$perf', now(), now(), now()
        from generate_series(1, 40) g`);
    await c.query(`
      insert into budgets (id, name, timezone, created_at, updated_at)
      select gen_random_uuid(), 'Perf ' || g, 'America/New_York', now(), now() from generate_series(1, 40) g`);
    await c.query(`
      insert into budget_members (budget_id, user_id, role, joined_at, created_at, updated_at)
      select b.id, u.id, 'owner', now(), now(), now()
        from (select id, row_number() over (order by id) r from budgets where name like 'Perf %') b
        join (select id, row_number() over (order by id) r from users where email like 'perf%') u using (r)`);
    await c.query(`
      insert into categories (id, budget_id, name, kind, sort_order, created_at, updated_at)
      select gen_random_uuid(), b.id, 'Cat ' || g, case when g <= 16 then 'expense' else 'income' end::category_kind, g, now(), now()
        from budgets b cross join generate_series(1, 20) g where b.name like 'Perf %'`);
    await c.query(`
      insert into plan_entries (id, budget_id, category_id, month, amount_cents, created_at, updated_at)
      select gen_random_uuid(), c.budget_id, c.id, make_date(2025, 1, 1) + make_interval(months => m), 10000, now(), now()
        from categories c join budgets b on b.id = c.budget_id cross join generate_series(0, 23) m where b.name like 'Perf %'`);
    // 5,000 transactions per budget: 2,000 in 2026-11, the rest over two years.
    await c.query(`
      with cats as (select c.budget_id, array_agg(c.id order by c.sort_order) ids from categories c join budgets b on b.id = c.budget_id where b.name like 'Perf %' group by c.budget_id),
      tx as (
        select gen_random_uuid() id, cats.budget_id, cats.ids[1 + (g % 20)] cat,
               case when g <= 2000 then date '2026-11-01' + (g % 30) else date '2025-01-01' + (g % 670) end d,
               100 + g amount, case when g % 10 = 0 then 'inflow' else 'outflow' end::transaction_direction dir
          from cats cross join generate_series(1, 5000) g
      ),
      ins as (
        insert into transactions (id, budget_id, date, direction, amount_cents, created_at, updated_at)
        select id, budget_id, d, dir, amount, now(), now() from tx returning id
      )
      insert into transaction_splits (id, budget_id, transaction_id, category_id, amount_cents, created_at)
      select gen_random_uuid(), budget_id, id, cat, amount, now() from tx`);
    await c.query("commit");
  } finally {
    c.release();
  }
  await t.admin.query("analyze");
  const r = await t.admin.query<{ id: string; cat: string }>(
    "select b.id, (select id from categories where budget_id = b.id order by sort_order limit 1) as cat from budgets b where name = 'Perf 7'",
  );
  budgetId = r.rows[0]?.id ?? "";
  categoryId = r.rows[0]?.cat ?? "";
  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: t.appUrl, max: 1 }),
    }),
  });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
});

describe("query plans", () => {
  it("transaction list (first page, a later page, month and category filters) uses transactions_list_idx", async () => {
    const variants = [
      transactionListQuery(kdb(), budgetId, {}, 51),
      transactionListQuery(
        kdb(),
        budgetId,
        { after: { date: "2026-11-15", id: randomUUID() } },
        51,
      ),
      transactionListQuery(kdb(), budgetId, { month: "2026-11" }, 51),
      transactionListQuery(
        kdb(),
        budgetId,
        { month: "2026-11", categoryId },
        51,
      ),
    ];
    for (const [i, q] of variants.entries()) {
      const plan = await explain(q.compile());
      expect(seqScans(plan, "transactions")).toEqual([]);
      expect(seqScans(plan, "transaction_splits")).toEqual([]);
      // The category filter drives from transaction_splits (budget_id, category_id),
      // as data-model.md specifies; the others walk the list index in order.
      expect(
        usesIndex(
          plan,
          i === 3
            ? "transaction_splits_budget_category_idx"
            : "transactions_list_idx",
        ),
      ).toBe(true);
    }
  });

  it("month summary uses the list index, a splits index and the plan index", async () => {
    const plan = await explain(
      monthSummaryQuery(budgetId, "2026-11").compile(kdb()),
    );
    expect(seqScans(plan, "transactions")).toEqual([]);
    expect(seqScans(plan, "transaction_splits")).toEqual([]);
    expect(seqScans(plan, "plan_entries")).toEqual([]);
    expect(usesIndex(plan, "transactions_list_idx")).toBe(true);
    // Splits are reached by index: per transaction (transaction_id) or, for a
    // month this busy, all of the budget's splits (budget_id, category_id).
    expect(
      usesIndex(plan, "transaction_splits_transaction_category_key") ||
        usesIndex(plan, "transaction_splits_budget_category_idx"),
    ).toBe(true);
    expect(usesIndex(plan, "plan_entries_budget_month_idx")).toBe(true);

    const count = await explain(
      monthTransactionCountQuery(kdb(), budgetId, "2026-11").compile(),
    );
    expect(seqScans(count, "transactions")).toEqual([]);
  });

  it("the summary over 2,000 transactions is fast", async () => {
    const started = performance.now();
    const r = await monthSummaryQuery(budgetId, "2026-11").execute(kdb());
    expect(r.rows).toHaveLength(20);
    expect(performance.now() - started).toBeLessThan(300);
  });
});

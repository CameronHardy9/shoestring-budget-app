// Money and month maths (ADR-0004, ADR-0005, data-model.md "Derived values").
//   - The month summary is checked against an independent model, property-based.
//   - Refunds (inflows on expense categories) reduce "spent", and may push it negative.
//   - "Today" and the current month follow the budget's timezone, across month
//     ends, year ends and both DST changes; a transaction's month is its date,
//     with no timezone conversion.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  archiveCategory,
  createBudget,
  createTransaction,
  setPlan,
} from "../support/factories.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import { dal, setClock } from "../support/hooks.ts";
import { persona, seedWorld } from "../support/world.ts";

interface CategorySummary {
  categoryId: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
  plannedCents: number;
  actualCents: number;
  remainingCents: number;
}
interface Totals {
  plannedCents: number;
  actualCents: number;
  remainingCents: number;
}
interface MonthSummary {
  categories: CategorySummary[];
  totals: { expense: Totals; income: Totals };
  transactionCount: number;
}

describe("month summary formulas (ADR-0004)", () => {
  it("expense: spent = outflows - refunds; remaining = planned - spent; income: received = inflows - outflows", async () => {
    const w = await seedWorld();
    const c = w.budget.categories; // plans this month: Groceries 500.00, Dining 200.00, Salary 4000.00
    await createTransaction(w.budget.scope, {
      date: "2026-11-02",
      categoryId: c.Groceries!,
      amountCents: 30_000,
    });
    await createTransaction(w.budget.scope, {
      date: "2026-11-03",
      categoryId: c.Groceries!,
      amountCents: 4_500,
      direction: "inflow",
    }); // refund
    await createTransaction(w.budget.scope, {
      date: "2026-11-04",
      categoryId: c.Dining!,
      amountCents: 25_000,
    }); // overspent
    await createTransaction(w.budget.scope, {
      date: "2026-11-05",
      categoryId: c.Salary!,
      amountCents: 380_000,
      direction: "inflow",
    });
    await createTransaction(w.budget.scope, {
      date: "2026-11-06",
      categoryId: c.Salary!,
      amountCents: 1_000,
      direction: "outflow",
    });
    await createTransaction(w.budget.scope, {
      date: "2026-10-31",
      categoryId: c.Groceries!,
      amountCents: 99_999,
    }); // other month
    const s = (
      await w.owner.client.get<MonthSummary>(
        `/budgets/${w.budget.id}/months/2026-11/summary`,
      )
    ).body;
    const by = (id: string) => s.categories.find((x) => x.categoryId === id)!;
    // The world's own transaction: Groceries 12.34 today.
    expect(by(c.Groceries!)).toMatchObject({
      plannedCents: 50_000,
      actualCents: 30_000 - 4_500 + 1_234,
      remainingCents: 50_000 - 26_734,
    });
    expect(by(c.Dining!)).toMatchObject({
      plannedCents: 20_000,
      actualCents: 25_000,
      remainingCents: -5_000,
    });
    expect(by(c.Salary!)).toMatchObject({
      plannedCents: 400_000,
      actualCents: 379_000,
      remainingCents: 21_000,
    });
    expect(s.totals.expense).toEqual({
      plannedCents: 70_000,
      actualCents: 51_734,
      remainingCents: 18_266,
    });
    expect(s.totals.income).toEqual({
      plannedCents: 400_000,
      actualCents: 379_000,
      remainingCents: 21_000,
    });
    expect(s.transactionCount).toBe(6);
    expect(s.categories.map((x) => x.kind)).toEqual([
      "expense",
      "expense",
      "income",
    ]);
  });

  it("a refund larger than the spending makes spent negative and remaining larger than planned", async () => {
    const w = await seedWorld();
    const g = w.budget.categories.Groceries!;
    await dal().transactions.deleteTransaction(
      w.budget.scope,
      w.tx.id,
      w.tx.version,
    );
    await createTransaction(w.budget.scope, {
      date: "2026-11-02",
      categoryId: g,
      amountCents: 1_000,
    });
    await createTransaction(w.budget.scope, {
      date: "2026-11-03",
      categoryId: g,
      amountCents: 6_000,
      direction: "inflow",
    });
    const s = (
      await w.owner.client.get<MonthSummary>(
        `/budgets/${w.budget.id}/months/2026-11/summary`,
      )
    ).body;
    expect(s.categories.find((x) => x.categoryId === g)).toMatchObject({
      actualCents: -5_000,
      remainingCents: 55_000,
    });
  });

  it("editing and deleting a transaction updates the totals at once (J4)", async () => {
    const w = await seedWorld();
    const g = w.budget.categories.Groceries!;
    const summary = async () =>
      (
        await w.owner.client.get<MonthSummary>(
          `/budgets/${w.budget.id}/months/2026-11/summary`,
        )
      ).body.categories.find((x) => x.categoryId === g)!;
    expect((await summary()).actualCents).toBe(1_234);
    const edited = await w.owner.client.put<{ version: number }>(
      `/budgets/${w.budget.id}/transactions/${w.tx.id}`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 5_000,
        payee: null,
        memo: null,
        splits: [{ categoryId: g, amountCents: 5_000 }],
        version: w.tx.version,
      },
    );
    expect((await summary()).actualCents).toBe(5_000);
    await w.owner.client.delete(
      `/budgets/${w.budget.id}/transactions/${w.tx.id}`,
      { query: { version: edited.body.version } },
    );
    expect((await summary()).actualCents).toBe(0);
  });

  it("archived categories are listed only with a plan entry or activity in that month", async () => {
    const w = await seedWorld();
    const c = w.budget.categories;
    await archiveCategory(w.budget.scope, c.Dining!); // has a plan in 2026-11, none in 2026-12
    const nov = (
      await w.owner.client.get<MonthSummary>(
        `/budgets/${w.budget.id}/months/2026-11/summary`,
      )
    ).body;
    const dec = (
      await w.owner.client.get<MonthSummary>(
        `/budgets/${w.budget.id}/months/2026-12/summary`,
      )
    ).body;
    expect(
      nov.categories.find((x) => x.categoryId === c.Dining!)?.archived,
    ).toBe(true);
    expect(dec.categories.some((x) => x.categoryId === c.Dining!)).toBe(false);
  });

  it("amounts are whole cents up to $1,000,000.00 and sums stay exact", async () => {
    const w = await seedWorld();
    const g = w.budget.categories.Groceries!;
    const post = (amountCents: number) =>
      w.owner.client.post(
        `/budgets/${w.budget.id}/transactions`,
        {
          date: w.today,
          direction: "outflow",
          amountCents,
          splits: [{ categoryId: g, amountCents }],
        },
        { idempotencyKey: randomUUID() },
      );
    for (const [amount, issue] of [
      [0, "too_small"],
      [100_000_001, "too_big"],
    ] as const) {
      const res = await post(amount);
      expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({ field: "amountCents", issue }),
      );
    }
    const frac = await w.owner.client.post(
      `/budgets/${w.budget.id}/transactions`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 10.5,
        splits: [{ categoryId: g, amountCents: 10.5 }],
      },
      { idempotencyKey: randomUUID() },
    );
    expect(codeOf(frac)).toBe("VALIDATION_FAILED");
    for (let i = 0; i < 20; i++)
      expect((await post(100_000_000)).status).toBe(201);
    const s = (
      await w.owner.client.get<MonthSummary>(
        `/budgets/${w.budget.id}/months/2026-11/summary`,
      )
    ).body;
    expect(s.categories.find((x) => x.categoryId === g)?.actualCents).toBe(
      20 * 100_000_000 + 1_234,
    );
    const plan = await w.owner.client.put(
      `/budgets/${w.budget.id}/months/2026-11/plan/${g}`,
      { amountCents: 100_000_001, version: 1 },
    );
    expect(codeOf(plan)).toBe("VALIDATION_FAILED");
  });

  it("property: the summary equals an independent model for random transactions, refunds, deletions and plans", async () => {
    const owner = await persona("modeller");
    const txArb = fc.record({
      day: fc.integer({ min: 0, max: 40 }), // spans Oct 31 .. Dec 9 around November
      cat: fc.integer({ min: 0, max: 3 }),
      split: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
      direction: fc.constantFrom<"outflow" | "inflow">(
        "outflow",
        "outflow",
        "inflow",
      ),
      amount: fc.integer({ min: 2, max: 100_000_000 }),
      deleted: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(txArb, { maxLength: 12 }),
        fc.array(
          fc.option(fc.integer({ min: 0, max: 100_000_000 }), {
            nil: undefined,
          }),
          { minLength: 4, maxLength: 4 },
        ),
        fc.boolean(),
        async (txs, plans, archiveLast) => {
          const budget = await createBudget(owner.user, {
            name: "Model",
            categories: [
              { name: "A rent", kind: "expense" },
              { name: "B food", kind: "expense" },
              { name: "C pay", kind: "income" },
              { name: "D old", kind: "expense" },
            ],
          });
          const ids = ["A rent", "B food", "C pay", "D old"].map(
            (n) => budget.categories[n]!,
          );
          const kinds = ["expense", "expense", "income", "expense"] as const;
          for (const [i, p] of plans.entries())
            if (p !== undefined)
              await setPlan(budget.scope, "2026-11", ids[i]!, p);
          const model = ids.map(() => ({ out: 0, in: 0, active: false }));
          let count = 0;
          for (const t of txs) {
            const date = new Date(Date.UTC(2026, 9, 31 + t.day))
              .toISOString()
              .slice(0, 10);
            const cats =
              t.split !== undefined && t.split !== t.cat
                ? [t.cat, t.split]
                : [t.cat];
            const first =
              cats.length === 2 ? Math.floor(t.amount / 2) : t.amount;
            const splits = cats.map((ci, k) => ({
              categoryId: ids[ci]!,
              amountCents: k === 0 ? first : t.amount - first,
            }));
            const rec = await createTransaction(budget.scope, {
              date,
              direction: t.direction,
              amountCents: t.amount,
              splits,
            });
            if (t.deleted)
              await dal().transactions.deleteTransaction(
                budget.scope,
                rec.id,
                rec.version,
              );
            if (t.deleted || !date.startsWith("2026-11")) continue;
            count++;
            cats.forEach((ci, k) => {
              const m = model[ci]!;
              m.active = true;
              if (t.direction === "outflow") m.out += splits[k]!.amountCents;
              else m.in += splits[k]!.amountCents;
            });
          }
          if (archiveLast) await archiveCategory(budget.scope, ids[3]!);
          const s = (
            await owner.client.get<MonthSummary>(
              `/budgets/${budget.id}/months/2026-11/summary`,
            )
          ).body;
          const expected = ids
            .map((id, i) => {
              const planned = plans[i] ?? 0;
              const m = model[i]!;
              const actual =
                kinds[i] === "expense" ? m.out - m.in : m.in - m.out;
              const listed =
                !(archiveLast && i === 3) || plans[i] !== undefined || m.active;
              return listed
                ? {
                    categoryId: id,
                    kind: kinds[i],
                    plannedCents: planned,
                    actualCents: actual,
                    remainingCents: planned - actual,
                  }
                : null;
            })
            .filter((x) => x !== null);
          expect(
            s.categories.map(
              ({
                categoryId,
                kind,
                plannedCents,
                actualCents,
                remainingCents,
              }) => ({
                categoryId,
                kind,
                plannedCents,
                actualCents,
                remainingCents,
              }),
            ),
          ).toEqual([
            ...expected.filter((e) => e.kind === "expense"),
            ...expected.filter((e) => e.kind === "income"),
          ]);
          const total = (k: string): Totals => {
            const rows = expected.filter((e) => e.kind === k);
            const sum = (f: (r: (typeof rows)[number]) => number) =>
              rows.reduce((a, r) => a + f(r), 0);
            return {
              plannedCents: sum((r) => r.plannedCents),
              actualCents: sum((r) => r.actualCents),
              remainingCents: sum((r) => r.remainingCents),
            };
          };
          expect(s.totals).toEqual({
            expense: total("expense"),
            income: total("income"),
          });
          expect(s.transactionCount).toBe(count);
          await dal().budgets.deleteBudget(
            budget.scope,
            (await dal().budgets.getBudget(budget.scope)).version,
          );
        },
      ),
      { numRuns: 12, seed: 4004 },
    );
  });
});

describe("today and the current month follow the budget timezone (ADR-0005)", () => {
  async function budgetAt(instant: string, timezone: string) {
    await setClock(instant);
    const p = await persona("tz");
    const created = await p.client.post<{
      id: string;
      today: string;
      currentMonth: string;
    }>(
      "/budgets",
      {
        name: "Clock check",
        timezone,
        categories: [{ name: "Food", kind: "expense", plannedCents: 1_000 }],
      },
      { idempotencyKey: randomUUID() },
    );
    expect(created.status).toBe(201);
    return { p, ...created.body };
  }

  it.each([
    // [label, instant (UTC), zone, today, currentMonth]
    [
      "LA at 23:30 on Nov 30 (UTC is already Dec 1)",
      "2026-12-01T07:30:00Z",
      "America/Los_Angeles",
      "2026-11-30",
      "2026-11",
    ],
    [
      "Kiritimati at the same instant (UTC+14)",
      "2026-12-01T07:30:00Z",
      "Pacific/Kiritimati",
      "2026-12-01",
      "2026-12",
    ],
    [
      "New York one second before the new year",
      "2027-01-01T04:59:59Z",
      "America/New_York",
      "2026-12-31",
      "2026-12",
    ],
    [
      "New York at the new year",
      "2027-01-01T05:00:00Z",
      "America/New_York",
      "2027-01-01",
      "2027-01",
    ],
    [
      "New York, last EST minute before spring forward",
      "2026-03-08T06:59:00Z",
      "America/New_York",
      "2026-03-08",
      "2026-03",
    ],
    [
      "New York, midnight before spring forward",
      "2026-03-08T04:59:59Z",
      "America/New_York",
      "2026-03-07",
      "2026-03",
    ],
    [
      "New York, one second before November under EDT",
      "2026-11-01T03:59:59Z",
      "America/New_York",
      "2026-10-31",
      "2026-10",
    ],
    [
      "New York, November under EDT",
      "2026-11-01T04:00:00Z",
      "America/New_York",
      "2026-11-01",
      "2026-11",
    ],
    [
      "New York, repeated 01:30 after fall back (EST)",
      "2026-11-01T06:30:00Z",
      "America/New_York",
      "2026-11-01",
      "2026-11",
    ],
    [
      "LA, midnight on the day DST ends",
      "2026-11-01T07:00:00Z",
      "America/Los_Angeles",
      "2026-11-01",
      "2026-11",
    ],
    [
      "Chicago on Feb 28 at 23:59 in a non-leap year",
      "2027-03-01T05:59:00Z",
      "America/Chicago",
      "2027-02-28",
      "2027-02",
    ],
  ])("%s", async (_label, instant, zone, today, month) => {
    const b = await budgetAt(instant, zone);
    expect([b.today, b.currentMonth]).toEqual([today, month]);
    // Starter plans land in the budget's current month, not UTC's.
    const plan = await b.p.client.get<{ items: unknown[] }>(
      `/budgets/${b.id}/months/${month}/plan`,
    );
    expect(plan.body.items).toHaveLength(1);
  });

  it("transaction dates run from 2000-01-01 to one year after the budget's today (not UTC's)", async () => {
    const b = await budgetAt("2026-12-01T07:30:00Z", "America/Los_Angeles"); // today 2026-11-30
    const cats = await b.p.client.get<{ items: { id: string }[] }>(
      `/budgets/${b.id}/categories`,
    );
    const cat = cats.body.items[0]!.id;
    const post = (date: string) =>
      b.p.client.post(
        `/budgets/${b.id}/transactions`,
        {
          date,
          direction: "outflow",
          amountCents: 100,
          splits: [{ categoryId: cat, amountCents: 100 }],
        },
        { idempotencyKey: randomUUID() },
      );
    expect((await post("2000-01-01")).status).toBe(201);
    expect((await post("2027-11-30")).status).toBe(201);
    for (const [date, issue] of [
      ["1999-12-31", "too_small"],
      ["2027-12-01", "too_big"],
    ] as const) {
      const res = await post(date);
      expect([res.status, codeOf(res)], date).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({ field: "date", issue }),
      );
    }
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "26-11-30",
      "2026-11-30T00:00:00Z",
    ]) {
      const res = await post(bad);
      expect(codeOf(res), bad).toBe("VALIDATION_FAILED");
    }
  });

  it("a transaction's month is its calendar date, whatever the budget timezone", async () => {
    const b = await budgetAt("2026-12-01T07:30:00Z", "Pacific/Kiritimati"); // today 2026-12-01 there
    const cats = await b.p.client.get<{ items: { id: string }[] }>(
      `/budgets/${b.id}/categories`,
    );
    const cat = cats.body.items[0]!.id;
    await b.p.client.post(
      `/budgets/${b.id}/transactions`,
      {
        date: "2026-11-30",
        direction: "outflow",
        amountCents: 700,
        splits: [{ categoryId: cat, amountCents: 700 }],
      },
      { idempotencyKey: randomUUID() },
    );
    const nov = await b.p.client.get<MonthSummary>(
      `/budgets/${b.id}/months/2026-11/summary`,
    );
    const dec = await b.p.client.get<MonthSummary>(
      `/budgets/${b.id}/months/2026-12/summary`,
    );
    expect([nov.body.transactionCount, dec.body.transactionCount]).toEqual([
      1, 0,
    ]);
    const listed = await b.p.client.get<{ items: unknown[] }>(
      `/budgets/${b.id}/transactions`,
      { query: { month: "2026-11" } },
    );
    expect(listed.body.items).toHaveLength(1);
  });
});

describe("copy last month's plan (J5)", () => {
  it("copies across the year boundary, fills only empty entries, skips archived categories, and overwrites on request", async () => {
    const w = await seedWorld();
    const c = w.budget.categories;
    await setPlan(w.budget.scope, "2026-12", c.Groceries!, 60_000);
    await setPlan(w.budget.scope, "2026-12", c.Dining!, 25_000);
    await setPlan(w.budget.scope, "2026-12", c.Salary!, 410_000);
    await setPlan(w.budget.scope, "2027-01", c.Groceries!, 1);
    await archiveCategory(w.budget.scope, c.Dining!);
    const path = `/budgets/${w.budget.id}/months/2027-01/plan/copy-previous`;
    const res = await w.owner.client.post<{
      sourceMonth: string;
      copiedCount: number;
      skippedCount: number;
      items: { categoryId: string; amountCents: number }[];
    }>(path, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sourceMonth: "2026-12",
      copiedCount: 1,
      skippedCount: 2,
    });
    const amount = (id: string) =>
      res.body.items.find((i) => i.categoryId === id)?.amountCents;
    expect([
      amount(c.Groceries!),
      amount(c.Salary!),
      amount(c.Dining!),
    ]).toEqual([1, 410_000, undefined]);
    const over = await w.owner.client.post<{
      copiedCount: number;
      items: { categoryId: string; amountCents: number }[];
    }>(path, { overwrite: true });
    expect(
      over.body.items.find((i) => i.categoryId === c.Groceries!)?.amountCents,
    ).toBe(60_000);
    const empty = await w.owner.client.post<{ copiedCount: number }>(
      `/budgets/${w.budget.id}/months/2030-01/plan/copy-previous`,
      {},
    );
    expect([empty.status, empty.body.copiedCount]).toEqual([200, 0]);
  });

  it("an invalid month in the path is 400 (path, month)", async () => {
    const w = await seedWorld();
    for (const m of ["2026-13", "2026-1", "2026-11-01"]) {
      const res = await w.owner.client.get(
        `/budgets/${w.budget.id}/months/${m}/summary`,
      );
      expect([res.status, codeOf(res)], m).toEqual([400, "VALIDATION_FAILED"]);
    }
  });
});

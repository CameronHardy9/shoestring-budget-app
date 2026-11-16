// Split rules (ADR-0004, data-model.md transaction_splits, errors.md): 1-20
// splits, distinct categories, positive amounts summing exactly to the parent,
// no NEW use of an archived category.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TestBudget } from "../support/factories.ts";
import {
  archiveCategory,
  createBudget,
  createCategory,
  createTransaction,
} from "../support/factories.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import type { ApiClient } from "../support/http.ts";
import type { World } from "../support/world.ts";
import { persona, seedWorld } from "../support/world.ts";

interface Split {
  categoryId: string;
  amountCents: number;
}

function post(w: World, body: object, client: ApiClient = w.owner.client) {
  return client.post<{ id: string; splits: Split[]; amountCents: number }>(
    `/budgets/${w.budget.id}/transactions`,
    body,
    {
      idempotencyKey: randomUUID(),
    },
  );
}

function tx(w: World, amountCents: number, splits: Split[]) {
  return { date: w.today, direction: "outflow", amountCents, splits };
}

async function manyCategories(
  budget: TestBudget,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push(
      await createCategory(budget.scope, `Cat ${String(i).padStart(2, "0")}`),
    );
  return ids;
}

describe("split sums", () => {
  it("splits that sum exactly are stored, and come back ordered by amount desc, then categoryId", async () => {
    const w = await seedWorld();
    const c = w.budget.categories;
    const res = await post(
      w,
      tx(w, 10_000, [
        { categoryId: c.Dining!, amountCents: 2_500 },
        { categoryId: c.Groceries!, amountCents: 7_000 },
        { categoryId: c.Salary!, amountCents: 500 },
      ]),
    );
    expect(res.status).toBe(201);
    expect(res.body.splits.map((s) => s.amountCents)).toEqual([
      7_000, 2_500, 500,
    ]);
  });

  it.each([
    ["less than the total", 9_999],
    ["more than the total", 10_001],
  ])(
    "splits summing to %s → 422 SPLITS_DO_NOT_SUM (body, splits, sum_mismatch), nothing stored",
    async (_l, second) => {
      const w = await seedWorld();
      const c = w.budget.categories;
      const res = await post(
        w,
        tx(w, 12_000, [
          { categoryId: c.Groceries!, amountCents: 2_000 },
          { categoryId: c.Dining!, amountCents: second },
        ]),
      );
      expect([res.status, codeOf(res)]).toEqual([422, "SPLITS_DO_NOT_SUM"]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({
          in: "body",
          field: "splits",
          issue: "sum_mismatch",
        }),
      );
      const list = await w.owner.client.get<{ items: unknown[] }>(
        `/budgets/${w.budget.id}/transactions`,
      );
      expect(list.body.items).toHaveLength(1); // only the world's own transaction
    },
  );

  it("the same category twice → 400 (splits.1.categoryId, duplicate)", async () => {
    const w = await seedWorld();
    const g = w.budget.categories.Groceries!;
    const res = await post(
      w,
      tx(w, 200, [
        { categoryId: g, amountCents: 100 },
        { categoryId: g, amountCents: 100 },
      ]),
    );
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({
        field: "splits.1.categoryId",
        issue: "duplicate",
      }),
    );
  });

  it("a zero split amount → 400 (splits.0.amountCents, too_small)", async () => {
    const w = await seedWorld();
    const res = await post(
      w,
      tx(w, 100, [
        { categoryId: w.budget.categories.Groceries!, amountCents: 0 },
        { categoryId: w.budget.categories.Dining!, amountCents: 100 },
      ]),
    );
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({
        field: "splits.0.amountCents",
        issue: "too_small",
      }),
    );
  });

  it("no splits → 400; 20 splits → 201; 21 splits → 400 (field splits)", async () => {
    const w = await seedWorld();
    const ids = await manyCategories(w.budget, 21);
    const none = await post(w, tx(w, 100, []));
    expect([none.status, codeOf(none)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(none).map((d) => d.field)).toContain("splits");
    const twenty = await post(
      w,
      tx(
        w,
        2_000,
        ids
          .slice(0, 20)
          .map((categoryId) => ({ categoryId, amountCents: 100 })),
      ),
    );
    expect(twenty.status).toBe(201);
    expect(twenty.body.splits).toHaveLength(20);
    const many = await post(
      w,
      tx(
        w,
        2_100,
        ids.map((categoryId) => ({ categoryId, amountCents: 100 })),
      ),
    );
    expect([many.status, codeOf(many)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(many).map((d) => d.field)).toContain("splits");
  });

  it("property: any partition of an amount over distinct categories is stored exactly and adds up in the summary", async () => {
    const owner = await persona("splitter");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.constantFrom<"outflow" | "inflow">("outflow", "inflow"),
        async (parts, direction) => {
          const budget = await createBudget(owner.user, {
            name: "Split budget",
            categories: [],
          });
          const ids = await manyCategories(budget, parts.length);
          const total = parts.reduce((a, b) => a + b, 0);
          const splits = parts.map((amountCents, i) => ({
            categoryId: ids[i]!,
            amountCents,
          }));
          const res = await owner.client.post<{ splits: Split[] }>(
            `/budgets/${budget.id}/transactions`,
            { date: "2026-11-16", direction, amountCents: total, splits },
            { idempotencyKey: randomUUID() },
          );
          expect(res.status, res.describe).toBe(201);
          expect(
            [...res.body.splits].sort((a, b) =>
              a.categoryId.localeCompare(b.categoryId),
            ),
          ).toEqual(
            [...splits].sort((a, b) =>
              a.categoryId.localeCompare(b.categoryId),
            ),
          );
          const summary = await owner.client.get<{
            categories: { categoryId: string; actualCents: number }[];
            totals: { expense: { actualCents: number } };
          }>(`/budgets/${budget.id}/months/2026-11/summary`);
          const sign = direction === "outflow" ? 1 : -1;
          for (const s of splits)
            expect(
              summary.body.categories.find((c) => c.categoryId === s.categoryId)
                ?.actualCents,
            ).toBe(sign * s.amountCents);
          expect(summary.body.totals.expense.actualCents).toBe(sign * total);
          await owner.client.delete(`/budgets/${budget.id}`, {
            query: { version: 1 },
          });
        },
      ),
      { numRuns: 8, seed: 20261116 },
    );
  });
});

describe("archived categories (CATEGORY_ARCHIVED)", () => {
  it("a new split on an archived category → 422 CATEGORY_ARCHIVED (splits.N.categoryId, archived)", async () => {
    const w = await seedWorld();
    await archiveCategory(w.budget.scope, w.budget.categories.Dining!);
    const res = await post(
      w,
      tx(w, 300, [
        { categoryId: w.budget.categories.Groceries!, amountCents: 200 },
        { categoryId: w.budget.categories.Dining!, amountCents: 100 },
      ]),
    );
    expect([res.status, codeOf(res)]).toEqual([422, "CATEGORY_ARCHIVED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({
        field: "splits.1.categoryId",
        issue: "archived",
      }),
    );
  });

  it("an edit may keep an archived category already on the transaction, but not add one", async () => {
    const w = await seedWorld();
    const c = w.budget.categories;
    const existing = await createTransaction(w.budget.scope, {
      date: w.today,
      categoryId: c.Dining!,
      amountCents: 900,
    });
    await archiveCategory(w.budget.scope, c.Dining!);
    const keep = await w.owner.client.put<{ version: number }>(
      `/budgets/${w.budget.id}/transactions/${existing.id}`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 1_000,
        payee: null,
        memo: "kept",
        splits: [
          { categoryId: c.Dining!, amountCents: 600 },
          { categoryId: c.Groceries!, amountCents: 400 },
        ],
        version: existing.version,
      },
    );
    expect(keep.status, keep.describe).toBe(200);
    const g = await createTransaction(w.budget.scope, {
      date: w.today,
      categoryId: c.Groceries!,
      amountCents: 500,
    });
    const add = await w.owner.client.put(
      `/budgets/${w.budget.id}/transactions/${g.id}`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 500,
        payee: null,
        memo: null,
        splits: [{ categoryId: c.Dining!, amountCents: 500 }],
        version: g.version,
      },
    );
    expect([add.status, codeOf(add)]).toEqual([422, "CATEGORY_ARCHIVED"]);
  });

  it("a plan entry on an archived category → 422 CATEGORY_ARCHIVED; a used category cannot be deleted (409 CATEGORY_IN_USE)", async () => {
    const w = await seedWorld();
    await archiveCategory(w.budget.scope, w.budget.categories.Dining!);
    const plan = await w.owner.client.put(
      `/budgets/${w.budget.id}/months/2026-12/plan/${w.budget.categories.Dining!}`,
      { amountCents: 100, version: null },
    );
    expect([plan.status, codeOf(plan)]).toEqual([422, "CATEGORY_ARCHIVED"]);
    const del = await w.owner.client.delete(
      `/budgets/${w.budget.id}/categories/${w.budget.categories.Groceries!}`,
      { query: { version: 1 } },
    );
    expect([del.status, codeOf(del)]).toEqual([409, "CATEGORY_IN_USE"]);
  });

  it("a category used only by a soft-deleted transaction is still in use (409 CATEGORY_IN_USE)", async () => {
    const w = await seedWorld();
    const id = await createCategory(w.budget.scope, "Short lived");
    const t = await createTransaction(w.budget.scope, {
      date: w.today,
      categoryId: id,
    });
    expect(
      (
        await w.owner.client.delete(
          `/budgets/${w.budget.id}/transactions/${t.id}`,
          { query: { version: 1 } },
        )
      ).status,
    ).toBe(204);
    const del = await w.owner.client.delete(
      `/budgets/${w.budget.id}/categories/${id}`,
      { query: { version: 1 } },
    );
    expect([del.status, codeOf(del)]).toEqual([409, "CATEGORY_IN_USE"]);
  });
});

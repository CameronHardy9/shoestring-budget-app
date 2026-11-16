// Cursor paging of GET /budgets/{b}/transactions (J4, api.openapi.yaml):
// order date DESC, id DESC; MAC'd cursors bound to the budget and filters
// (auth.md §12); keyset paging stays stable while transactions are added.
import { describe, expect, it } from "vitest";
import { createCategory, createTransaction } from "../support/factories.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import type { ApiClient, Query } from "../support/http.ts";
import { dal } from "../support/dal.ts";
import type { World } from "../support/world.ts";
import { seedWorld } from "../support/world.ts";

interface Page {
  items: { id: string; date: string; splits: { categoryId: string }[] }[];
  nextCursor: string | null;
}

async function walk(
  client: ApiClient,
  path: string,
  query: Query,
): Promise<{ pages: Page[]; ids: string[] }> {
  const pages: Page[] = [];
  let cursor = query.cursor as string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await client.get<Page>(path, { query: { ...query, cursor } });
    expect(res.status, res.describe).toBe(200);
    pages.push(res.body);
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  return { pages, ids: pages.flatMap((p) => p.items.map((i) => i.id)) };
}

/** 120 transactions over 40 days of Oct-Nov 2026 (3 per day), plus the world's one. */
async function seeded(): Promise<{
  w: World;
  all: { id: string; date: string }[];
}> {
  const w = await seedWorld();
  const all = [{ id: w.tx.id, date: w.tx.date }];
  for (let i = 0; i < 120; i++) {
    const date = new Date(Date.UTC(2026, 9, 1 + (i % 40)))
      .toISOString()
      .slice(0, 10);
    const cat =
      i % 3 === 0
        ? w.budget.categories.Dining!
        : w.budget.categories.Groceries!;
    const t = await createTransaction(w.budget.scope, {
      date,
      categoryId: cat,
      amountCents: 100 + i,
    });
    all.push({ id: t.id, date });
  }
  all.sort((a, b) =>
    a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1,
  );
  return { w, all };
}

describe("cursor paging", () => {
  it("pages of 50 cover every transaction exactly once, in date DESC, id DESC order", async () => {
    const { w, all } = await seeded();
    const { pages, ids } = await walk(
      w.owner.client,
      `/budgets/${w.budget.id}/transactions`,
      { limit: 50 },
    );
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 21]);
    expect(pages.at(-1)!.nextCursor).toBeNull();
    expect(ids).toEqual(all.map((t) => t.id));
  });

  it("the default page size is 50; limit must be 1-100", async () => {
    const { w } = await seeded();
    const path = `/budgets/${w.budget.id}/transactions`;
    expect((await w.owner.client.get<Page>(path)).body.items).toHaveLength(50);
    expect(
      (await w.owner.client.get<Page>(path, { query: { limit: 100 } })).body
        .items,
    ).toHaveLength(100);
    for (const limit of [0, 101, -1, "ten"]) {
      const res = await w.owner.client.get(path, { query: { limit } });
      expect([res.status, codeOf(res)], String(limit)).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({ in: "query", field: "limit" }),
      );
    }
  });

  it("month and category filters page correctly (category = at least one split in it)", async () => {
    const { w, all } = await seeded();
    const dining = w.budget.categories.Dining!;
    const nov = await walk(
      w.owner.client,
      `/budgets/${w.budget.id}/transactions`,
      { month: "2026-11", limit: 7 },
    );
    expect(nov.ids).toEqual(
      all.filter((t) => t.date.startsWith("2026-11")).map((t) => t.id),
    );
    const byCat = await walk(
      w.owner.client,
      `/budgets/${w.budget.id}/transactions`,
      { categoryId: dining, limit: 9 },
    );
    expect(byCat.ids).toHaveLength(40);
    for (const p of byCat.pages)
      for (const t of p.items)
        expect(t.splits.map((s) => s.categoryId)).toContain(dining);
  });

  it("a cursor used with other filters, or tampered with, is 400 (query, cursor, invalid_value)", async () => {
    const { w } = await seeded();
    const path = `/budgets/${w.budget.id}/transactions`;
    const page = await w.owner.client.get<Page>(path, {
      query: { month: "2026-10", limit: 5 },
    });
    const cursor = page.body.nextCursor!;
    const expectCursorRefused = async (query: Query) => {
      const res = await w.owner.client.get(path, { query });
      expect([res.status, codeOf(res)], JSON.stringify(query)).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({ in: "query", field: "cursor" }),
      );
    };
    await expectCursorRefused({ month: "2026-11", limit: 5, cursor });
    await expectCursorRefused({ limit: 5, cursor });
    await expectCursorRefused({
      month: "2026-10",
      categoryId: w.budget.categories.Dining!,
      limit: 5,
      cursor,
    });
    const flipped =
      cursor.slice(0, -2) +
      (cursor.at(-2) === "A" ? "B" : "A") +
      cursor.at(-1)!;
    await expectCursorRefused({ month: "2026-10", limit: 5, cursor: flipped });
    await expectCursorRefused({ month: "2026-10", limit: 5, cursor: "AAAA" });
    // The untouched cursor with the same filters works (a different limit is allowed? only same filters are bound).
    expect(
      (
        await w.owner.client.get(path, {
          query: { month: "2026-10", limit: 5, cursor },
        })
      ).status,
    ).toBe(200);
  });

  it("transactions added or deleted between pages never duplicate or skip the remaining ones", async () => {
    const { w, all } = await seeded();
    const path = `/budgets/${w.budget.id}/transactions`;
    const first = await w.owner.client.get<Page>(path, {
      query: { limit: 30 },
    });
    // A newer transaction and a deleted one from the next page arrive meanwhile.
    await createTransaction(w.budget.scope, {
      date: "2026-11-30",
      categoryId: await createCategory(w.budget.scope, "Late"),
    });
    const victim = all[35]!;
    const rec = await dal().transactions.getTransaction(
      w.budget.scope,
      victim.id,
    );
    await dal().transactions.deleteTransaction(
      w.budget.scope,
      victim.id,
      rec.version,
    );
    const rest = await walk(w.owner.client, path, {
      limit: 30,
      cursor: first.body.nextCursor!,
    });
    const seen = [...first.body.items.map((i) => i.id), ...rest.ids];
    expect(seen).toEqual(all.map((t) => t.id).filter((id) => id !== victim.id));
  });
});

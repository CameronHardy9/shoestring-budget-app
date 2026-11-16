// Two-household isolation through HTTP (F-18, checklist C8.4, auth.md §12
// "Within a scope"). Household A's IDs are used by household B in paths,
// bodies, filters, cursors and idempotency keys; B must learn nothing (every
// answer is 404, a 400 about its own request, or an empty page), none of A's
// text may appear in any answer B gets, and A's data must be unchanged.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { TestBudget } from "../support/factories.ts";
import {
  addMember,
  createBudget,
  createTransaction,
} from "../support/factories.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import type { ApiResponse } from "../support/http.ts";
import { dal } from "../support/hooks.ts";
import type { Persona } from "../support/world.ts";
import { persona } from "../support/world.ts";

// Distinctive Sensitive text that must never reach household B.
const SECRET = {
  budget: "Alpha household zq7",
  payee: "Alpha pharmacy zq7",
  memo: "alpha memo zq7",
  category: "Alpha rent zq7",
};

interface Households {
  a: Persona;
  b: Persona;
  budgetA: TestBudget;
  budgetB: TestBudget;
  txA: string;
  catA: string;
  invitationA: string;
  catB: string;
  seen: ApiResponse[];
}

let h: Households;

async function snapshotA(): Promise<string> {
  const scope = await dal().requireMembership(h.a.user.userId, h.budgetA.id);
  return JSON.stringify({
    budget: await dal().budgets.getBudget(scope),
    categories: await dal().categories.listCategories(scope),
    tx: await dal().transactions.getTransaction(scope, h.txA),
    plan: await dal().plans.getMonthPlan(scope, "2026-11"),
  });
}

beforeEach(async () => {
  const a = await persona("alpha");
  const b = await persona("bravo");
  const budgetA = await createBudget(a.user, {
    name: SECRET.budget,
    categories: [
      { name: SECRET.category, kind: "expense", plannedCents: 150_000 },
      { name: "Groceries", kind: "expense", plannedCents: 40_000 },
    ],
  });
  const budgetB = await createBudget(b.user, { name: "Bravo household" });
  const catA = budgetA.categories[SECRET.category]!;
  const txA = (
    await createTransaction(budgetA.scope, {
      date: "2026-11-10",
      amountCents: 150_000,
      categoryId: catA,
      payee: SECRET.payee,
      memo: SECRET.memo,
    })
  ).id;
  for (let i = 0; i < 3; i++)
    await createTransaction(budgetA.scope, {
      date: `2026-11-0${i + 1}`,
      categoryId: catA,
      amountCents: 100 + i,
    });
  const { invitation } = await dal().invitations.createBudgetInvitation(
    budgetA.scope,
    "pending-alpha@example.test",
  );
  h = {
    a,
    b,
    budgetA,
    budgetB,
    txA,
    catA,
    invitationA: invitation.id,
    catB: budgetB.categories.Groceries!,
    seen: [],
  };
});

function record<T extends ApiResponse>(res: T): T {
  h.seen.push(res);
  return res;
}

function expectNoLeak(): void {
  for (const res of h.seen)
    for (const s of Object.values(SECRET))
      expect(
        res.text.includes(s),
        `${res.describe} leaked household A text`,
      ).toBe(false);
}

describe("household B cannot reach household A", () => {
  it("A's sub-resource IDs under B's budget path are 404 NOT_FOUND, and A is unchanged", async () => {
    const before = await snapshotA();
    const bb = `/budgets/${h.budgetB.id}`;
    const c = h.b.client;
    const attempts = [
      () => c.get(`${bb}/transactions/${h.txA}`),
      () =>
        c.put(`${bb}/transactions/${h.txA}`, {
          date: "2026-11-10",
          direction: "outflow",
          amountCents: 1,
          payee: null,
          memo: null,
          splits: [{ categoryId: h.catB, amountCents: 1 }],
          version: 1,
        }),
      () => c.delete(`${bb}/transactions/${h.txA}`, { query: { version: 1 } }),
      () =>
        c.patch(`${bb}/categories/${h.catA}`, {
          name: "Taken over",
          version: 1,
        }),
      () => c.delete(`${bb}/categories/${h.catA}`, { query: { version: 1 } }),
      () =>
        c.put(`${bb}/months/2026-11/plan/${h.catA}`, {
          amountCents: 1,
          version: 1,
        }),
      () => c.delete(`${bb}/invitations/${h.invitationA}`),
      () => c.delete(`${bb}/members/${h.a.user.userId}`),
      () => c.post(`${bb}/transfer-ownership`, { userId: h.a.user.userId }),
    ];
    for (const attempt of attempts) {
      const res = record(await attempt());
      expect([res.status, codeOf(res)], res.describe).toEqual([
        404,
        "NOT_FOUND",
      ]);
    }
    expect(await snapshotA()).toBe(before);
    expectNoLeak();
  });

  it("A's budget ID in B's hands is 404 on every read", async () => {
    const ba = `/budgets/${h.budgetA.id}`;
    for (const path of [
      ba,
      `${ba}/members`,
      `${ba}/categories`,
      `${ba}/months/2026-11/plan`,
      `${ba}/months/2026-11/summary`,
      `${ba}/transactions`,
      `${ba}/transactions/${h.txA}`,
    ]) {
      const res = record(await h.b.client.get(path));
      expect([res.status, codeOf(res)], res.describe).toEqual([
        404,
        "NOT_FOUND",
      ]);
    }
    expectNoLeak();
  });

  it("a split categoryId from A is 400 VALIDATION_FAILED (splits.0.categoryId, invalid_value), checked before any write", async () => {
    const res = record(
      await h.b.client.post(
        `/budgets/${h.budgetB.id}/transactions`,
        {
          date: "2026-11-10",
          direction: "outflow",
          amountCents: 500,
          splits: [{ categoryId: h.catA, amountCents: 500 }],
        },
        { idempotencyKey: randomUUID() },
      ),
    );
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({
        in: "body",
        field: "splits.0.categoryId",
        issue: "invalid_value",
      }),
    );
    const list = await h.b.client.get<{ items: unknown[] }>(
      `/budgets/${h.budgetB.id}/transactions`,
    );
    expect(list.body.items).toEqual([]);
    expectNoLeak();
  });

  it("filtering B's transactions by A's categoryId returns an empty page", async () => {
    await createTransaction(h.budgetB.scope, {
      date: "2026-11-10",
      categoryId: h.catB,
      amountCents: 700,
    });
    const res = record(
      await h.b.client.get<{ items: unknown[]; nextCursor: null }>(
        `/budgets/${h.budgetB.id}/transactions`,
        {
          query: { categoryId: h.catA },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
    expectNoLeak();
  });

  it("a cursor issued for A's budget is refused on B's (400, query.cursor invalid_value)", async () => {
    const page = await h.a.client.get<{ nextCursor: string }>(
      `/budgets/${h.budgetA.id}/transactions`,
      { query: { limit: 1 } },
    );
    expect(page.body.nextCursor).toEqual(expect.any(String));
    for (let i = 0; i < 3; i++)
      await createTransaction(h.budgetB.scope, {
        date: "2026-11-10",
        categoryId: h.catB,
      });
    const res = record(
      await h.b.client.get(`/budgets/${h.budgetB.id}/transactions`, {
        query: { limit: 1, cursor: page.body.nextCursor },
      }),
    );
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({
        in: "query",
        field: "cursor",
        issue: "invalid_value",
      }),
    );
    expectNoLeak();
  });

  it("B cannot accept or decline an invitation addressed to someone else (404)", async () => {
    const { invitation } = await dal().invitations.createBudgetInvitation(
      h.budgetA.scope,
      h.a.user.email.replace("alpha", "carol"),
    );
    for (const action of ["accept", "decline"]) {
      const res = record(
        await h.b.client.post(`/me/invitations/${invitation.id}/${action}`),
      );
      expect([res.status, codeOf(res)], res.describe).toEqual([
        404,
        "NOT_FOUND",
      ]);
    }
    expectNoLeak();
  });

  it("B's summary, budget list, invitations and CSV export contain nothing of A", async () => {
    const c = h.b.client;
    record(await c.get("/budgets"));
    record(await c.get(`/budgets/${h.budgetB.id}/months/2026-11/summary`));
    record(await c.get("/me/invitations"));
    record(await c.get("/me/deleted-budgets"));
    const csv = record(await c.post("/me/export", { kind: "transactions" }));
    const plans = record(await c.post("/me/export", { kind: "plans" }));
    expect([csv.status, plans.status]).toEqual([200, 200]);
    expectNoLeak();
  });

  it("an Idempotency-Key used in A never replays A's transaction in B (422 IDEMPOTENCY_KEY_REUSED)", async () => {
    // A user who is a member of both budgets, so only the path differs.
    const both = await persona("both");
    await addMember(h.budgetA, both.user);
    await addMember(h.budgetB, both.user);
    const key = randomUUID();
    const body = {
      date: "2026-11-10",
      direction: "outflow",
      amountCents: 300,
      splits: [{ categoryId: h.catA, amountCents: 300 }],
    };
    const first = await both.client.post(
      `/budgets/${h.budgetA.id}/transactions`,
      body,
      { idempotencyKey: key },
    );
    expect(first.status).toBe(201);
    const inB = await both.client.post(
      `/budgets/${h.budgetB.id}/transactions`,
      { ...body, splits: [{ categoryId: h.catB, amountCents: 300 }] },
      { idempotencyKey: key },
    );
    expect([inB.status, codeOf(inB)]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
  });

  it("a removed member's idempotent replay is 404, not the transaction (F-18)", async () => {
    const m = await persona("leaver");
    await addMember(h.budgetA, m.user);
    const key = randomUUID();
    const body = {
      date: "2026-11-10",
      direction: "outflow",
      amountCents: 300,
      splits: [{ categoryId: h.catA, amountCents: 300 }],
    };
    expect(
      (
        await m.client.post(`/budgets/${h.budgetA.id}/transactions`, body, {
          idempotencyKey: key,
        })
      ).status,
    ).toBe(201);
    await dal().members.removeMember(h.budgetA.scope, m.user.userId);
    h.seen = [];
    const replay = record(
      await m.client.post(`/budgets/${h.budgetA.id}/transactions`, body, {
        idempotencyKey: key,
      }),
    );
    expect([replay.status, codeOf(replay)]).toEqual([404, "NOT_FOUND"]);
    expectNoLeak();
  });
});

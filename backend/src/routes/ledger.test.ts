import { DalError } from "@shoestring/db";
import type {
  CategoryRecord,
  ListTransactionsOptions,
  TransactionRecord,
} from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { T0, makeHarness } from "../test-support/harness.ts";
import type { DalOverrides, Harness } from "../test-support/harness.ts";

const U = "01a1d7ab-0000-7000-8000-00000000000a";
const B = "01a1d7ab-0000-7000-8000-0000000000b1";
const B2 = "01a1d7ab-0000-7000-8000-0000000000b2";
const C1 = "01a1d7ab-0000-7000-8000-0000000000c1";
const T1 = "01a1d7ab-0000-7000-8000-0000000000d1";

let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & {
    code?: string;
    details?: unknown[];
  };

const tx = (
  id = T1,
  extra: Partial<TransactionRecord> = {},
): TransactionRecord => ({
  id,
  budgetId: B,
  date: "2026-11-13",
  direction: "outflow",
  amountCents: 1234,
  payee: null,
  memo: null,
  splits: [{ categoryId: C1, amountCents: 1234 }],
  createdByUserId: U,
  updatedByUserId: U,
  createdAt: T0,
  updatedAt: T0,
  version: 1,
  ...extra,
});

function harness(dal: DalOverrides = {}, timezone = "America/Los_Angeles") {
  return makeHarness({
    dal: {
      requireMembership: ((userId: string, budgetId: string) =>
        budgetId === B || budgetId === B2
          ? Promise.resolve({ budgetId, userId, role: "member" })
          : Promise.reject(new DalError("NOT_FOUND"))) as never,
      ...dal,
      budgets: {
        getBudget: () =>
          Promise.resolve({
            id: B,
            name: "Home",
            timezone,
            currency: "USD",
            myRole: "member",
            memberCount: 1,
            today: "2026-11-13",
            currentMonth: "2026-11",
            createdAt: T0,
            updatedAt: T0,
            version: 1,
          }),
        ...(dal.budgets ?? {}),
      },
    },
  });
}

describe("transactions", () => {
  const body = {
    date: "2026-11-13",
    direction: "outflow",
    amountCents: 1234,
    payee: "  Corner  Shop ",
    memo: "  ",
    splits: [{ categoryId: C1, amountCents: 1234 }],
  };

  it("creates with trimmed text (empty memo becomes null) and the Idempotency-Key", async () => {
    const seen: unknown[] = [];
    h = await harness({
      transactions: {
        createTransaction: (
          _s: unknown,
          input: unknown,
          o: { idempotency: { key: string } },
        ) => {
          seen.push([input, o.idempotency.key]);
          return Promise.resolve({ replayed: false, value: tx() });
        },
      },
    });
    const s = h.sessions.add({ userId: U });
    const key = crypto.randomUUID();
    const r = await h.req("POST", `/api/budgets/${B}/transactions`, {
      auth: s,
      body,
      headers: { "idempotency-key": key },
    });
    expect(r.statusCode).toBe(201);
    expect(seen).toEqual([
      [expect.objectContaining({ payee: "Corner  Shop", memo: null }), key],
    ]);
  });

  it("dates run from 2000-01-01 to one year after today in the budget timezone", async () => {
    h = await harness({
      transactions: {
        createTransaction: () =>
          Promise.resolve({ replayed: false, value: tx() }),
      },
    });
    const s = h.sessions.add({ userId: U });
    const post = (date: string) =>
      h.req("POST", `/api/budgets/${B}/transactions`, {
        auth: s,
        body: { ...body, date },
        headers: { "idempotency-key": crypto.randomUUID() },
      });
    expect((await post("2000-01-01")).statusCode).toBe(201);
    expect(json(await post("1999-12-31")).details).toEqual([
      expect.objectContaining({ field: "date", issue: "too_small" }),
    ]);
    // T0 is 2026-11-13 07:00 in Los Angeles.
    expect((await post("2027-11-13")).statusCode).toBe(201);
    expect(json(await post("2027-11-14")).details).toEqual([
      expect.objectContaining({ field: "date", issue: "too_big" }),
    ]);
    expect(json(await post("2026-02-30")).details).toEqual([
      expect.objectContaining({ field: "date", issue: "invalid_format" }),
    ]);
  });

  it("rejects bad splits at the schema (count, zero amounts) and maps the DAL's sum/category errors", async () => {
    h = await harness({
      transactions: {
        createTransaction: (_s: unknown, input: { amountCents: number }) =>
          Promise.reject(
            input.amountCents === 999
              ? new DalError("SPLITS_DO_NOT_SUM", {
                  details: [
                    { in: "body", field: "splits", issue: "sum_mismatch" },
                  ],
                })
              : new DalError("VALIDATION_FAILED", {
                  details: [
                    {
                      in: "body",
                      field: "splits.0.categoryId",
                      issue: "invalid_value",
                    },
                  ],
                }),
          ),
      },
    });
    const s = h.sessions.add({ userId: U });
    const post = (b: unknown) =>
      h.req("POST", `/api/budgets/${B}/transactions`, {
        auth: s,
        body: b,
        headers: { "idempotency-key": crypto.randomUUID() },
      });
    expect(json(await post({ ...body, splits: [] })).details).toEqual([
      expect.objectContaining({ field: "splits", issue: "too_short" }),
    ]);
    const many = Array.from({ length: 21 }, () => ({
      categoryId: C1,
      amountCents: 1,
    }));
    expect(json(await post({ ...body, splits: many })).details).toEqual([
      expect.objectContaining({ field: "splits", issue: "too_long" }),
    ]);
    expect(json(await post({ ...body, amountCents: 0 })).details).toEqual([
      expect.objectContaining({ field: "amountCents", issue: "too_small" }),
    ]);
    expect(
      json(await post({ ...body, amountCents: 100_000_001 })).details,
    ).toEqual([
      expect.objectContaining({ field: "amountCents", issue: "too_big" }),
    ]);
    expect(json(await post({ ...body, amountCents: 12.5 })).details).toEqual([
      expect.objectContaining({ field: "amountCents" }),
    ]);
    const sum = await post({ ...body, amountCents: 999 });
    expect([sum.statusCode, json(sum).code]).toEqual([
      422,
      "SPLITS_DO_NOT_SUM",
    ]);
    const foreign = await post(body);
    expect(json(foreign)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ field: "splits.0.categoryId", issue: "invalid_value" }],
    });
  });

  it("F-07: a COMMIT-time 23503 on the split category FK is 500 INTERNAL and logs only allowlisted fields", async () => {
    const pgError = Object.assign(
      new Error(
        'insert or update on table "transaction_splits" violates foreign key constraint "transaction_splits_category_fkey"',
      ),
      {
        name: "error",
        code: "23503",
        constraint: "transaction_splits_category_fkey",
        table: "transaction_splits",
        detail:
          "Key (budget_id, category_id)=(x, y) is not present. payee=Corner Shop amount=1234",
        where: "SQL statement COMMIT",
      },
    );
    h = await harness({
      transactions: { createTransaction: () => Promise.reject(pgError) },
    });
    const s = h.sessions.add({ userId: U });
    const r = await h.req("POST", `/api/budgets/${B}/transactions`, {
      auth: s,
      body,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(r.statusCode).toBe(500);
    expect(json(r)).toEqual({
      code: "INTERNAL",
      message: "Something went wrong.",
      requestId: expect.any(String) as unknown,
    });
    const line = h.logs.find((l) => l.msg === "request failed")!;
    expect(line.err).toMatchObject({
      code: "23503",
      constraint: "transaction_splits_category_fkey",
      table: "transaction_splits",
    });
    const logged = JSON.stringify(h.logs);
    for (const leak of ["Corner", "1234", "Key (", "violates", "COMMIT"])
      expect(logged).not.toContain(leak);
    expect(r.body).not.toContain("transaction_splits");
  });

  it("replays carry Idempotent-Replayed: true; a deleted transaction replays as 404", async () => {
    let n = 0;
    h = await harness({
      transactions: {
        createTransaction: () =>
          ++n === 1
            ? Promise.resolve({ replayed: true, value: tx() })
            : Promise.reject(new DalError("NOT_FOUND")),
      },
    });
    const s = h.sessions.add({ userId: U });
    const r = await h.req("POST", `/api/budgets/${B}/transactions`, {
      auth: s,
      body,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(r.headers["idempotent-replayed"]).toBe("true");
    const gone = await h.req("POST", `/api/budgets/${B}/transactions`, {
      auth: s,
      body,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("paginates with a MAC'd cursor bound to the budget and the filters", async () => {
    const calls: ListTransactionsOptions[] = [];
    h = await harness({
      transactions: {
        listTransactions: (_s: unknown, o: ListTransactionsOptions) => {
          calls.push(o);
          return Promise.resolve(
            o.after
              ? {
                  items: [tx("01a1d7ab-0000-7000-8000-0000000000d0")],
                  next: null,
                }
              : { items: [tx()], next: { date: "2026-11-13", id: T1 } },
          );
        },
      },
    });
    const s = h.sessions.add({ userId: U });
    const first = json(
      await h.req(
        "GET",
        `/api/budgets/${B}/transactions?limit=1&month=2026-11`,
        { auth: s },
      ),
    );
    const cursor = first.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(calls[0]).toMatchObject({ limit: 1, month: "2026-11" });
    const second = await h.req(
      "GET",
      `/api/budgets/${B}/transactions?limit=1&month=2026-11&cursor=${cursor}`,
      { auth: s },
    );
    expect(json(second).nextCursor).toBeNull();
    expect(calls[1]!.after).toEqual({ date: "2026-11-13", id: T1 });

    const invalid = (url: string) =>
      h.req("GET", url, { auth: s }).then((r) => json(r).details);
    const expected = [
      expect.objectContaining({
        in: "query",
        field: "cursor",
        issue: "invalid_value",
      }),
    ];
    expect(
      await invalid(`/api/budgets/${B}/transactions?cursor=${cursor}`),
    ).toEqual(expected); // other filters
    expect(
      await invalid(
        `/api/budgets/${B2}/transactions?month=2026-11&cursor=${cursor}`,
      ),
    ).toEqual(expected); // other budget
    const flipped = cursor.slice(0, -2) + (cursor.endsWith("AA") ? "BB" : "AA");
    expect(
      await invalid(
        `/api/budgets/${B}/transactions?month=2026-11&cursor=${flipped}`,
      ),
    ).toEqual(expected); // tampered
    expect(
      await invalid(`/api/budgets/${B}/transactions?month=2026-11&cursor=abc`),
    ).toEqual(expected); // garbage
    expect(calls).toHaveLength(2);
  });

  it("validates list query parameters", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const d = (q: string) =>
      h
        .req("GET", `/api/budgets/${B}/transactions?${q}`, { auth: s })
        .then((r) => json(r).details);
    expect(await d("limit=0")).toEqual([
      expect.objectContaining({ field: "limit", issue: "too_small" }),
    ]);
    expect(await d("limit=101")).toEqual([
      expect.objectContaining({ field: "limit", issue: "too_big" }),
    ]);
    expect(await d("month=2026-13")).toEqual([
      expect.objectContaining({ field: "month", issue: "invalid_format" }),
    ]);
    expect(await d("month=1999-12")).toEqual([
      expect.objectContaining({ field: "month", issue: "too_small" }),
    ]);
    expect(await d("categoryId=x")).toEqual([
      expect.objectContaining({ field: "categoryId", issue: "invalid_format" }),
    ]);
  });

  it("replace and delete map VERSION_CONFLICT and NOT_FOUND", async () => {
    h = await harness({
      transactions: {
        replaceTransaction: () =>
          Promise.reject(
            new DalError("VERSION_CONFLICT", {
              details: [
                { in: "body", field: "version", issue: "invalid_value" },
              ],
            }),
          ),
        deleteTransaction: () => Promise.reject(new DalError("NOT_FOUND")),
      },
    });
    const s = h.sessions.add({ userId: U });
    const put = await h.req("PUT", `/api/budgets/${B}/transactions/${T1}`, {
      auth: s,
      body: { ...body, payee: null, memo: null, version: 1 },
    });
    expect([put.statusCode, json(put).code]).toEqual([409, "VERSION_CONFLICT"]);
    const missing = await h.req("PUT", `/api/budgets/${B}/transactions/${T1}`, {
      auth: s,
      body: { date: body.date, direction: body.direction, amountCents: body.amountCents, splits: body.splits, version: 1 },
    });
    expect(json(missing).details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "payee", issue: "required" }),
      ]),
    );
    expect(
      (
        await h.req(
          "DELETE",
          `/api/budgets/${B}/transactions/${T1}?version=1`,
          { auth: s },
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("categories, plans and summary", () => {
  const cat = (id: string, archived: boolean): CategoryRecord => ({
    id,
    budgetId: B,
    name: id.slice(-2),
    kind: "expense",
    sortOrder: 0,
    archived,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  });

  it("lists non-archived categories unless includeArchived=true", async () => {
    h = await harness({
      categories: {
        listCategories: () =>
          Promise.resolve([
            cat(C1, false),
            cat("01a1d7ab-0000-7000-8000-0000000000c2", true),
          ]),
      },
    });
    const s = h.sessions.add({ userId: U });
    expect(
      (
        json(await h.req("GET", `/api/budgets/${B}/categories`, { auth: s }))
          .items as unknown[]
      ).length,
    ).toBe(1);
    expect(
      (
        json(
          await h.req(
            "GET",
            `/api/budgets/${B}/categories?includeArchived=true`,
            { auth: s },
          ),
        ).items as unknown[]
      ).length,
    ).toBe(2);
    expect(
      json(
        await h.req("GET", `/api/budgets/${B}/categories?includeArchived=yes`, {
          auth: s,
        }),
      ).code,
    ).toBe("VALIDATION_FAILED");
  });

  it("category names: trimmed, NFC, 1-40 code points, no control characters", async () => {
    const created: unknown[] = [];
    h = await harness({
      categories: {
        createCategory: (_s: unknown, i: { name: string }) => {
          created.push(i.name);
          return Promise.resolve(cat(C1, false));
        },
      },
    });
    const s = h.sessions.add({ userId: U });
    const post = (name: string) =>
      h.req("POST", `/api/budgets/${B}/categories`, {
        auth: s,
        body: { name, kind: "expense" },
      });
    expect((await post("  Food  ")).statusCode).toBe(201);
    expect(json(await post("   ")).details).toEqual([
      expect.objectContaining({ field: "name", issue: "too_short" }),
    ]);
    expect(json(await post("x".repeat(41))).details).toEqual([
      expect.objectContaining({ field: "name", issue: "too_long" }),
    ]);
    expect((await post("\u{1F96C}".repeat(40))).statusCode).toBe(201);
    expect(json(await post("Fo\u0000od")).details).toEqual([
      expect.objectContaining({ field: "name", issue: "invalid_value" }),
    ]);
    expect(
      json(
        await h.req("POST", `/api/budgets/${B}/categories`, {
          auth: s,
          body: { name: "x", kind: "savings" },
        }),
      ).details,
    ).toEqual([
      expect.objectContaining({ field: "kind", issue: "invalid_value" }),
    ]);
    expect(created[0]).toBe("Food");
  });

  it("PUT plan entry: 201 for version null (create), 200 for a version (replace)", async () => {
    const entry = {
      categoryId: C1,
      month: "2026-11",
      amountCents: 5000,
      updatedAt: T0,
      updatedByUserId: U,
      version: 1,
    };
    h = await harness({
      plans: { putPlanEntry: () => Promise.resolve(entry) },
    });
    const s = h.sessions.add({ userId: U });
    const url = `/api/budgets/${B}/months/2026-11/plan/${C1}`;
    expect(
      (
        await h.req("PUT", url, {
          auth: s,
          body: { amountCents: 5000, version: null },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await h.req("PUT", url, {
          auth: s,
          body: { amountCents: 5000, version: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      json(await h.req("PUT", url, { auth: s, body: { amountCents: 5000 } }))
        .details,
    ).toEqual([
      expect.objectContaining({ field: "version", issue: "required" }),
    ]);
    expect(
      json(
        await h.req("PUT", url, {
          auth: s,
          body: { amountCents: -1, version: null },
        }),
      ).details,
    ).toEqual([
      expect.objectContaining({ field: "amountCents", issue: "too_small" }),
    ]);
  });

  it("copy-previous passes overwrite (default false)", async () => {
    const seen: unknown[] = [];
    h = await harness({
      plans: {
        copyPreviousMonthPlan: (_s: unknown, month: string, o: unknown) => {
          seen.push([month, o]);
          return Promise.resolve({
            budgetId: B,
            month,
            sourceMonth: "2026-10",
            copiedCount: 0,
            skippedCount: 0,
            items: [],
          });
        },
      },
    });
    const s = h.sessions.add({ userId: U });
    await h.req("POST", `/api/budgets/${B}/months/2026-11/plan/copy-previous`, {
      auth: s,
      body: {},
    });
    await h.req("POST", `/api/budgets/${B}/months/2026-11/plan/copy-previous`, {
      auth: s,
      body: { overwrite: true },
    });
    expect(seen).toEqual([
      ["2026-11", { overwrite: false }],
      ["2026-11", { overwrite: true }],
    ]);
  });

  it("summary: the API shape is exactly the DAL's math, no client-visible extras", async () => {
    h = await harness({
      summary: {
        getMonthSummary: () =>
          Promise.resolve({
            budgetId: B,
            month: "2026-11",
            categories: [
              {
                categoryId: C1,
                name: "Food",
                kind: "expense",
                archived: false,
                plannedCents: 1000,
                actualCents: 1500,
                remainingCents: -500,
              },
            ],
            totals: {
              expense: {
                plannedCents: 1000,
                actualCents: 1500,
                remainingCents: -500,
              },
              income: { plannedCents: 0, actualCents: 0, remainingCents: 0 },
            },
            transactionCount: 2,
          }),
      },
    });
    const r = await h.req("GET", `/api/budgets/${B}/months/2026-11/summary`, {
      auth: h.sessions.add({ userId: U }),
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({
      transactionCount: 2,
      categories: [{ remainingCents: -500 }],
    });
  });
});

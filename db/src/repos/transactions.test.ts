import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { BudgetFixture } from "../test-support/fixtures.ts";
import {
  expectDalError,
  expectPgError,
  hash32,
  newBudget,
  newUser,
} from "../test-support/fixtures.ts";
import { useTestDb } from "../test-support/harness.ts";

const t = useTestDb();
let f: BudgetFixture;
let userId: string;

beforeAll(async () => {
  ({ userId } = await newUser(t.dal));
  f = await newBudget(t.dal, userId);
});

const g = () => f.categories.Groceries ?? "";
const d = () => f.categories.Dining ?? "";

describe("createTransaction", () => {
  it("stores an ordinary transaction as one split", async () => {
    const { value, replayed } = await t.dal.transactions.createTransaction(
      f.scope,
      {
        date: "2026-11-02",
        direction: "outflow",
        amountCents: 1234,
        payee: "Corner Shop",
        splits: [{ categoryId: g(), amountCents: 1234 }],
      },
    );
    expect(replayed).toBe(false);
    expect(value).toMatchObject({
      budgetId: f.budget.id,
      amountCents: 1234,
      payee: "Corner Shop",
      memo: null,
      version: 1,
    });
    expect(value.splits).toEqual([{ categoryId: g(), amountCents: 1234 }]);
    expect(value.createdByUserId).toBe(userId);
  });

  it("orders splits by amount descending", async () => {
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-03",
      direction: "outflow",
      amountCents: 100_000_000,
      splits: [
        { categoryId: g(), amountCents: 1 },
        { categoryId: d(), amountCents: 99_999_999 },
      ],
    });
    expect(value.splits.map((s) => s.amountCents)).toEqual([99_999_999, 1]);
  });

  it("rejects splits that do not sum, duplicates, foreign and archived categories", async () => {
    const base = {
      date: "2026-11-04",
      direction: "outflow" as const,
      amountCents: 1000,
    };
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        splits: [{ categoryId: g(), amountCents: 999 }],
      }),
      "SPLITS_DO_NOT_SUM",
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        splits: [
          { categoryId: g(), amountCents: 500 },
          { categoryId: g(), amountCents: 500 },
        ],
      }),
      "VALIDATION_FAILED",
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        splits: [{ categoryId: randomUUID(), amountCents: 1000 }],
      }),
      "VALIDATION_FAILED",
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, { ...base, splits: [] }),
      "VALIDATION_FAILED",
    );
    const many = Array.from({ length: 21 }, () => ({
      categoryId: randomUUID(),
      amountCents: 1,
    }));
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        amountCents: 21,
        splits: many,
      }),
      "VALIDATION_FAILED",
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        amountCents: 0,
        splits: [{ categoryId: g(), amountCents: 0 }],
      }),
      "VALIDATION_FAILED",
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        amountCents: 100_000_001,
        splits: [{ categoryId: g(), amountCents: 100_000_001 }],
      }),
      "VALIDATION_FAILED",
    );

    const archived = await t.dal.categories.createCategory(f.scope, {
      name: "Old",
      kind: "expense",
    });
    await t.dal.categories.updateCategory(f.scope, archived.id, {
      archived: true,
      version: archived.version,
    });
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, {
        ...base,
        splits: [{ categoryId: archived.id, amountCents: 1000 }],
      }),
      "CATEGORY_ARCHIVED",
    );
  });

  it("replays an idempotent create and refuses the key for another request", async () => {
    const key = randomUUID();
    const requestHash = hash32();
    const input = {
      date: "2026-11-05",
      direction: "outflow" as const,
      amountCents: 700,
      splits: [{ categoryId: g(), amountCents: 700 }],
    };
    const first = await t.dal.transactions.createTransaction(f.scope, input, {
      idempotency: { userId, key, requestHash },
    });
    const again = await t.dal.transactions.createTransaction(f.scope, input, {
      idempotency: { userId, key, requestHash },
    });
    expect(again.replayed).toBe(true);
    expect(again.value.id).toBe(first.value.id);
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, input, {
        idempotency: { userId, key, requestHash: hash32() },
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    // A since-deleted transaction replays as NOT_FOUND (F-18).
    await t.dal.transactions.deleteTransaction(
      f.scope,
      first.value.id,
      first.value.version,
    );
    await expectDalError(
      t.dal.transactions.createTransaction(f.scope, input, {
        idempotency: { userId, key, requestHash },
      }),
      "NOT_FOUND",
    );
    // After 24 h the key is free again.
    t.clock.advance(24 * 3_600_000 + 1);
    const fresh = await t.dal.transactions.createTransaction(f.scope, input, {
      idempotency: { userId, key, requestHash },
    });
    expect(fresh.replayed).toBe(false);
  });

  it("serializes concurrent duplicates on the idempotency key", async () => {
    const key = randomUUID();
    const requestHash = hash32();
    const input = {
      date: "2026-11-06",
      direction: "outflow" as const,
      amountCents: 50,
      splits: [{ categoryId: g(), amountCents: 50 }],
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.dal.transactions.createTransaction(f.scope, input, {
          idempotency: { userId, key, requestHash },
        }),
      ),
    );
    expect(new Set(results.map((r) => r.value.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe("replaceTransaction and deleteTransaction", () => {
  it("replaces splits, bumps the version and detects conflicts", async () => {
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-07",
      direction: "outflow",
      amountCents: 3000,
      splits: [{ categoryId: g(), amountCents: 3000 }],
    });
    const updated = await t.dal.transactions.replaceTransaction(
      f.scope,
      value.id,
      {
        date: "2026-11-08",
        direction: "outflow",
        amountCents: 4000,
        payee: null,
        memo: "split now",
        splits: [
          { categoryId: g(), amountCents: 1000 },
          { categoryId: d(), amountCents: 3000 },
        ],
        version: 1,
      },
    );
    expect(updated.version).toBe(2);
    expect(updated.splits).toEqual([
      { categoryId: d(), amountCents: 3000 },
      { categoryId: g(), amountCents: 1000 },
    ]);
    await expectDalError(
      t.dal.transactions.replaceTransaction(f.scope, value.id, {
        date: "2026-11-08",
        direction: "outflow",
        amountCents: 4000,
        splits: [{ categoryId: g(), amountCents: 4000 }],
        version: 1,
      }),
      "VERSION_CONFLICT",
    );
    await expectDalError(
      t.dal.transactions.deleteTransaction(f.scope, value.id, 1),
      "VERSION_CONFLICT",
    );
    await t.dal.transactions.deleteTransaction(f.scope, value.id, 2);
    await expectDalError(
      t.dal.transactions.getTransaction(f.scope, value.id),
      "NOT_FOUND",
    );
  });

  it("keeps an archived category already on the transaction but refuses a new one", async () => {
    const cat = await t.dal.categories.createCategory(f.scope, {
      name: "Hobby",
      kind: "expense",
    });
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-09",
      direction: "outflow",
      amountCents: 500,
      splits: [{ categoryId: cat.id, amountCents: 500 }],
    });
    await t.dal.categories.updateCategory(f.scope, cat.id, {
      archived: true,
      version: cat.version,
    });
    const edited = await t.dal.transactions.replaceTransaction(
      f.scope,
      value.id,
      {
        date: "2026-11-09",
        direction: "outflow",
        amountCents: 600,
        splits: [{ categoryId: cat.id, amountCents: 600 }],
        version: value.version,
      },
    );
    expect(edited.amountCents).toBe(600);
    const other = await t.dal.categories.createCategory(f.scope, {
      name: "Hobby 2",
      kind: "expense",
    });
    await t.dal.categories.updateCategory(f.scope, other.id, {
      archived: true,
      version: other.version,
    });
    await expectDalError(
      t.dal.transactions.replaceTransaction(f.scope, value.id, {
        date: "2026-11-09",
        direction: "outflow",
        amountCents: 600,
        splits: [{ categoryId: other.id, amountCents: 600 }],
        version: edited.version,
      }),
      "CATEGORY_ARCHIVED",
    );
  });
});

describe("listTransactions", () => {
  it("pages newest first with a keyset and filters by month and category", async () => {
    const { userId: u2 } = await newUser(t.dal);
    const b = await newBudget(t.dal, u2);
    const groceries = b.categories.Groceries ?? "";
    const dining = b.categories.Dining ?? "";
    const dates = [
      "2026-10-31",
      "2026-11-01",
      "2026-11-01",
      "2026-11-15",
      "2026-11-30",
      "2026-12-01",
    ];
    for (const [i, date] of dates.entries()) {
      await t.dal.transactions.createTransaction(b.scope, {
        date,
        direction: "outflow",
        amountCents: 100 + i,
        splits: [
          {
            categoryId: i % 2 === 0 ? groceries : dining,
            amountCents: 100 + i,
          },
        ],
      });
    }
    const p1 = await t.dal.transactions.listTransactions(b.scope, { limit: 4 });
    expect(p1.items.map((x) => x.date)).toEqual([
      "2026-12-01",
      "2026-11-30",
      "2026-11-15",
      "2026-11-01",
    ]);
    expect(p1.next).not.toBeNull();
    const p2 = await t.dal.transactions.listTransactions(b.scope, {
      limit: 4,
      after: p1.next ?? undefined,
    });
    expect(p2.items.map((x) => x.date)).toEqual(["2026-11-01", "2026-10-31"]);
    expect(p2.next).toBeNull();
    // Same-date ties break by id (UUIDv7 = creation order), newest first.
    const nov1 = [...p1.items, ...p2.items]
      .filter((x) => x.date === "2026-11-01")
      .map((x) => x.id);
    expect(nov1[0]! > nov1[1]!).toBe(true);

    const nov = await t.dal.transactions.listTransactions(b.scope, {
      month: "2026-11",
    });
    expect(nov.items).toHaveLength(4);
    const byCat = await t.dal.transactions.listTransactions(b.scope, {
      categoryId: dining,
    });
    expect(
      byCat.items.every((x) => x.splits.some((s) => s.categoryId === dining)),
    ).toBe(true);
    expect(byCat.items).toHaveLength(3);
    const foreign = await t.dal.transactions.listTransactions(b.scope, {
      categoryId: g(),
    });
    expect(foreign.items).toEqual([]);
    await expectDalError(
      t.dal.transactions.listTransactions(b.scope, {
        after: { date: "not-a-date", id: randomUUID() },
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("database backstops (app role, raw SQL)", () => {
  it("rejects splits that do not sum at commit (deferred constraint trigger)", async () => {
    const c = await t.app.connect();
    try {
      await c.query("begin");
      const id = randomUUID();
      await c.query(
        "insert into transactions (id, budget_id, date, direction, amount_cents, created_at, updated_at) values ($1, $2, '2026-11-10', 'outflow', 1000, now(), now())",
        [id, f.budget.id],
      );
      await c.query(
        "insert into transaction_splits (id, budget_id, transaction_id, category_id, amount_cents, created_at) values ($1, $2, $3, $4, 999, now())",
        [randomUUID(), f.budget.id, id, g()],
      );
      await expectPgError(c.query("commit"), "23514");
    } finally {
      c.release();
    }
  });

  it("rejects a transaction without splits and an amount change that breaks the sum", async () => {
    await expectPgError(
      t.app.query(
        "insert into transactions (id, budget_id, date, direction, amount_cents, created_at, updated_at) values ($1, $2, '2026-11-10', 'outflow', 1000, now(), now())",
        [randomUUID(), f.budget.id],
      ),
      "23514",
    );
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-11",
      direction: "outflow",
      amountCents: 10,
      splits: [{ categoryId: g(), amountCents: 10 }],
    });
    await expectPgError(
      t.app.query("update transactions set amount_cents = 11 where id = $1", [
        value.id,
      ]),
      "23514",
    );
    await expectPgError(
      t.app.query("delete from transaction_splits where transaction_id = $1", [
        value.id,
      ]),
      "23514",
    );
  });

  it("rejects a split pointing at another budget's category (composite FK)", async () => {
    const { userId: other } = await newUser(t.dal);
    const ob = await newBudget(t.dal, other);
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-12",
      direction: "outflow",
      amountCents: 10,
      splits: [{ categoryId: g(), amountCents: 10 }],
    });
    await expectPgError(
      t.app.query(
        "update transaction_splits set category_id = $1 where transaction_id = $2",
        [ob.categories.Groceries, value.id],
      ),
      "23503",
    );
  });

  it("enforces money ranges, dates, text rules and version increments", async () => {
    const { value } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-12",
      direction: "outflow",
      amountCents: 10,
      splits: [{ categoryId: g(), amountCents: 10 }],
    });
    await expectPgError(
      t.app.query("update transactions set date = '1999-12-31' where id = $1", [
        value.id,
      ]),
      "23514",
    );
    await expectPgError(
      t.app.query("update transactions set payee = ' padded' where id = $1", [
        value.id,
      ]),
      "23514",
    );
    await expectPgError(
      t.app.query("update transactions set memo = $2 where id = $1", [
        value.id,
        "bell\u0007",
      ]),
      "23514",
    );
    await expectPgError(
      t.app.query("update transactions set payee = '' where id = $1", [
        value.id,
      ]),
      "23514",
    );
    await t.app.query(
      "update transactions set payee = 'ok', version = 99 where id = $1",
      [value.id],
    );
    const after = await t.dal.transactions.getTransaction(f.scope, value.id);
    expect(after.version).toBe(2);
  });
});

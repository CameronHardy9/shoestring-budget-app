import { describe, expect, it } from "vitest";
import { categories, category, transaction, uuid } from "../test/fixtures.ts";
import {
  buildTransaction,
  codePoints,
  dateBounds,
  draftFrom,
  emptyDraft,
  endSplit,
  keepKnownFirst,
  newRow,
  orderCategories,
  recentCategoryIds,
  serverErrors,
  startSplit,
  type Draft,
} from "./transaction-form.ts";

const TODAY = "2026-11-14";
const G = uuid(1);
const H = uuid(4);
const base = (patch: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(TODAY),
  ...patch,
});

describe("buildTransaction", () => {
  it("builds a one-category body with cents, trimmed text and nulls", () => {
    const r = buildTransaction(
      base({ amountText: "42.5", categoryId: G, payee: "  Shop ", memo: " " }),
      TODAY,
    );
    expect(r).toEqual({
      ok: true,
      balance: null,
      body: {
        date: TODAY,
        direction: "outflow",
        amountCents: 4250,
        payee: "Shop",
        memo: null,
        splits: [{ categoryId: G, amountCents: 4250 }],
      },
    });
  });

  it("needs an amount and a category", () => {
    const r = buildTransaction(base(), TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toMatchObject({
        amount: "Enter an amount.",
        category: "Choose a category.",
      });
  });

  it("checks the date window and text lengths in code points", () => {
    const r = buildTransaction(
      base({
        amountText: "1",
        categoryId: G,
        date: "2027-11-15",
        payee: "é".repeat(101),
        memo: "x".repeat(501),
      }),
      TODAY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.date).toMatch(/one year/);
      expect(r.errors.payee).toBeDefined();
      expect(r.errors.memo).toBeDefined();
    }
    expect(
      buildTransaction(
        base({ amountText: "1", categoryId: G, date: "1999-12-31" }),
        TODAY,
      ).ok,
    ).toBe(false);
    expect(
      buildTransaction(
        base({ amountText: "1", categoryId: G, date: "2027-11-14" }),
        TODAY,
      ).ok,
    ).toBe(true);
    expect(codePoints("👍🏽")).toBe(2);
  });

  it("builds a balanced split", () => {
    const draft = base({
      amountText: "86.40",
      split: true,
      rows: [newRow(G, "60"), newRow(H, "26.40")],
    });
    const r = buildTransaction(draft, TODAY);
    expect(r.ok && r.body.splits).toEqual([
      { categoryId: G, amountCents: 6000 },
      { categoryId: H, amountCents: 2640 },
    ]);
    expect(r.balance).toEqual({ kind: "balanced" });
  });

  it("reports what is left to assign, too much, duplicates and missing parts", () => {
    const under = buildTransaction(
      base({
        amountText: "86.40",
        split: true,
        rows: [newRow(G, "60"), newRow(H, "20")],
      }),
      TODAY,
    );
    expect(under.balance).toEqual({ kind: "under", leftCents: 640 });
    expect(!under.ok && under.errors.split).toMatch(/Assign the rest/);
    const over = buildTransaction(
      base({
        amountText: "10",
        split: true,
        rows: [newRow(G, "6"), newRow(H, "6")],
      }),
      TODAY,
    );
    expect(!over.ok && over.errors.split).toMatch(/more than the total/);
    const dup = buildTransaction(
      base({
        amountText: "10",
        split: true,
        rows: [newRow(G, "5"), newRow(G, "5")],
      }),
      TODAY,
    );
    expect(!dup.ok && dup.errors.rows[1]?.category).toMatch(/already/);
    const missing = buildTransaction(
      base({
        amountText: "10",
        split: true,
        rows: [newRow("", ""), newRow(H, "10")],
      }),
      TODAY,
    );
    expect(!missing.ok && missing.errors.rows[0]).toEqual({
      category: "Choose a category.",
      amount: "Enter an amount.",
    });
    const single = buildTransaction(
      base({ amountText: "10", split: true, rows: [newRow(G, "10")] }),
      TODAY,
    );
    expect(!single.ok && single.errors.split).toMatch(/at least two/);
    const many = buildTransaction(
      base({
        amountText: "21",
        split: true,
        rows: Array.from({ length: 21 }, (_, i) => newRow(uuid(200 + i), "1")),
      }),
      TODAY,
    );
    expect(!many.ok && many.errors.split).toMatch(/at most 20/);
  });
});

describe("split mode", () => {
  it("starts with the chosen category holding the amount, and ends keeping the first", () => {
    const on = startSplit(base({ amountText: "12", categoryId: G }));
    expect(on.rows.map((r) => [r.categoryId, r.text])).toEqual([
      [G, "12"],
      ["", ""],
    ]);
    expect(endSplit({ ...on, rows: [newRow(H, "12")] })).toMatchObject({
      split: false,
      categoryId: H,
      rows: [],
    });
    expect(endSplit({ ...on, rows: [] })).toMatchObject({ categoryId: G });
  });

  it("loads an existing transaction for editing", () => {
    expect(draftFrom(transaction(1, { payee: "Shop" }))).toMatchObject({
      amountText: "12.50",
      categoryId: G,
      payee: "Shop",
      split: false,
    });
    const split = draftFrom(
      transaction(2, {
        amountCents: 8640,
        splits: [
          { categoryId: G, amountCents: 6000 },
          { categoryId: H, amountCents: 2640 },
        ],
      }),
    );
    expect(split.split).toBe(true);
    expect(split.rows.map((r) => r.text)).toEqual(["60.00", "26.40"]);
  });
});

describe("serverErrors", () => {
  const fe = (
    field: string,
    issue:
      "too_big" | "invalid_value" | "archived" | "sum_mismatch" | "required",
    where: "body" | "header" = "body",
  ) => ({
    in: where,
    field,
    issue,
    message: "x",
  });

  it("maps single-category details onto amount and category", () => {
    const r = serverErrors(
      [fe("amountCents", "too_big"), fe("splits.0.categoryId", "archived")],
      base({ categoryId: G }),
    );
    expect(r.errors).toMatchObject({
      amount: "This is too large.",
      category: "This category is archived.",
    });
  });

  it("maps split rows and sends the rest to the form", () => {
    const draft = base({ split: true, rows: [newRow(G, "1"), newRow(H, "1")] });
    const r = serverErrors(
      [
        fe("splits.1.categoryId", "invalid_value"),
        fe("splits.0.amountCents", "too_big"),
        fe("splits", "sum_mismatch"),
        fe("Idempotency-Key", "required", "header"),
      ],
      draft,
    );
    expect(r.errors.rows).toEqual({
      0: { amount: "This is too large." },
      1: { category: "This value isn't allowed." },
    });
    expect(r.errors.split).toBe("The splits must add up to the total.");
    expect(r.form).toEqual(["Required."]);
  });

  it("maps date, payee and memo", () => {
    const r = serverErrors(
      [
        fe("date", "too_big"),
        fe("payee", "invalid_value"),
        fe("memo", "too_big"),
        fe("splits.0.amountCents", "too_big"),
      ],
      base(),
    );
    expect(r.errors).toMatchObject({
      date: "This is too large.",
      payee: "This value isn't allowed.",
      memo: "This is too large.",
      amount: "This is too large.",
    });
  });
});

describe("category order", () => {
  it("puts recent first, then the direction's kind, and hides archived", () => {
    const recent = recentCategoryIds([
      transaction(1, { splits: [{ categoryId: uuid(3), amountCents: 1 }] }),
      transaction(2, {
        splits: [
          { categoryId: uuid(3), amountCents: 1 },
          { categoryId: uuid(2), amountCents: 1 },
        ],
      }),
    ]);
    expect(recent).toEqual([uuid(3), uuid(2)]);
    const out = orderCategories(categories, recent, "outflow").map(
      (c) => c.name,
    );
    expect(out).toEqual([
      "Transport",
      "Dining out",
      "Groceries",
      "Household",
      "Salary",
    ]);
    expect(orderCategories(categories, [], "inflow")[0]?.name).toBe("Salary");
    expect(
      orderCategories(categories, [], "outflow", [uuid(5)]).map((c) => c.name),
    ).toContain("Old stuff");
  });

  it("keeps a frozen order: known categories stay put, new ones go last, removed ones drop out", () => {
    const known = new Set([uuid(1), uuid(2), uuid(3), uuid(4), uuid(8)]);
    const now = orderCategories(
      [category(9, "Pets"), ...categories.filter((c) => c.id !== uuid(2))],
      [],
      "outflow",
    );
    expect(keepKnownFirst(now, known).map((c) => c.name)).toEqual([
      "Groceries",
      "Transport",
      "Household",
      "Salary",
      "Pets",
    ]);
  });

  it("allows dates up to a year ahead, leap day included", () => {
    expect(dateBounds("2028-02-29")).toEqual({
      min: "2000-01-01",
      max: "2029-02-28",
    });
    expect(dateBounds("2026-11-14").max).toBe("2027-11-14");
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  budgetCalendar,
  dateInTimeZone,
  isCalendarDate,
  isMonth,
  monthRange,
} from "../dates.ts";
import { summarize } from "../summary-math.ts";
import type { BudgetFixture } from "../test-support/fixtures.ts";
import {
  expectDalError,
  newBudget,
  newUser,
} from "../test-support/fixtures.ts";
import { useTestDb } from "../test-support/harness.ts";

const t = useTestDb();

describe("summarize (ADR-0004 formulas)", () => {
  it("nets refunds in expense categories and outflows in income categories", () => {
    const { categories, totals } = summarize([
      {
        categoryId: "a",
        name: "Groceries",
        kind: "expense",
        archived: false,
        plannedCents: 10_000,
        outCents: 12_000,
        inCents: 500,
      },
      {
        categoryId: "b",
        name: "Returns",
        kind: "expense",
        archived: false,
        plannedCents: 0,
        outCents: 1_000,
        inCents: 3_000,
      },
      {
        categoryId: "c",
        name: "Salary",
        kind: "income",
        archived: false,
        plannedCents: 400_000,
        outCents: 2_000,
        inCents: 350_000,
      },
    ]);
    expect(categories.map((c) => [c.actualCents, c.remainingCents])).toEqual([
      [11_500, -1_500], // overspent
      [-2_000, 2_000], // refund exceeding spend: negative spent
      [348_000, 52_000], // received net of outflows; still expected
    ]);
    expect(totals).toEqual({
      expense: {
        plannedCents: 10_000,
        actualCents: 9_500,
        remainingCents: 500,
      },
      income: {
        plannedCents: 400_000,
        actualCents: 348_000,
        remainingCents: 52_000,
      },
    });
  });

  it("returns zero totals for no categories", () => {
    expect(summarize([]).totals.expense).toEqual({
      plannedCents: 0,
      actualCents: 0,
      remainingCents: 0,
    });
  });
});

describe("dates (ADR-0005)", () => {
  it("computes today in the budget timezone, not UTC", () => {
    // 23:30 in Los Angeles on Oct 31 is already Nov 1 in UTC.
    expect(
      budgetCalendar(new Date("2026-11-01T06:30:00Z"), "America/Los_Angeles"),
    ).toEqual({ today: "2026-10-31", currentMonth: "2026-10" });
    // New Year's Eve: 23:59 in New York is next year in UTC.
    expect(
      budgetCalendar(new Date("2027-01-01T04:59:00Z"), "America/New_York"),
    ).toEqual({ today: "2026-12-31", currentMonth: "2026-12" });
    expect(
      dateInTimeZone(new Date("2027-01-01T05:00:00Z"), "America/New_York"),
    ).toBe("2027-01-01");
  });

  it("is stable across DST changes (fall back and spring forward)", () => {
    // 2026-11-01 01:30 happens twice in New York (EDT then EST).
    expect(
      dateInTimeZone(new Date("2026-11-01T05:30:00Z"), "America/New_York"),
    ).toBe("2026-11-01");
    expect(
      dateInTimeZone(new Date("2026-11-01T06:30:00Z"), "America/New_York"),
    ).toBe("2026-11-01");
    expect(
      dateInTimeZone(new Date("2026-11-02T04:59:00Z"), "America/New_York"),
    ).toBe("2026-11-01");
    // 2027-03-14 02:00 is skipped in New York.
    expect(
      dateInTimeZone(new Date("2027-03-14T06:59:00Z"), "America/New_York"),
    ).toBe("2027-03-14");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-03-13", 1)).toBe("2027-03-14");
  });

  it("does month arithmetic across year boundaries", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-03", -15)).toBe("2024-12");
    expect(monthRange("2026-12")).toEqual({
      from: "2026-12-01",
      to: "2027-01-01",
    });
    expect(monthRange("2027-02")).toEqual({
      from: "2027-02-01",
      to: "2027-03-01",
    });
  });

  it("validates months and dates", () => {
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("1999-12")).toBe(false);
    expect(isMonth("2026-01")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-1-01")).toBe(false);
  });
});

describe("getMonthSummary", () => {
  let f: BudgetFixture;
  beforeAll(async () => {
    const { userId } = await newUser(t.dal);
    f = await newBudget(t.dal, userId, [
      { name: "Groceries", kind: "expense", plannedCents: 50_000 },
      { name: "Dining", kind: "expense" },
      { name: "Salary", kind: "income", plannedCents: 400_000 },
      { name: "Gifts", kind: "income" },
    ]);
  });
  const c = (name: string) => f.categories[name] ?? "";

  it("uses calendar dates for month boundaries, including year rollover", async () => {
    const add = (
      date: string,
      direction: "outflow" | "inflow",
      amount: number,
      splits: [string, number][],
    ) =>
      t.dal.transactions.createTransaction(f.scope, {
        date,
        direction,
        amountCents: amount,
        splits: splits.map(([name, cents]) => ({
          categoryId: c(name),
          amountCents: cents,
        })),
      });
    await add("2026-11-30", "outflow", 1_000, [["Groceries", 1_000]]); // last day of November
    await add("2026-12-01", "outflow", 2_000, [["Groceries", 2_000]]);
    await add("2026-12-31", "outflow", 3_000, [
      ["Groceries", 1_000],
      ["Dining", 2_000],
    ]);
    await add("2027-01-01", "outflow", 4_000, [["Dining", 4_000]]); // New Year's Day
    await add("2026-12-15", "inflow", 500, [["Groceries", 500]]); // refund
    await add("2026-12-20", "inflow", 410_000, [
      ["Salary", 400_000],
      ["Gifts", 10_000],
    ]);
    const deleted = await add("2026-12-10", "outflow", 99_999, [
      ["Dining", 99_999],
    ]);
    await t.dal.transactions.deleteTransaction(
      f.scope,
      deleted.value.id,
      deleted.value.version,
    );

    // Plan entries are per month: set December, leave January empty.
    await t.dal.plans.putPlanEntry(f.scope, "2026-12", c("Groceries"), {
      amountCents: 50_000,
      version: null,
    });
    await t.dal.plans.putPlanEntry(f.scope, "2026-12", c("Salary"), {
      amountCents: 400_000,
      version: null,
    });

    const dec = await t.dal.summary.getMonthSummary(f.scope, "2026-12");
    expect(dec.transactionCount).toBe(4);
    const byName = Object.fromEntries(dec.categories.map((x) => [x.name, x]));
    expect(byName.Groceries).toMatchObject({
      plannedCents: 50_000,
      actualCents: 2_500,
      remainingCents: 47_500,
    });
    expect(byName.Dining).toMatchObject({
      plannedCents: 0,
      actualCents: 2_000,
      remainingCents: -2_000,
    });
    expect(byName.Salary).toMatchObject({
      plannedCents: 400_000,
      actualCents: 400_000,
      remainingCents: 0,
    });
    expect(byName.Gifts).toMatchObject({
      plannedCents: 0,
      actualCents: 10_000,
      remainingCents: -10_000,
    });
    expect(dec.categories.map((x) => x.kind)).toEqual([
      "expense",
      "expense",
      "income",
      "income",
    ]);
    expect(dec.totals.expense).toEqual({
      plannedCents: 50_000,
      actualCents: 4_500,
      remainingCents: 45_500,
    });

    const jan = await t.dal.summary.getMonthSummary(f.scope, "2027-01");
    expect(jan.transactionCount).toBe(1);
    expect(jan.categories.find((x) => x.name === "Dining")?.actualCents).toBe(
      4_000,
    );
    expect(jan.totals.expense.plannedCents).toBe(0);
    const nov = await t.dal.summary.getMonthSummary(f.scope, "2026-11");
    expect(
      nov.categories.find((x) => x.name === "Groceries")?.actualCents,
    ).toBe(1_000);
  });

  it("lists archived categories only with a plan entry or activity in the month", async () => {
    const old = await t.dal.categories.createCategory(f.scope, {
      name: "Old hobby",
      kind: "expense",
    });
    await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-10-05",
      direction: "outflow",
      amountCents: 700,
      splits: [{ categoryId: old.id, amountCents: 700 }],
    });
    await t.dal.categories.updateCategory(f.scope, old.id, {
      archived: true,
      version: old.version,
    });
    const oct = await t.dal.summary.getMonthSummary(f.scope, "2026-10");
    expect(oct.categories.find((x) => x.categoryId === old.id)).toMatchObject({
      archived: true,
      actualCents: 700,
    });
    const dec = await t.dal.summary.getMonthSummary(f.scope, "2026-12");
    expect(dec.categories.some((x) => x.categoryId === old.id)).toBe(false);
  });

  it("rejects a malformed month", async () => {
    await expectDalError(
      t.dal.summary.getMonthSummary(f.scope, "2026-13"),
      "VALIDATION_FAILED",
    );
  });
});

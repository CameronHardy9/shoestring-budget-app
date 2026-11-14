// ADR-0004/0005 month and money rules. The summary math itself is the DAL's
// pure `summarize` (db/src/summary-math.ts); these tests pin the behaviour
// the API promises (refunds, splits across kinds, archived, signed totals).
import { budgetCalendar, summarize } from "@shoestring/db";
import type { SummaryInputRow } from "@shoestring/db";
import { describe, expect, it } from "vitest";
import {
  maxTransactionDate,
  monthOf,
  oneYearAfter,
  transactionDateIssue,
} from "./calendar.ts";

describe("budget calendar (ADR-0005)", () => {
  it("23:30 on the last day of the month in Los Angeles is still that month, although UTC is already the next", () => {
    const instant = new Date("2026-12-01T07:30:00Z"); // 2026-11-30 23:30 PST
    expect(budgetCalendar(instant, "America/Los_Angeles")).toEqual({
      today: "2026-11-30",
      currentMonth: "2026-11",
    });
    expect(budgetCalendar(instant, "UTC")).toEqual({
      today: "2026-12-01",
      currentMonth: "2026-12",
    });
  });

  it("year rollover depends on the budget timezone", () => {
    const instant = new Date("2027-01-01T03:00:00Z");
    expect(budgetCalendar(instant, "America/New_York").currentMonth).toBe(
      "2026-12",
    );
    expect(budgetCalendar(instant, "Pacific/Auckland").currentMonth).toBe(
      "2027-01",
    );
  });

  it("DST changes do not skip or repeat a date", () => {
    // US DST ends 2026-11-01 at 02:00 local: 01:30 happens twice.
    expect(
      budgetCalendar(new Date("2026-11-01T08:30:00Z"), "America/Chicago").today,
    ).toBe("2026-11-01");
    expect(
      budgetCalendar(new Date("2026-11-01T06:30:00Z"), "America/Chicago").today,
    ).toBe("2026-11-01");
    expect(
      budgetCalendar(new Date("2026-11-02T05:59:00Z"), "America/Chicago").today,
    ).toBe("2026-11-01");
    expect(
      budgetCalendar(new Date("2026-11-02T06:00:00Z"), "America/Chicago").today,
    ).toBe("2026-11-02");
  });

  it("a transaction's month is the YYYY-MM of its date, with no zone conversion", () => {
    expect(monthOf("2026-11-30")).toBe("2026-11");
    expect(monthOf("2027-01-01")).toBe("2027-01");
  });
});

describe("transaction date window (2000-01-01 .. today + 1 year, budget timezone)", () => {
  it("one year after, including leap days", () => {
    expect(oneYearAfter("2026-11-13")).toBe("2027-11-13");
    expect(oneYearAfter("2028-02-29")).toBe("2029-02-28");
    expect(oneYearAfter("2027-02-28")).toBe("2028-02-28");
    expect(oneYearAfter("2099-12-31")).toBe("2100-12-31");
  });

  it("uses the budget's today, not UTC", () => {
    const instant = new Date("2026-12-01T07:30:00Z");
    expect(maxTransactionDate(instant, "America/Los_Angeles")).toBe(
      "2027-11-30",
    );
    expect(maxTransactionDate(instant, "UTC")).toBe("2027-12-01");
    expect(
      transactionDateIssue("2027-12-01", instant, "America/Los_Angeles"),
    ).toBe("too_big");
    expect(transactionDateIssue("2027-12-01", instant, "UTC")).toBeNull();
  });

  it("bounds and format", () => {
    const now = new Date("2026-11-13T15:00:00Z");
    expect(transactionDateIssue("2000-01-01", now, "UTC")).toBeNull();
    expect(transactionDateIssue("1999-12-31", now, "UTC")).toBe("too_small");
    expect(transactionDateIssue("2026-02-29", now, "UTC")).toBe(
      "invalid_format",
    );
    expect(transactionDateIssue("2026-1-1", now, "UTC")).toBe("invalid_format");
  });
});

describe("month summary math (ADR-0004)", () => {
  const row = (r: Partial<SummaryInputRow>): SummaryInputRow => ({
    categoryId: "c",
    name: "n",
    kind: "expense",
    archived: false,
    plannedCents: 0,
    outCents: 0,
    inCents: 0,
    ...r,
  });

  it("expense: actual = out - in (a refund reduces spent), remaining = planned - actual", () => {
    const { categories } = summarize([
      row({ plannedCents: 10_000, outCents: 3_000, inCents: 500 }),
    ]);
    expect(categories[0]).toMatchObject({
      actualCents: 2_500,
      remainingCents: 7_500,
    });
  });

  it("refunds exceeding spend give negative actual and remaining above planned", () => {
    const { categories } = summarize([
      row({ plannedCents: 1_000, outCents: 200, inCents: 700 }),
    ]);
    expect(categories[0]).toMatchObject({
      actualCents: -500,
      remainingCents: 1_500,
    });
  });

  it("overspending gives negative remaining; unplanned spending counts against 0", () => {
    const { categories } = summarize([
      row({ plannedCents: 1_000, outCents: 1_250 }),
      row({ outCents: 300 }),
    ]);
    expect(categories.map((c) => c.remainingCents)).toEqual([-250, -300]);
  });

  it("income: actual = in - out; totals are per kind; archived rows still count", () => {
    const { categories, totals } = summarize([
      row({
        categoryId: "salary",
        kind: "income",
        plannedCents: 400_000,
        inCents: 410_000,
        outCents: 10_000,
      }),
      row({ categoryId: "food", plannedCents: 50_000, outCents: 20_000 }),
      row({ categoryId: "old", archived: true, outCents: 1_000 }),
    ]);
    expect(categories[0]).toMatchObject({
      actualCents: 400_000,
      remainingCents: 0,
    });
    expect(totals.expense).toEqual({
      plannedCents: 50_000,
      actualCents: 21_000,
      remainingCents: 29_000,
    });
    expect(totals.income).toEqual({
      plannedCents: 400_000,
      actualCents: 400_000,
      remainingCents: 0,
    });
  });

  it("a split across an expense and an income category lands in each category's own formula", () => {
    // One 100.00 inflow split 60.00 income + 40.00 refund on an expense category.
    const { categories } = summarize([
      row({ categoryId: "salary", kind: "income", inCents: 6_000 }),
      row({
        categoryId: "food",
        plannedCents: 10_000,
        outCents: 10_000,
        inCents: 4_000,
      }),
    ]);
    expect(categories.map((c) => c.actualCents)).toEqual([6_000, 6_000]);
  });

  it("stays exact at the maximum amounts (integer cents, no floats)", () => {
    const max = 100_000_000;
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ categoryId: `c${i}`, plannedCents: max, outCents: max * 20 }),
    );
    const { totals } = summarize(rows);
    expect(totals.expense.actualCents).toBe(200_000_000_000);
    expect(Number.isSafeInteger(totals.expense.remainingCents)).toBe(true);
  });

  it("an empty month has zero totals", () => {
    expect(summarize([]).totals).toEqual({
      expense: { plannedCents: 0, actualCents: 0, remainingCents: 0 },
      income: { plannedCents: 0, actualCents: 0, remainingCents: 0 },
    });
  });
});

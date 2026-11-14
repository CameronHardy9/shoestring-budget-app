// DEV PREVIEW ONLY. Invented data, typed with the generated contract types so
// the preview shows exactly the shapes the API returns (all money in cents).
import type {
  Budget,
  Category,
  MonthSummary,
  Transaction,
} from "../api/types.ts";

/** Sentinel: scripts/check-dist.ts fails the build if this string reaches dist/. */
export const DEV_PREVIEW_SENTINEL = "__SHOESTRING_DEV_PREVIEW__";

const BUDGET_ID = "0194f5c2-0000-7000-8000-00000000b001";
const USER_ID = "0194f5c2-0000-7000-8000-00000000a001";
const TS = "2026-11-14T15:04:05.000Z";

export const budget: Budget = {
  id: BUDGET_ID,
  name: "Home",
  timezone: "America/Chicago",
  currency: "USD",
  myRole: "owner",
  memberCount: 2,
  today: "2026-11-14",
  currentMonth: "2026-11",
  createdAt: TS,
  updatedAt: TS,
  version: 3,
};

const id = (n: number) =>
  `0194f5c2-0000-7000-8000-${String(n).padStart(12, "0")}`;

const category = (
  n: number,
  name: string,
  kind: Category["kind"] = "expense",
): Category => ({
  id: id(n),
  budgetId: BUDGET_ID,
  name,
  kind,
  sortOrder: n,
  archived: false,
  createdAt: TS,
  updatedAt: TS,
  version: 1,
});

export const categories: Category[] = [
  category(1, "Groceries"),
  category(2, "Dining out"),
  category(3, "Transport"),
  category(4, "Household"),
  category(5, "Fun"),
  category(6, "Rent"),
  category(7, "Utilities"),
  category(8, "Salary", "income"),
];

const cat = (name: string): Category => {
  const found = categories.find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found;
};

/** Categories ordered most recently used first (quick-add chips). */
export const recentCategories = [
  "Groceries",
  "Dining out",
  "Transport",
  "Household",
  "Fun",
].map(cat);

const line = (name: string, plannedCents: number, actualCents: number) => {
  const c = cat(name);
  return {
    categoryId: c.id,
    name: c.name,
    kind: c.kind,
    archived: false,
    plannedCents,
    actualCents,
    remainingCents: plannedCents - actualCents,
  };
};

const expenseLines = [
  line("Rent", 145000, 145000),
  line("Groceries", 60000, 41245),
  line("Dining out", 20000, 22310),
  line("Transport", 15000, 6820),
  line("Utilities", 18000, 9415),
  line("Household", 10000, 3150),
  line("Fun", 12000, 4800),
];

const incomeLines = [line("Salary", 420000, 420000)];

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const totals = (lines: typeof expenseLines) => {
  const plannedCents = sum(lines.map((l) => l.plannedCents));
  const actualCents = sum(lines.map((l) => l.actualCents));
  return {
    plannedCents,
    actualCents,
    remainingCents: plannedCents - actualCents,
  };
};

export const summary: MonthSummary = {
  budgetId: BUDGET_ID,
  month: "2026-11",
  categories: [...expenseLines, ...incomeLines],
  totals: { expense: totals(expenseLines), income: totals(incomeLines) },
  transactionCount: 38,
};

let seq = 100;
const txn = (
  date: string,
  payee: string | null,
  amountCents: number,
  splits: [string, number][],
  direction: Transaction["direction"] = "outflow",
  memo: string | null = null,
): Transaction => ({
  id: id(seq++),
  budgetId: BUDGET_ID,
  date,
  direction,
  amountCents,
  payee,
  memo,
  splits: splits.map(([name, cents]) => ({
    categoryId: cat(name).id,
    amountCents: cents,
  })),
  createdByUserId: USER_ID,
  updatedByUserId: USER_ID,
  createdAt: TS,
  updatedAt: TS,
  version: 1,
});

export const transactions: Transaction[] = [
  txn("2026-11-14", "Corner Market", 8640, [
    ["Groceries", 6000],
    ["Household", 2640],
  ]),
  txn("2026-11-14", "Bus pass", 250, [["Transport", 250]]),
  txn(
    "2026-11-14",
    null,
    1475,
    [["Dining out", 1475]],
    "outflow",
    "Lunch with Sam",
  ),
  txn("2026-11-13", "Hardware store", 1520, [["Household", 1520]], "inflow"),
  txn("2026-11-13", "Thai Garden", 4210, [["Dining out", 4210]]),
  txn("2026-11-12", "City Power", 9415, [["Utilities", 9415]]),
  txn("2026-11-12", "Fresh Foods", 12780, [["Groceries", 12780]]),
  txn("2026-11-11", "Cinema", 3200, [["Fun", 3200]]),
];

export function categoryName(categoryId: string): string {
  return (
    categories.find((c) => c.id === categoryId)?.name ?? "Unknown category"
  );
}

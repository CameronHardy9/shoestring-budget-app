// Contract-typed fixtures for component tests.
import type {
  Budget,
  Category,
  Me,
  MonthSummary,
  Schemas,
  Transaction,
} from "../api/types.ts";

export const BUDGET_ID = "0194f5c2-0000-7000-8000-00000000b001";
const TS = "2026-11-14T15:04:05.000Z";
export const uuid = (n: number) =>
  `0194f5c2-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const me: Me = {
  id: uuid(900),
  email: "alex@example.com",
  displayName: "Alex",
  createdAt: TS,
  mfa: {
    enabled: false,
    totp: false,
    passkeyCount: 0,
    recoveryCodesRemaining: 0,
  },
  deletion: null,
};

export const session: Schemas["CurrentSession"] = {
  id: uuid(901),
  expiresAt: TS,
  reauthenticatedUntil: null,
};
export const CSRF = "c".repeat(43);

export const authenticated: Schemas["AuthenticatedState"] = {
  state: "authenticated",
  user: me,
  session,
  csrfToken: CSRF,
};

export const budget: Budget = {
  id: BUDGET_ID,
  name: "Home",
  timezone: "America/Chicago",
  currency: "USD",
  myRole: "owner",
  memberCount: 1,
  today: "2026-11-14",
  currentMonth: "2026-11",
  createdAt: TS,
  updatedAt: TS,
  version: 1,
};

export const category = (
  n: number,
  name: string,
  kind: Category["kind"] = "expense",
  archived = false,
): Category => ({
  id: uuid(n),
  budgetId: BUDGET_ID,
  name,
  kind,
  sortOrder: n,
  archived,
  createdAt: TS,
  updatedAt: TS,
  version: 1,
});

export const categories: Category[] = [
  category(1, "Groceries"),
  category(2, "Dining out"),
  category(3, "Transport"),
  category(4, "Household"),
  category(5, "Old stuff", "expense", true),
  category(8, "Salary", "income"),
];

export const transaction = (
  n: number,
  patch: Partial<Transaction> = {},
): Transaction => ({
  id: uuid(100 + n),
  budgetId: BUDGET_ID,
  date: "2026-11-14",
  direction: "outflow",
  amountCents: 1250,
  payee: null,
  memo: null,
  splits: [{ categoryId: uuid(1), amountCents: 1250 }],
  createdByUserId: me.id,
  updatedByUserId: me.id,
  createdAt: TS,
  updatedAt: TS,
  version: 1,
  ...patch,
});

export const summary: MonthSummary = {
  budgetId: BUDGET_ID,
  month: "2026-11",
  categories: [
    {
      categoryId: uuid(1),
      name: "Groceries",
      kind: "expense",
      archived: false,
      plannedCents: 60000,
      actualCents: 41245,
      remainingCents: 18755,
    },
    {
      categoryId: uuid(2),
      name: "Dining out",
      kind: "expense",
      archived: false,
      plannedCents: 20000,
      actualCents: 22310,
      remainingCents: -2310,
    },
    {
      categoryId: uuid(8),
      name: "Salary",
      kind: "income",
      archived: false,
      plannedCents: 420000,
      actualCents: 0,
      remainingCents: 420000,
    },
  ],
  totals: {
    expense: { plannedCents: 80000, actualCents: 63555, remainingCents: 16445 },
    income: { plannedCents: 420000, actualCents: 0, remainingCents: 420000 },
  },
  transactionCount: 2,
};

export const members: Schemas["Member"][] = [
  { userId: me.id, displayName: "Alex", role: "owner", joinedAt: TS },
  { userId: uuid(902), displayName: "Sam", role: "member", joinedAt: TS },
];

export const plan = (month = "2026-11"): Schemas["MonthPlan"] => ({
  budgetId: BUDGET_ID,
  month,
  items: [
    {
      categoryId: uuid(1),
      month,
      amountCents: 60000,
      updatedAt: TS,
      updatedByUserId: me.id,
      version: 2,
    },
  ],
});

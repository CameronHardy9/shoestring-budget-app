// Deterministic demo data (local development and e2e only). Synthetic people
// on reserved example.com addresses, no real financial data (checklist C15.7).
//
// Two-member household "Demo household" (America/New_York) with Sep 2026 to
// Jan 2027: month and year rollover (11-30, 12-01, 12-31, 01-01), the DST
// change (2026-11-01, entered at 01:30 local twice), splits across expense and
// income categories, a refund larger than the month's spending, unplanned
// spending, an archived category with history, a soft-deleted transaction and
// a pending invitation. Plus a solo user with a separate budget (isolation).
//
// Deterministic: a fixed clock and seeded UUIDv7s, so ids and timestamps are
// identical on every run. Idempotent: does nothing if the demo owner exists.
import type { ManualClock } from "../clock.ts";
import type { Dal } from "../dal.ts";
import type { CategoryKind, Direction } from "../schema.ts";
import type { BudgetScope } from "../scope.ts";

export const SEED_EMAILS = {
  owner: "avery.demo@example.com",
  member: "blake.demo@example.com",
  solo: "casey.demo@example.com",
  invited: "drew.demo@example.com",
} as const;

export const SEED_START = "2026-09-01T16:00:00.000Z";

export interface SeedResult {
  created: boolean;
  users: number;
  budgets: number;
  transactions: number;
}

/** Deterministic PRNG (mulberry32) for amounts and payees. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: {
  name: string;
  kind: CategoryKind;
  plannedCents?: number;
}[] = [
  { name: "Groceries", kind: "expense", plannedCents: 60_000 },
  { name: "Dining out", kind: "expense", plannedCents: 25_000 },
  { name: "Rent", kind: "expense", plannedCents: 180_000 },
  { name: "Utilities", kind: "expense", plannedCents: 15_000 },
  { name: "Transport", kind: "expense", plannedCents: 12_000 },
  { name: "Gifts", kind: "expense" }, // unplanned spending
  { name: "Gym", kind: "expense", plannedCents: 4_000 }, // archived in October
  { name: "Salary", kind: "income", plannedCents: 520_000 },
  { name: "Side income", kind: "income", plannedCents: 30_000 },
];

const MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"] as const;

export async function seedDemoData(
  dal: Dal,
  clock: ManualClock,
  passwordHash: (label: string) => string,
): Promise<SeedResult> {
  if (await dal.users.findUserIdByEmail(SEED_EMAILS.owner)) {
    return { created: false, users: 0, budgets: 0, transactions: 0 };
  }
  clock.set(SEED_START);
  const rand = prng(20261113);
  const tok = (label: string): Buffer =>
    Buffer.from(`seed-token:${label}`.padEnd(32, ".").slice(0, 32));

  const signup = async (email: string, displayName: string) => {
    await dal.signup.createSignupInvite(email, tok(`invite:${email}`));
    clock.advance(60_000);
    return dal.signup.signUpWithInvite({
      tokenHash: tok(`invite:${email}`),
      displayName,
      passwordHash: passwordHash(email),
    });
  };
  const owner = await signup(SEED_EMAILS.owner, "Avery Demo");
  const member = await signup(SEED_EMAILS.member, "Blake Demo");
  const solo = await signup(SEED_EMAILS.solo, "Casey Demo");

  clock.set("2026-09-01T17:00:00.000Z");
  const { value: budget } = await dal.budgets.createBudget(owner.userId, {
    name: "Demo household",
    timezone: "America/New_York",
    categories: CATEGORIES,
  });
  const ownerScope = await dal.requireMembership(owner.userId, budget.id);
  const { invitation } = await dal.invitations.createBudgetInvitation(
    ownerScope,
    SEED_EMAILS.member,
  );
  clock.advance(3_600_000);
  await dal.invitations.acceptInvitation(member.userId, invitation.id);
  const memberScope = await dal.requireMembership(member.userId, budget.id);
  const cat = Object.fromEntries(
    (await dal.categories.listCategories(ownerScope)).map((c) => [
      c.name,
      c.id,
    ]),
  );
  const id = (name: string): string => {
    const v = cat[name];
    if (!v) throw new Error(`seed: unknown category ${name}`);
    return v;
  };

  let count = 0;
  const add = async (
    scope: BudgetScope,
    date: string,
    direction: Direction,
    splits: [string, number][],
    extra: { payee?: string; memo?: string; at?: string } = {},
  ) => {
    clock.set(extra.at ?? `${date}T17:00:00.000Z`);
    const amountCents = splits.reduce((a, [, c]) => a + c, 0);
    count++;
    return dal.transactions.createTransaction(scope, {
      date,
      direction,
      amountCents,
      payee: extra.payee ?? null,
      memo: extra.memo ?? null,
      splits: splits.map(([name, cents]) => ({
        categoryId: id(name),
        amountCents: cents,
      })),
    });
  };
  const cents = (min: number, max: number) =>
    Math.round(min + rand() * (max - min));
  const shops = [
    "Green Grocer",
    "Corner Market",
    "Harbor Foods",
    "Weekly Farm Stand",
  ];
  const cafes = ["Noodle Bar", "Taco Spot", "Pizza Place", "Cafe Luna"];

  for (const month of MONTHS) {
    const d = (day: number) => `${month}-${String(day).padStart(2, "0")}`;
    clock.set(`${d(1)}T13:00:00.000Z`);
    if (month !== "2026-09")
      await dal.plans.copyPreviousMonthPlan(ownerScope, month);

    await add(ownerScope, d(1), "outflow", [["Rent", 180_000]], {
      payee: "Demo Property Co",
    });
    await add(ownerScope, d(15), "inflow", [["Salary", 260_000]], {
      payee: "Example Employer",
    });
    // Paycheck split across two income categories.
    await add(
      ownerScope,
      d(28),
      "inflow",
      [
        ["Salary", 260_000],
        ["Side income", cents(15_000, 30_000)],
      ],
      { payee: "Example Employer", memo: "Includes bonus" },
    );
    for (const day of [3, 10, 17, 24]) {
      await add(
        day % 2 === 0 ? memberScope : ownerScope,
        d(day),
        "outflow",
        [["Groceries", cents(6_000, 16_000)]],
        {
          payee: shops[Math.floor(rand() * shops.length)] ?? "Market",
        },
      );
    }
    await add(
      memberScope,
      d(8),
      "outflow",
      [["Dining out", cents(2_500, 9_000)]],
      { payee: cafes[Math.floor(rand() * cafes.length)] ?? "Cafe" },
    );
    await add(
      ownerScope,
      d(20),
      "outflow",
      [["Dining out", cents(2_500, 9_000)]],
      { payee: cafes[Math.floor(rand() * cafes.length)] ?? "Cafe" },
    );
    await add(
      ownerScope,
      d(12),
      "outflow",
      [["Utilities", cents(9_000, 14_000)]],
      { payee: "City Power & Water" },
    );
    await add(
      memberScope,
      d(6),
      "outflow",
      [["Transport", cents(3_000, 6_000)]],
      { payee: "Transit card" },
    );
    // Split outflow across expense categories (big-box run: food and a gift).
    await add(
      memberScope,
      d(22),
      "outflow",
      [
        ["Groceries", cents(8_000, 12_000)],
        ["Gifts", cents(2_000, 5_000)],
      ],
      { payee: "Big Box Store", memo: "Split: food and a birthday gift" },
    );
  }

  // Archived category with history: gym in September, archived in October.
  await add(ownerScope, "2026-09-05", "outflow", [["Gym", 4_000]], {
    payee: "Demo Gym",
  });
  clock.set("2026-10-02T15:00:00.000Z");
  const gym = await dal.categories.getCategory(ownerScope, id("Gym"));
  await dal.categories.updateCategory(ownerScope, gym.id, {
    archived: true,
    version: gym.version,
  });

  // A refund larger than the month's transport spending (actual goes negative).
  await add(ownerScope, "2026-10-18", "inflow", [["Transport", 9_500]], {
    payee: "Airline",
    memo: "Refund for a cancelled flight",
  });

  // DST end in New York: 2026-11-01 01:30 happens twice (EDT, then EST).
  await add(ownerScope, "2026-11-01", "outflow", [["Dining out", 1_850]], {
    payee: "Late Diner",
    at: "2026-11-01T05:30:00.000Z",
  });
  await add(memberScope, "2026-11-01", "outflow", [["Dining out", 1_250]], {
    payee: "Late Diner",
    at: "2026-11-01T06:30:00.000Z",
  });

  // Month and year rollover edges.
  await add(ownerScope, "2026-11-30", "outflow", [["Groceries", 4_210]], {
    payee: "Corner Market",
    memo: "Last day of November",
  });
  await add(
    memberScope,
    "2026-12-31",
    "outflow",
    [
      ["Dining out", 12_000],
      ["Gifts", 3_000],
    ],
    { payee: "New Year's Eve dinner", at: "2027-01-01T04:30:00.000Z" },
  ); // 23:30 local, already Jan 1 in UTC
  await add(ownerScope, "2027-01-01", "outflow", [["Groceries", 2_575]], {
    payee: "Corner Market",
    memo: "New Year's Day",
  });

  // Unplanned spending in December, and a soft-deleted mistake.
  await add(ownerScope, "2026-12-14", "outflow", [["Gifts", 18_500]], {
    payee: "Toy Shop",
  });
  const mistake = await add(
    memberScope,
    "2026-12-15",
    "outflow",
    [["Groceries", 99_900]],
    { payee: "Typo" },
  );
  clock.set("2026-12-15T18:00:00.000Z");
  await dal.transactions.deleteTransaction(
    memberScope,
    mistake.value.id,
    mistake.value.version,
  );
  count--;

  // A pending invitation to someone without an account yet.
  clock.set("2026-12-20T15:00:00.000Z");
  await dal.invitations.createBudgetInvitation(ownerScope, SEED_EMAILS.invited);

  // A separate solo budget (isolation checks in the browser).
  clock.set("2026-10-01T15:00:00.000Z");
  const { value: soloBudget } = await dal.budgets.createBudget(solo.userId, {
    name: "Casey's budget",
    timezone: "America/Los_Angeles",
    categories: [
      { name: "Food", kind: "expense", plannedCents: 40_000 },
      { name: "Pay", kind: "income", plannedCents: 300_000 },
    ],
  });
  const soloScope = await dal.requireMembership(solo.userId, soloBudget.id);
  const soloCats = Object.fromEntries(
    (await dal.categories.listCategories(soloScope)).map((c) => [c.name, c.id]),
  );
  for (const [date, dir, name, amount] of [
    ["2026-10-02", "outflow", "Food", 2_345],
    ["2026-10-15", "inflow", "Pay", 300_000],
    ["2026-11-02", "outflow", "Food", 5_600],
  ] as const) {
    clock.set(`${date}T20:00:00.000Z`);
    await dal.transactions.createTransaction(soloScope, {
      date,
      direction: dir,
      amountCents: amount,
      splits: [{ categoryId: soloCats[name] ?? "", amountCents: amount }],
    });
    count++;
  }

  return { created: true, users: 3, budgets: 2, transactions: count };
}

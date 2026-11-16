// Test data, written straight through the data-engineer's DAL (test-hooks.md):
// fast, and exactly the rows the backend would write. SYNTHETIC DATA ONLY:
// example.test addresses, invented names, round amounts (tests/CLAUDE.md).
import type {
  BudgetRecord,
  BudgetScope,
  CategoryKind,
  Direction,
  TransactionRecord,
} from "@shoestring/db";
import { argon2Sync, randomBytes, randomUUID } from "node:crypto";
import { dal } from "./dal.ts";

// One password for every factory user, random per run (never a literal in the
// repo), hashed once with the backend's argon2id parameters (auth.md §7).
export const PASSWORD = `pw-${randomBytes(12).toString("hex")}`;
const PASSWORD_HASH = (() => {
  const salt = randomBytes(16);
  const tag = argon2Sync("argon2id", {
    message: PASSWORD,
    nonce: salt,
    parallelism: 1,
    tagLength: 32,
    memory: 19_456,
    passes: 2,
  });
  const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");
  return ["", "argon2id", "v=19", "m=19456,t=2,p=1", b64(salt), b64(tag)].join(
    "$",
  );
})();

let seq = 0;
export function uniqueEmail(prefix = "user"): string {
  seq += 1;
  return `${prefix}-${seq}-${randomUUID().slice(0, 8)}@example.test`;
}

export interface TestUser {
  userId: string;
  email: string;
  displayName: string;
  password: string;
}

export async function createUser(
  opts: { email?: string; displayName?: string; prefix?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail(opts.prefix);
  const displayName = opts.displayName ?? `Tester ${seq}`;
  const tokenHash = randomBytes(32);
  await dal().signup.createSignupInvite(email, tokenHash);
  const { userId } = await dal().signup.signUpWithInvite({
    tokenHash,
    displayName,
    passwordHash: PASSWORD_HASH,
  });
  return {
    userId,
    email: email.toLowerCase(),
    displayName,
    password: PASSWORD,
  };
}

export interface CategorySpec {
  name: string;
  kind: CategoryKind;
  plannedCents?: number;
}

export const STARTER: CategorySpec[] = [
  { name: "Groceries", kind: "expense", plannedCents: 50_000 },
  { name: "Dining", kind: "expense", plannedCents: 20_000 },
  { name: "Salary", kind: "income", plannedCents: 400_000 },
];

export interface TestBudget {
  id: string;
  record: BudgetRecord;
  /** The owner's scope (from requireMembership). */
  scope: BudgetScope;
  /** Category IDs by name. */
  categories: Record<string, string>;
}

export async function createBudget(
  owner: TestUser,
  opts: { name?: string; timezone?: string; categories?: CategorySpec[] } = {},
): Promise<TestBudget> {
  const { value } = await dal().budgets.createBudget(owner.userId, {
    name: opts.name ?? "Household",
    timezone: opts.timezone ?? "America/New_York",
    categories: opts.categories ?? STARTER,
  });
  const scope = await dal().requireMembership(owner.userId, value.id);
  const cats = await dal().categories.listCategories(scope);
  return {
    id: value.id,
    record: value,
    scope,
    categories: Object.fromEntries(cats.map((c) => [c.name, c.id])),
  };
}

/** Invitation + acceptance through the DAL; returns the member's scope. */
export async function addMember(
  budget: TestBudget,
  user: TestUser,
): Promise<BudgetScope> {
  const { invitation } = await dal().invitations.createBudgetInvitation(
    budget.scope,
    user.email,
  );
  await dal().invitations.acceptInvitation(user.userId, invitation.id);
  return dal().requireMembership(user.userId, budget.id);
}

export async function createCategory(
  scope: BudgetScope,
  name: string,
  kind: CategoryKind = "expense",
): Promise<string> {
  const c = await dal().categories.createCategory(scope, { name, kind });
  return c.id;
}

export async function archiveCategory(
  scope: BudgetScope,
  categoryId: string,
): Promise<void> {
  const c = await dal().categories.getCategory(scope, categoryId);
  await dal().categories.updateCategory(scope, categoryId, {
    archived: true,
    version: c.version,
  });
}

export async function setPlan(
  scope: BudgetScope,
  month: string,
  categoryId: string,
  amountCents: number,
): Promise<void> {
  const plan = await dal().plans.getMonthPlan(scope, month);
  const existing = plan.items.find((p) => p.categoryId === categoryId);
  await dal().plans.putPlanEntry(scope, month, categoryId, {
    amountCents,
    version: existing?.version ?? null,
  });
}

export interface TxSpec {
  date: string;
  direction?: Direction;
  amountCents?: number;
  payee?: string | null;
  memo?: string | null;
  /** Default: one split on `categoryId` for the full amount. */
  splits?: { categoryId: string; amountCents: number }[];
  categoryId?: string;
}

export async function createTransaction(
  scope: BudgetScope,
  spec: TxSpec,
): Promise<TransactionRecord> {
  const splits = spec.splits ?? [
    { categoryId: spec.categoryId!, amountCents: spec.amountCents ?? 1_000 },
  ];
  const amountCents =
    spec.amountCents ?? splits.reduce((s, x) => s + x.amountCents, 0);
  const { value } = await dal().transactions.createTransaction(scope, {
    date: spec.date,
    direction: spec.direction ?? "outflow",
    amountCents,
    payee: spec.payee ?? null,
    memo: spec.memo ?? null,
    splits,
  });
  return value;
}

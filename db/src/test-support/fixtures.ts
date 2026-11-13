// Test data built through the DAL itself (the same paths the backend uses).
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Dal } from "../dal.ts";
import type { BudgetRecord } from "../records.ts";
import type { CategoryKind } from "../schema.ts";
import type { BudgetScope } from "../scope.ts";

/** 32 random bytes (a token hash). */
export const hash32 = (): Buffer => randomBytes(32);

/** A well-formed argon2id PHC string of random bytes (not a hash of any password). */
export const fakePasswordHash = (): string =>
  `$argon2id$v=19$m=19456,t=2,p=1$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;

export const csrf = (): string => randomBytes(32).toString("base64url");

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export async function newUser(
  dal: Dal,
  options: { email?: string; displayName?: string } = {},
): Promise<{ userId: string; email: string }> {
  const email = options.email ?? uniqueEmail();
  const token = hash32();
  await dal.signup.createSignupInvite(email, token);
  return dal.signup.signUpWithInvite({
    tokenHash: token,
    displayName: options.displayName ?? "Test User",
    passwordHash: fakePasswordHash(),
  });
}

export interface BudgetFixture {
  budget: BudgetRecord;
  scope: BudgetScope;
  /** Category IDs by name. */
  categories: Record<string, string>;
}

export const DEFAULT_CATEGORIES: {
  name: string;
  kind: CategoryKind;
  plannedCents?: number;
}[] = [
  { name: "Groceries", kind: "expense", plannedCents: 50_000 },
  { name: "Dining", kind: "expense", plannedCents: 20_000 },
  { name: "Salary", kind: "income", plannedCents: 400_000 },
];

export async function newBudget(
  dal: Dal,
  userId: string,
  categories = DEFAULT_CATEGORIES,
  name = "Household",
): Promise<BudgetFixture> {
  const { value: budget } = await dal.budgets.createBudget(userId, {
    name,
    timezone: "America/New_York",
    categories,
  });
  const scope = await dal.requireMembership(userId, budget.id);
  const cats = await dal.categories.listCategories(scope);
  return {
    budget,
    scope,
    categories: Object.fromEntries(cats.map((c) => [c.name, c.id])),
  };
}

/** Adds the user to the budget through invitation and acceptance. */
export async function addMember(
  dal: Dal,
  ownerScope: BudgetScope,
  user: { userId: string; email: string },
): Promise<BudgetScope> {
  const { invitation } = await dal.invitations.createBudgetInvitation(
    ownerScope,
    user.email,
  );
  await dal.invitations.acceptInvitation(user.userId, invitation.id);
  return dal.requireMembership(user.userId, ownerScope.budgetId);
}

/** Expects `p` to reject with a DalError of `code`. */
export async function expectDalError(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: "DalError", code });
}

/** Expects `p` to reject with a Postgres error of SQLSTATE `code`. */
export async function expectPgError(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

// The standard two-household world most API tests start from:
//   owner   owns `budget` (America/New_York, starter categories, one transaction)
//   member  is a member of `budget`
//   outsider owns `outsiderBudget` and is in no relation to `budget`
// Everyone is signed in through the test login (fresh re-auth window).
import type { BudgetScope, TransactionRecord } from "@shoestring/db";
import { createHash, randomBytes } from "node:crypto";
import type { TestBudget, TestUser } from "./factories.ts";
import {
  addMember,
  createBudget,
  createTransaction,
  createUser,
} from "./factories.ts";
import type { ApiClient } from "./http.ts";
import { testLogin } from "./hooks.ts";

export interface Persona {
  user: TestUser;
  client: ApiClient;
}

export interface World {
  owner: Persona;
  member: Persona;
  outsider: Persona;
  budget: TestBudget;
  memberScope: BudgetScope;
  outsiderBudget: TestBudget;
  /** A transaction in `budget` (Groceries, 12.34, dated today). */
  tx: TransactionRecord;
  /** The budget's current month at DEFAULT_NOW. */
  month: string;
  today: string;
}

export async function persona(prefix: string): Promise<Persona> {
  const user = await createUser({
    prefix,
    displayName: `${prefix[0]!.toUpperCase()}${prefix.slice(1)} Tester`,
  });
  return { user, client: await testLogin(user.email, prefix) };
}

export async function seedWorld(): Promise<World> {
  const owner = await persona("owner");
  const member = await persona("member");
  const outsider = await persona("outsider");
  const budget = await createBudget(owner.user, { name: "Shared household" });
  const memberScope = await addMember(budget, member.user);
  const outsiderBudget = await createBudget(outsider.user, {
    name: "Outsider household",
  });
  const today = budget.record.today;
  const tx = await createTransaction(budget.scope, {
    date: today,
    amountCents: 1_234,
    categoryId: budget.categories.Groceries!,
    payee: "Corner shop",
  });
  return {
    owner,
    member,
    outsider,
    budget,
    memberScope,
    outsiderBudget,
    tx,
    month: budget.record.currentMonth,
    today,
  };
}

/** A raw one-time token and its stored hash (user_tokens.token_hash = SHA-256). */
export function oneTimeToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest() };
}

/** The caller's own session id (GET /auth/session). */
export async function sessionIdOf(client: ApiClient): Promise<string> {
  const r = await client.get<{ session: { id: string } }>("/auth/session");
  return r.body.session.id;
}

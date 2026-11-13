// Tenancy guard (ADR-0006, ADR-0010, F-18, F-36).
//
// A BudgetScope can only be created by requireMembership(); a DeletedBudgetScope
// only by requireDeletedBudgetOwnership(). Both are branded types, and every
// issued scope is also recorded in a WeakSet, so a forged object
// (`{...} as BudgetScope`) fails at runtime too, not just in review.
// This file is the only place that may assert these types (Semgrep allowlist).
import { sql } from "kysely";
import type { Ctx } from "./context.ts";
import { DAY_MS } from "./context.ts";
import { forbidden, notFound } from "./errors.ts";
import type { MemberRole } from "./schema.ts";

declare const budgetScopeBrand: unique symbol;
declare const deletedBudgetScopeBrand: unique symbol;

export interface BudgetScope {
  readonly budgetId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly [budgetScopeBrand]: true;
}

export interface DeletedBudgetScope {
  readonly budgetId: string;
  readonly userId: string;
  readonly deletedAt: Date;
  readonly [deletedBudgetScopeBrand]: true;
}

const issuedScopes = new WeakSet<object>();
const issuedDeletedScopes = new WeakSet<object>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rejects malformed uuids with an error; treat them as "not found". */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Throws unless `scope` was issued by requireMembership(). */
export function assertBudgetScope(scope: BudgetScope): void {
  if (!issuedScopes.has(scope)) {
    throw new TypeError("BudgetScope was not issued by requireMembership()");
  }
}

/** Throws FORBIDDEN unless the scope holds the owner role. */
export function assertOwner(scope: BudgetScope): void {
  assertBudgetScope(scope);
  if (scope.role !== "owner") throw forbidden();
}

export function assertDeletedBudgetScope(scope: DeletedBudgetScope): void {
  if (!issuedDeletedScopes.has(scope)) {
    throw new TypeError(
      "DeletedBudgetScope was not issued by requireDeletedBudgetOwnership()",
    );
  }
}

/**
 * The membership check for every /budgets/{budgetId} request: one query on
 * budget_members (PK) joined to the non-deleted budget. Non-member, unknown or
 * deleted budget -> NOT_FOUND.
 */
export async function requireMembership(
  ctx: Ctx,
  userId: string,
  budgetId: string,
): Promise<BudgetScope> {
  if (!isUuid(userId) || !isUuid(budgetId)) throw notFound();
  const row = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("budgets as b", "b.id", "m.budget_id")
    .select(["m.role"])
    .where("m.budget_id", "=", budgetId)
    .where("m.user_id", "=", userId)
    .where("b.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw notFound();
  return issueBudgetScope(budgetId, userId, row.role);
}

/**
 * The only place a BudgetScope is minted. Module-private on purpose (F-41):
 * callers obtain scopes through requireMembership(), never by constructing one.
 */
function issueBudgetScope(
  budgetId: string,
  userId: string,
  role: MemberRole,
): BudgetScope {
  const scope = Object.freeze({ budgetId, userId, role }) as BudgetScope;
  issuedScopes.add(scope);
  return scope;
}

/**
 * Scope for the restore route (F-36): an owner membership of a budget
 * soft-deleted no more than 30 days ago, whose owner account is not pending
 * deletion. Takes a row lock on the budget (FOR UPDATE) when called inside a
 * transaction. Anything else -> NOT_FOUND.
 */
export async function requireDeletedBudgetOwnership(
  ctx: Ctx,
  userId: string,
  budgetId: string,
): Promise<DeletedBudgetScope> {
  if (!isUuid(userId) || !isUuid(budgetId)) throw notFound();
  const windowStart = new Date(ctx.clock().getTime() - 30 * DAY_MS);
  const row = await ctx.db
    .selectFrom("budgets as b")
    .innerJoin("budget_members as m", (j) =>
      j
        .onRef("m.budget_id", "=", "b.id")
        .on("m.user_id", "=", userId)
        .on("m.role", "=", "owner"),
    )
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["b.deleted_at"])
    .where("b.id", "=", budgetId)
    .where("b.deleted_at", "is not", null)
    .where("b.deleted_at", ">=", windowStart)
    .where("u.status", "=", "active")
    .forUpdate("b")
    .executeTakeFirst();
  if (!row?.deleted_at) throw notFound();
  const scope = Object.freeze({
    budgetId,
    userId,
    deletedAt: row.deleted_at,
  }) as DeletedBudgetScope;
  issuedDeletedScopes.add(scope);
  return scope;
}

/**
 * Locks the budget row (FOR UPDATE) and re-reads the caller's role inside the
 * current transaction. Used by owner actions and limit checks so a concurrent
 * transfer, removal or deletion cannot slip between check and write (F-25).
 */
export async function lockBudget(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<{ role: MemberRole }> {
  assertBudgetScope(scope);
  const row = await ctx.db
    .selectFrom("budgets as b")
    .leftJoin("budget_members as m", (j) =>
      j.onRef("m.budget_id", "=", "b.id").on("m.user_id", "=", scope.userId),
    )
    .select(["m.role", "b.deleted_at"])
    .where("b.id", "=", scope.budgetId)
    .forUpdate("b")
    .executeTakeFirst();
  if (!row || row.deleted_at !== null || row.role === null) throw notFound();
  return { role: row.role };
}

/** lockBudget + owner role re-check. */
export async function lockBudgetAsOwner(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<void> {
  const { role } = await lockBudget(ctx, scope);
  if (role !== "owner") throw forbidden();
}

/** Takes a transaction-level advisory lock keyed by a namespaced string. */
export async function advisoryLock(ctx: Ctx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
    ctx.db,
  );
}

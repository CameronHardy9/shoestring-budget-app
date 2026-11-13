// The data-access layer the backend imports. createDal() is the only way to
// reach the database from outside db/: the backend never sees Kysely, raw SQL
// or table types (F-18 tooling: Kysely/sql imports outside db/ are banned).
import type { Kysely } from "kysely";
import type pg from "pg";
import { createKysely, createPool } from "./client.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { Ctx } from "./context.ts";
import { withTx } from "./context.ts";
import type { IdGenerator } from "./ids.ts";
import { defaultIdGenerator } from "./ids.ts";
import * as budgets from "./repos/budgets.ts";
import * as categories from "./repos/categories.ts";
import * as exportsRepo from "./repos/exports.ts";
import * as health from "./repos/health.ts";
import * as invitations from "./repos/invitations.ts";
import * as members from "./repos/members.ts";
import * as mfa from "./repos/mfa.ts";
import * as plans from "./repos/plans.ts";
import * as purge from "./repos/purge.ts";
import * as securityEvents from "./repos/securityEvents.ts";
import * as sessions from "./repos/sessions.ts";
import * as signup from "./repos/signup.ts";
import * as summary from "./repos/summary.ts";
import * as throttles from "./repos/throttles.ts";
import * as tokens from "./repos/tokens.ts";
import * as transactions from "./repos/transactions.ts";
import * as users from "./repos/users.ts";
import type { Database } from "./schema.ts";
import type { BudgetScope, DeletedBudgetScope } from "./scope.ts";
import { requireDeletedBudgetOwnership, requireMembership } from "./scope.ts";

type CtxFn = (ctx: Ctx, ...args: never[]) => unknown;
/** A repository module with `ctx` bound: every function loses its first parameter. */
export type Bound<M> = {
  [K in keyof M as M[K] extends CtxFn ? K : never]: M[K] extends (
    ctx: Ctx,
    ...args: infer A
  ) => infer R
    ? (...args: A) => R
    : never;
};

function bind<M extends object>(mod: M, ctx: Ctx): Bound<M> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn === "function")
      out[name] = (...args: unknown[]) =>
        (fn as (c: Ctx, ...a: unknown[]) => unknown)(ctx, ...args);
  }
  return Object.freeze(out) as Bound<M>;
}

export interface Dal {
  /** Account lookups, profile, password change, account deletion. */
  readonly users: Bound<typeof users>;
  /** Sign-up invites and invite-only sign-up. */
  readonly signup: Bound<typeof signup>;
  readonly sessions: Bound<typeof sessions>;
  /** Password-reset and email-change tokens (F-01, F-33). */
  readonly tokens: Bound<typeof tokens>;
  readonly mfa: Bound<typeof mfa>;
  readonly throttles: Bound<typeof throttles>;
  readonly securityEvents: Bound<typeof securityEvents>;
  readonly budgets: Bound<typeof budgets>;
  readonly members: Bound<typeof members>;
  readonly invitations: Bound<typeof invitations>;
  readonly categories: Bound<typeof categories>;
  readonly plans: Bound<typeof plans>;
  readonly transactions: Bound<typeof transactions>;
  readonly summary: Bound<typeof summary>;
  readonly exports: Bound<typeof exportsRepo>;
  readonly purge: Bound<typeof purge>;
  readonly health: Bound<typeof health>;
  /** The membership check: the only way to obtain a BudgetScope. NOT_FOUND otherwise. */
  requireMembership(userId: string, budgetId: string): Promise<BudgetScope>;
  /** The only way to obtain a DeletedBudgetScope (F-36). NOT_FOUND otherwise. */
  requireDeletedBudgetOwnership(
    userId: string,
    budgetId: string,
  ): Promise<DeletedBudgetScope>;
  /**
   * Runs `fn` in one database transaction: every call on the Dal it receives
   * joins it (e.g. a domain write plus its security event). Rolls back if `fn`
   * throws.
   */
  transaction<T>(fn: (tx: Dal) => Promise<T>): Promise<T>;
  /** The application clock this Dal reads (the backend's injectable clock). */
  readonly clock: Clock;
  /** Closes the pool (no-op on a transaction-bound Dal). */
  close(): Promise<void>;
}

export interface DalOptions {
  /** postgres:// URL of the `app` role (DATABASE_URL). */
  connectionString: string;
  /** Application clock (test hooks freeze it). Default: system time. */
  clock?: Clock;
  /** Id generator (the seed uses a deterministic one). Default: UUIDv7. */
  idGenerator?: IdGenerator;
  /** Pool size, default 5. */
  poolMax?: number;
  applicationName?: string;
}

function makeDal(ctx: Ctx, close: () => Promise<void>): Dal {
  return Object.freeze({
    users: bind(users, ctx),
    signup: bind(signup, ctx),
    sessions: bind(sessions, ctx),
    tokens: bind(tokens, ctx),
    mfa: bind(mfa, ctx),
    throttles: bind(throttles, ctx),
    securityEvents: bind(securityEvents, ctx),
    budgets: bind(budgets, ctx),
    members: bind(members, ctx),
    invitations: bind(invitations, ctx),
    categories: bind(categories, ctx),
    plans: bind(plans, ctx),
    transactions: bind(transactions, ctx),
    summary: bind(summary, ctx),
    exports: bind(exportsRepo, ctx),
    purge: bind(purge, ctx),
    health: bind(health, ctx),
    requireMembership: (userId: string, budgetId: string) =>
      requireMembership(ctx, userId, budgetId),
    requireDeletedBudgetOwnership: (userId: string, budgetId: string) =>
      requireDeletedBudgetOwnership(ctx, userId, budgetId),
    transaction: <T>(fn: (tx: Dal) => Promise<T>) =>
      withTx(ctx, (txCtx) => fn(makeDal(txCtx, () => Promise.resolve()))),
    clock: ctx.clock,
    close,
  });
}

export function createDal(options: DalOptions): Dal {
  const pool: pg.Pool = createPool({
    connectionString: options.connectionString,
    ...(options.poolMax !== undefined ? { max: options.poolMax } : {}),
    ...(options.applicationName !== undefined
      ? { applicationName: options.applicationName }
      : {}),
  });
  const db: Kysely<Database> = createKysely(pool);
  const ctx: Ctx = {
    db,
    clock: options.clock ?? systemClock,
    newId: options.idGenerator ?? defaultIdGenerator,
  };
  return makeDal(ctx, () => db.destroy());
}

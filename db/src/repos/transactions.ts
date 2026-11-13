// Transactions with 1..20 splits (ADR-0004). Every transaction has at least
// one split; the database's deferred trigger enforces the sum at commit, and
// these functions check first so callers get typed errors.
import type { Ctx } from "../context.ts";
import { withTx } from "../context.ts";
import { isCalendarDate } from "../dates.ts";
import type { CalendarDate, Month } from "../dates.ts";
import { DalError, invalid, notFound, versionConflict } from "../errors.ts";
import type {
  SplitRecord,
  TransactionPage,
  TransactionPosition,
  TransactionRecord,
} from "../records.ts";
import type { Direction } from "../schema.ts";
import { TX_COLUMNS, transactionListQuery } from "../queries.ts";
import type { BudgetScope } from "../scope.ts";
import { assertBudgetScope, isUuid } from "../scope.ts";
import type { IdempotencyInput } from "./common.ts";
import { LIMITS, claimIdempotencyKey } from "./common.ts";
import type { CreateResult } from "./budgets.ts";

export interface SplitInput {
  categoryId: string;
  amountCents: number;
}

export interface TransactionInput {
  date: CalendarDate;
  direction: Direction;
  amountCents: number;
  payee?: string | null | undefined;
  memo?: string | null | undefined;
  splits: SplitInput[];
}

export interface ReplaceTransactionInput extends TransactionInput {
  version: number;
}

interface TxRow {
  id: string;
  budget_id: string;
  date: string;
  direction: Direction;
  amount_cents: number;
  payee: string | null;
  memo: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

function isMoney(n: number, min: number): boolean {
  return Number.isSafeInteger(n) && n >= min && n <= LIMITS.maxAmountCents;
}

/** Checks that need no database: shape, ranges, duplicates. */
function validateShape(input: TransactionInput): void {
  if (!isCalendarDate(input.date))
    throw invalid({ in: "body", field: "date", issue: "invalid_format" });
  if (input.date < "2000-01-01" || input.date > "2099-12-31")
    throw invalid({ in: "body", field: "date", issue: "too_big" });
  if (!isMoney(input.amountCents, 1))
    throw invalid({
      in: "body",
      field: "amountCents",
      issue: input.amountCents < 1 ? "too_small" : "too_big",
    });
  if (input.splits.length < 1)
    throw invalid({ in: "body", field: "splits", issue: "too_short" });
  if (input.splits.length > LIMITS.splitsPerTransaction)
    throw invalid({ in: "body", field: "splits", issue: "too_long" });
  const seen = new Set<string>();
  input.splits.forEach((s, i) => {
    if (!isMoney(s.amountCents, 1)) {
      throw invalid({
        in: "body",
        field: `splits.${i}.amountCents`,
        issue: s.amountCents < 1 ? "too_small" : "too_big",
      });
    }
    const key = s.categoryId.toLowerCase();
    if (seen.has(key))
      throw invalid({
        in: "body",
        field: `splits.${i}.categoryId`,
        issue: "duplicate",
      });
    seen.add(key);
  });
}

/**
 * Checks that need the budget's categories, in errors.md order: a categoryId
 * outside the budget is 400 VALIDATION_FAILED (before any write, so the
 * composite FK never fires); then the sum (422 SPLITS_DO_NOT_SUM); then new use
 * of an archived category (422 CATEGORY_ARCHIVED). `existingCategoryIds` are
 * categories already on the transaction being replaced: keeping them is not a
 * new use.
 */
async function validateAgainstBudget(
  ctx: Ctx,
  budgetId: string,
  input: TransactionInput,
  existingCategoryIds: ReadonlySet<string> = new Set(),
  versionCheck?: () => void,
): Promise<void> {
  const ids = input.splits.map((s) => s.categoryId).filter(isUuid);
  const cats =
    ids.length === 0
      ? []
      : await ctx.db
          .selectFrom("categories")
          .select(["id", "archived_at"])
          .where("budget_id", "=", budgetId)
          .where("id", "in", ids)
          .execute();
  const byId = new Map(cats.map((c) => [c.id, c]));
  input.splits.forEach((s, i) => {
    if (!byId.has(s.categoryId.toLowerCase()))
      throw invalid({
        in: "body",
        field: `splits.${i}.categoryId`,
        issue: "invalid_value",
      });
  });
  versionCheck?.();
  const total = input.splits.reduce((acc, s) => acc + s.amountCents, 0);
  if (total !== input.amountCents) {
    throw new DalError("SPLITS_DO_NOT_SUM", {
      details: [{ in: "body", field: "splits", issue: "sum_mismatch" }],
    });
  }
  input.splits.forEach((s, i) => {
    const id = s.categoryId.toLowerCase();
    if (byId.get(id)?.archived_at != null && !existingCategoryIds.has(id)) {
      throw new DalError("CATEGORY_ARCHIVED", {
        details: [
          { in: "body", field: `splits.${i}.categoryId`, issue: "archived" },
        ],
      });
    }
  });
}

function sortSplits(splits: SplitRecord[]): SplitRecord[] {
  return splits.sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0),
  );
}

async function attachSplits(
  ctx: Ctx,
  budgetId: string,
  rows: TxRow[],
): Promise<TransactionRecord[]> {
  if (rows.length === 0) return [];
  const splits = await ctx.db
    .selectFrom("transaction_splits")
    .select(["transaction_id", "category_id", "amount_cents"])
    .where("budget_id", "=", budgetId)
    .where(
      "transaction_id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  const byTx = new Map<string, SplitRecord[]>();
  for (const s of splits) {
    const list = byTx.get(s.transaction_id) ?? [];
    list.push({ categoryId: s.category_id, amountCents: s.amount_cents });
    byTx.set(s.transaction_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    budgetId: r.budget_id,
    date: r.date,
    direction: r.direction,
    amountCents: r.amount_cents,
    payee: r.payee,
    memo: r.memo,
    splits: sortSplits(byTx.get(r.id) ?? []),
    createdByUserId: r.created_by_user_id,
    updatedByUserId: r.updated_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  }));
}

/** GET /budgets/{b}/transactions/{t}: NOT_FOUND if missing, deleted, or in another budget. */
export async function getTransaction(
  ctx: Ctx,
  scope: BudgetScope,
  transactionId: string,
): Promise<TransactionRecord> {
  assertBudgetScope(scope);
  if (!isUuid(transactionId)) throw notFound();
  const row = await ctx.db
    .selectFrom("transactions")
    .select(TX_COLUMNS)
    .where("budget_id", "=", scope.budgetId)
    .where("id", "=", transactionId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw notFound();
  const [record] = await attachSplits(ctx, scope.budgetId, [row]);
  if (!record) throw notFound();
  return record;
}

export interface ListTransactionsOptions {
  /** 'YYYY-MM': only transactions dated in this month. */
  month?: Month | undefined;
  /** Only transactions with at least one split in this category. */
  categoryId?: string | undefined;
  /** 1..100, default 50. */
  limit?: number | undefined;
  /** Keyset position from the previous page (decoded from the MAC'd cursor). */
  after?: TransactionPosition | undefined;
}

/**
 * GET /budgets/{b}/transactions: newest first (date DESC, id DESC), keyset
 * pagination on the partial index transactions_list_idx. A categoryId that is
 * not in this budget simply matches nothing.
 */
export async function listTransactions(
  ctx: Ctx,
  scope: BudgetScope,
  options: ListTransactionsOptions = {},
): Promise<TransactionPage> {
  assertBudgetScope(scope);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  if (options.categoryId !== undefined && !isUuid(options.categoryId))
    return { items: [], next: null };
  if (
    options.after &&
    (!isCalendarDate(options.after.date) || !isUuid(options.after.id))
  ) {
    throw invalid({ in: "query", field: "cursor", issue: "invalid_value" });
  }
  const rows = await transactionListQuery(
    ctx.db,
    scope.budgetId,
    options,
    limit + 1,
  ).execute();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await attachSplits(ctx, scope.budgetId, page),
    next: rows.length > limit && last ? { date: last.date, id: last.id } : null,
  };
}

async function insertSplits(
  ctx: Ctx,
  budgetId: string,
  transactionId: string,
  splits: SplitInput[],
  now: Date,
): Promise<void> {
  await ctx.db
    .insertInto("transaction_splits")
    .values(
      splits.map((s) => ({
        id: ctx.newId(),
        budget_id: budgetId,
        transaction_id: transactionId,
        category_id: s.categoryId.toLowerCase(),
        amount_cents: s.amountCents,
        created_at: now,
      })),
    )
    .execute();
}

/**
 * POST /budgets/{b}/transactions (J2). With `idempotency`, a retry with the
 * same key and request returns the current state (replayed: true), loaded
 * through this scope (a since-deleted transaction -> NOT_FOUND); the same key
 * with another request -> IDEMPOTENCY_KEY_REUSED.
 */
export async function createTransaction(
  ctx: Ctx,
  scope: BudgetScope,
  input: TransactionInput,
  options: { idempotency?: IdempotencyInput } = {},
): Promise<CreateResult<TransactionRecord>> {
  assertBudgetScope(scope);
  validateShape(input);
  const id = ctx.newId();
  const replayId = await withTx(ctx, async (tx) => {
    if (options.idempotency) {
      if (options.idempotency.userId !== scope.userId)
        throw new TypeError("idempotency.userId must be the caller");
      const existing = await claimIdempotencyKey(
        tx,
        options.idempotency,
        "transaction",
        id,
      );
      if (existing) return existing;
    }
    await validateAgainstBudget(tx, scope.budgetId, input);
    const now = tx.clock();
    await tx.db
      .insertInto("transactions")
      .values({
        id,
        budget_id: scope.budgetId,
        date: input.date,
        direction: input.direction,
        amount_cents: input.amountCents,
        payee: input.payee ?? null,
        memo: input.memo ?? null,
        created_by_user_id: scope.userId,
        updated_by_user_id: scope.userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await insertSplits(tx, scope.budgetId, id, input.splits, now);
    return null;
  });
  if (replayId)
    return {
      replayed: true,
      value: await getTransaction(ctx, scope, replayId),
    };
  return { replayed: false, value: await getTransaction(ctx, scope, id) };
}

/** PUT /budgets/{b}/transactions/{t}: full replace including splits, optimistic version. */
export async function replaceTransaction(
  ctx: Ctx,
  scope: BudgetScope,
  transactionId: string,
  input: ReplaceTransactionInput,
): Promise<TransactionRecord> {
  assertBudgetScope(scope);
  validateShape(input);
  if (!isUuid(transactionId)) throw notFound();
  return withTx(ctx, async (tx) => {
    const current = await tx.db
      .selectFrom("transactions")
      .select(["version"])
      .where("budget_id", "=", scope.budgetId)
      .where("id", "=", transactionId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw notFound();
    const existing = await tx.db
      .selectFrom("transaction_splits")
      .select("category_id")
      .where("budget_id", "=", scope.budgetId)
      .where("transaction_id", "=", transactionId)
      .execute();
    await validateAgainstBudget(
      tx,
      scope.budgetId,
      input,
      new Set(existing.map((s) => s.category_id)),
      () => {
        if (current.version !== input.version) throw versionConflict();
      },
    );
    const now = tx.clock();
    await tx.db
      .updateTable("transactions")
      .set({
        date: input.date,
        direction: input.direction,
        amount_cents: input.amountCents,
        payee: input.payee ?? null,
        memo: input.memo ?? null,
        updated_by_user_id: scope.userId,
        updated_at: now,
      })
      .where("budget_id", "=", scope.budgetId)
      .where("id", "=", transactionId)
      .where("version", "=", input.version)
      .execute();
    await tx.db
      .deleteFrom("transaction_splits")
      .where("budget_id", "=", scope.budgetId)
      .where("transaction_id", "=", transactionId)
      .execute();
    await insertSplits(tx, scope.budgetId, transactionId, input.splits, now);
    return getTransaction(tx, scope, transactionId);
  });
}

/** DELETE /budgets/{b}/transactions/{t}?version=: soft delete, hidden at once, purged after 30 days. */
export async function deleteTransaction(
  ctx: Ctx,
  scope: BudgetScope,
  transactionId: string,
  version: number,
): Promise<void> {
  assertBudgetScope(scope);
  if (!isUuid(transactionId)) throw notFound();
  await withTx(ctx, async (tx) => {
    const current = await tx.db
      .selectFrom("transactions")
      .select(["version"])
      .where("budget_id", "=", scope.budgetId)
      .where("id", "=", transactionId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw notFound();
    if (current.version !== version) throw versionConflict();
    const now = tx.clock();
    await tx.db
      .updateTable("transactions")
      .set({
        deleted_at: now,
        updated_at: now,
        updated_by_user_id: scope.userId,
      })
      .where("budget_id", "=", scope.budgetId)
      .where("id", "=", transactionId)
      .execute();
  });
}

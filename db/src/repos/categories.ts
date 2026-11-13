// Categories (ADR-0004): members create, rename, reorder, archive and delete
// unused ones. kind is immutable (DB trigger).
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { withTx } from "../context.ts";
import {
  DalError,
  isForeignKeyViolation,
  isUniqueViolation,
  limitReached,
  notFound,
  versionConflict,
} from "../errors.ts";
import type { CategoryRecord } from "../records.ts";
import type { CategoryKind } from "../schema.ts";
import type { BudgetScope } from "../scope.ts";
import { assertBudgetScope, isUuid, lockBudget } from "../scope.ts";
import { LIMITS } from "./common.ts";

const duplicateName = (): DalError =>
  new DalError("ALREADY_EXISTS", {
    details: [{ in: "body", field: "name", issue: "duplicate" }],
  });

interface CategoryRow {
  id: string;
  budget_id: string;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const COLUMNS = [
  "id",
  "budget_id",
  "name",
  "kind",
  "sort_order",
  "archived_at",
  "created_at",
  "updated_at",
  "version",
] as const;

function toRecord(r: CategoryRow): CategoryRecord {
  return {
    id: r.id,
    budgetId: r.budget_id,
    name: r.name,
    kind: r.kind,
    sortOrder: r.sort_order,
    archived: r.archived_at !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

/** GET /budgets/{b}/categories: expense first, then sortOrder, then name. */
export async function listCategories(
  ctx: Ctx,
  scope: BudgetScope,
): Promise<CategoryRecord[]> {
  assertBudgetScope(scope);
  const rows = await ctx.db
    .selectFrom("categories")
    .select(COLUMNS)
    .where("budget_id", "=", scope.budgetId)
    .orderBy("kind")
    .orderBy("sort_order")
    .orderBy(sql`lower(name)`)
    .orderBy("id")
    .execute();
  return rows.map(toRecord);
}

export async function getCategory(
  ctx: Ctx,
  scope: BudgetScope,
  categoryId: string,
): Promise<CategoryRecord> {
  assertBudgetScope(scope);
  if (!isUuid(categoryId)) throw notFound();
  const row = await ctx.db
    .selectFrom("categories")
    .select(COLUMNS)
    .where("budget_id", "=", scope.budgetId)
    .where("id", "=", categoryId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return toRecord(row);
}

export interface CreateCategoryInput {
  name: string;
  kind: CategoryKind;
  /** Default: after the last category. */
  sortOrder?: number | undefined;
}

/** POST /budgets/{b}/categories. ALREADY_EXISTS (name), LIMIT_REACHED (100). */
export async function createCategory(
  ctx: Ctx,
  scope: BudgetScope,
  input: CreateCategoryInput,
): Promise<CategoryRecord> {
  return withTx(ctx, async (tx) => {
    await lockBudget(tx, scope); // serializes the count check per budget
    const stats = await tx.db
      .selectFrom("categories")
      .select([
        sql<number>`count(*)::int`.as("n"),
        sql<number | null>`max(sort_order)`.as("max_sort"),
      ])
      .where("budget_id", "=", scope.budgetId)
      .executeTakeFirstOrThrow();
    if (stats.n >= LIMITS.categoriesPerBudget) throw limitReached();
    const clash = await tx.db
      .selectFrom("categories")
      .select("id")
      .where("budget_id", "=", scope.budgetId)
      .where(sql<boolean>`lower(name) = lower(${input.name})`)
      .executeTakeFirst();
    if (clash) throw duplicateName();
    const now = tx.clock();
    const sortOrder =
      input.sortOrder ?? Math.min((stats.max_sort ?? -1) + 1, 10_000);
    try {
      const row = await tx.db
        .insertInto("categories")
        .values({
          id: tx.newId(),
          budget_id: scope.budgetId,
          name: input.name,
          kind: input.kind,
          sort_order: sortOrder,
          created_at: now,
          updated_at: now,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (e) {
      if (isUniqueViolation(e, "categories_budget_name_key"))
        throw duplicateName();
      throw e;
    }
  });
}

export interface UpdateCategoryInput {
  name?: string | undefined;
  sortOrder?: number | undefined;
  archived?: boolean | undefined;
  version: number;
}

/** PATCH /budgets/{b}/categories/{c}: rename, reorder, archive or unarchive. */
export async function updateCategory(
  ctx: Ctx,
  scope: BudgetScope,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<CategoryRecord> {
  assertBudgetScope(scope);
  return withTx(ctx, async (tx) => {
    const current = await getCategory(tx, scope, categoryId);
    if (current.version !== input.version) throw versionConflict();
    if (
      input.name !== undefined &&
      input.name.toLowerCase() !== current.name.toLowerCase()
    ) {
      const clash = await tx.db
        .selectFrom("categories")
        .select("id")
        .where("budget_id", "=", scope.budgetId)
        .where("id", "<>", categoryId)
        .where(sql<boolean>`lower(name) = lower(${input.name})`)
        .executeTakeFirst();
      if (clash) throw duplicateName();
    }
    const now = tx.clock();
    let archivedAt: Date | null | undefined;
    if (input.archived === true)
      archivedAt = current.archived ? undefined : now;
    if (input.archived === false) archivedAt = null;
    try {
      const row = await tx.db
        .updateTable("categories")
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sortOrder !== undefined
            ? { sort_order: input.sortOrder }
            : {}),
          ...(archivedAt !== undefined ? { archived_at: archivedAt } : {}),
          updated_at: now,
        })
        .where("budget_id", "=", scope.budgetId)
        .where("id", "=", categoryId)
        .where("version", "=", input.version)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (!row) throw versionConflict();
      return toRecord(row);
    } catch (e) {
      if (isUniqueViolation(e, "categories_budget_name_key"))
        throw duplicateName();
      throw e;
    }
  });
}

/**
 * DELETE /budgets/{b}/categories/{c}?version=: hard delete of an unused
 * category (its plan entries go with it). CATEGORY_IN_USE if any split,
 * including one on a soft-deleted transaction, references it.
 */
export async function deleteCategory(
  ctx: Ctx,
  scope: BudgetScope,
  categoryId: string,
  version: number,
): Promise<void> {
  assertBudgetScope(scope);
  await withTx(ctx, async (tx) => {
    const current = await getCategory(tx, scope, categoryId);
    if (current.version !== version) throw versionConflict();
    const used = await tx.db
      .selectFrom("transaction_splits")
      .select("id")
      .where("budget_id", "=", scope.budgetId)
      .where("category_id", "=", categoryId)
      .limit(1)
      .executeTakeFirst();
    if (used) throw new DalError("CATEGORY_IN_USE");
    try {
      // The split FK is deferred (budget cascades); check it now for a direct delete.
      await sql`set constraints transaction_splits_category_fkey immediate`.execute(
        tx.db,
      );
      const res = await tx.db
        .deleteFrom("categories")
        .where("budget_id", "=", scope.budgetId)
        .where("id", "=", categoryId)
        .where("version", "=", version)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw versionConflict();
    } catch (e) {
      if (isForeignKeyViolation(e, "transaction_splits_category_fkey"))
        throw new DalError("CATEGORY_IN_USE");
      throw e;
    }
  });
}

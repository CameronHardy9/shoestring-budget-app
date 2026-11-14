// Categories, monthly plans, the month summary and transactions (members and
// owners alike; ADR-0004, ADR-0005, ADR-0006).
import type { BudgetScope } from "@shoestring/db";
import type { AppDeps } from "../deps.ts";
import { transactionDateIssue } from "../domain/calendar.ts";
import { idempotencyRequestHash } from "../domain/idempotency.ts";
import { fieldError, validationFailed } from "../errors.ts";
import {
  toCategory,
  toMonthPlan,
  toMonthSummary,
  toPlanCopyResult,
  toPlanEntry,
  toTransaction,
} from "../http/mappers.ts";
import { defineRoute } from "../http/routes.ts";
import {
  BudgetParams,
  CategoryCreate,
  CategoryListQuery,
  CategoryParams,
  CategoryUpdate,
  MonthParams,
  PlanCopyRequest,
  PlanEntryParams,
  PlanEntryPut,
  TransactionCreate,
  TransactionListQuery,
  TransactionParams,
  TransactionReplace,
  VersionQuery,
} from "../http/schemas.ts";
import { mustScope } from "./common.ts";

/** Transaction dates: 2000-01-01 to one year after today in the budget timezone (ADR-0005). */
async function assertTransactionDate(
  deps: AppDeps,
  scope: BudgetScope,
  date: string,
): Promise<void> {
  const budget = await deps.dal.budgets.getBudget(scope);
  const issue = transactionDateIssue(date, deps.clock.now(), budget.timezone);
  if (issue) throw validationFailed([fieldError("body", "date", issue)]);
}

export const categoryRoutes = [
  defineRoute({
    operationId: "listCategories",
    params: BudgetParams,
    query: CategoryListQuery,
    handler: async ({ deps, scope, query }) => {
      const all = await deps.dal.categories.listCategories(mustScope(scope));
      const items =
        query.includeArchived === true ? all : all.filter((c) => !c.archived);
      return { status: 200, body: { items: items.map(toCategory) } };
    },
  }),
  defineRoute({
    operationId: "createCategory",
    params: BudgetParams,
    body: CategoryCreate,
    handler: async ({ deps, scope, body }) => ({
      status: 201,
      body: toCategory(
        await deps.dal.categories.createCategory(mustScope(scope), body),
      ),
    }),
  }),
  defineRoute({
    operationId: "updateCategory",
    params: CategoryParams,
    body: CategoryUpdate,
    handler: async ({ deps, scope, params, body }) => ({
      status: 200,
      body: toCategory(
        await deps.dal.categories.updateCategory(
          mustScope(scope),
          params.categoryId,
          body,
        ),
      ),
    }),
  }),
  defineRoute({
    operationId: "deleteCategory",
    params: CategoryParams,
    query: VersionQuery,
    handler: async ({ deps, scope, params, query }) => {
      await deps.dal.categories.deleteCategory(
        mustScope(scope),
        params.categoryId,
        query.version,
      );
      return { status: 204 };
    },
  }),
];

export const planRoutes = [
  defineRoute({
    operationId: "getMonthPlan",
    params: MonthParams,
    handler: async ({ deps, scope, params }) => ({
      status: 200,
      body: toMonthPlan(
        await deps.dal.plans.getMonthPlan(mustScope(scope), params.month),
      ),
    }),
  }),
  defineRoute({
    operationId: "putPlanEntry",
    params: PlanEntryParams,
    body: PlanEntryPut,
    handler: async ({ deps, scope, params, body }) => {
      const entry = await deps.dal.plans.putPlanEntry(
        mustScope(scope),
        params.month,
        params.categoryId,
        body,
      );
      return {
        status: body.version === null ? 201 : 200,
        body: toPlanEntry(entry),
      };
    },
  }),
  defineRoute({
    operationId: "copyPreviousMonthPlan",
    params: MonthParams,
    body: PlanCopyRequest,
    handler: async ({ deps, scope, params, body }) => ({
      status: 200,
      body: toPlanCopyResult(
        await deps.dal.plans.copyPreviousMonthPlan(
          mustScope(scope),
          params.month,
          {
            overwrite: body.overwrite === true,
          },
        ),
      ),
    }),
  }),
  defineRoute({
    operationId: "getMonthSummary",
    params: MonthParams,
    handler: async ({ deps, scope, params }) => ({
      status: 200,
      body: toMonthSummary(
        await deps.dal.summary.getMonthSummary(mustScope(scope), params.month),
      ),
    }),
  }),
];

export const transactionRoutes = [
  defineRoute({
    operationId: "listTransactions",
    params: BudgetParams,
    query: TransactionListQuery,
    handler: async ({ deps, scope, query }) => {
      const s = mustScope(scope);
      const filters = { month: query.month, categoryId: query.categoryId };
      const after = query.cursor
        ? deps.cursors.decode(s.budgetId, filters, query.cursor)
        : undefined;
      const page = await deps.dal.transactions.listTransactions(s, {
        ...filters,
        limit: query.limit ?? 50,
        after,
      });
      return {
        status: 200,
        body: {
          items: page.items.map(toTransaction),
          nextCursor: page.next
            ? deps.cursors.encode(s.budgetId, filters, page.next)
            : null,
        },
      };
    },
  }),
  defineRoute({
    operationId: "createTransaction",
    params: BudgetParams,
    body: TransactionCreate,
    handler: async ({
      deps,
      scope,
      params,
      body,
      idempotencyKey,
      op,
      rawBody,
    }) => {
      const s = mustScope(scope);
      await assertTransactionDate(deps, s, body.date);
      const res = await deps.dal.transactions.createTransaction(s, body, {
        idempotency: {
          userId: s.userId,
          key: idempotencyKey ?? "",
          requestHash: idempotencyRequestHash("POST", op.path, params, rawBody),
        },
      });
      return {
        status: 201,
        body: toTransaction(res.value),
        headers: res.replayed ? { "idempotent-replayed": "true" } : {},
      };
    },
  }),
  defineRoute({
    operationId: "getTransaction",
    params: TransactionParams,
    handler: async ({ deps, scope, params }) => ({
      status: 200,
      body: toTransaction(
        await deps.dal.transactions.getTransaction(
          mustScope(scope),
          params.transactionId,
        ),
      ),
    }),
  }),
  defineRoute({
    operationId: "replaceTransaction",
    params: TransactionParams,
    body: TransactionReplace,
    handler: async ({ deps, scope, params, body }) => {
      const s = mustScope(scope);
      await assertTransactionDate(deps, s, body.date);
      return {
        status: 200,
        body: toTransaction(
          await deps.dal.transactions.replaceTransaction(
            s,
            params.transactionId,
            body,
          ),
        ),
      };
    },
  }),
  defineRoute({
    operationId: "deleteTransaction",
    params: TransactionParams,
    query: VersionQuery,
    handler: async ({ deps, scope, params, query }) => {
      await deps.dal.transactions.deleteTransaction(
        mustScope(scope),
        params.transactionId,
        query.version,
      );
      return { status: 204 };
    },
  }),
];

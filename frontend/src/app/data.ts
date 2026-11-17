// Reads and writes for the core flow, all through api + unwrap(). Cached in
// memory by TanStack Query; every transaction write invalidates the budget's
// summaries and lists, so totals are re-read from the server (J3: numbers come
// only from GET …/summary).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api, unwrap } from "../api/client.ts";
import type { Schemas, TransactionCreate } from "../api/types.ts";

export const keys = {
  budgets: ["budgets"] as const,
  budget: (id: string) => ["budget", id] as const,
  categories: (id: string) => ["budget", id, "categories"] as const,
  summary: (id: string, month: string) =>
    ["budget", id, "summary", month] as const,
  transactions: (id: string, filters: TransactionFilters) =>
    ["budget", id, "transactions", filters] as const,
  allTransactions: (id: string) => ["budget", id, "transactions"] as const,
  mfa: ["me", "mfa"] as const,
};

export interface TransactionFilters {
  month: string;
  categoryId: string | null;
}

export function useBudgets() {
  return useQuery({
    queryKey: keys.budgets,
    queryFn: () => unwrap(api.GET("/budgets")),
  });
}

export function useBudget(budgetId: string) {
  return useQuery({
    queryKey: keys.budget(budgetId),
    queryFn: () =>
      unwrap(
        api.GET("/budgets/{budgetId}", { params: { path: { budgetId } } }),
      ),
  });
}

export function useCategories(budgetId: string) {
  return useQuery({
    queryKey: keys.categories(budgetId),
    queryFn: () =>
      unwrap(
        // Archived too: transactions keep showing their category's name;
        // pickers filter archived ones out (orderCategories).
        api.GET("/budgets/{budgetId}/categories", {
          params: { path: { budgetId }, query: { includeArchived: true } },
        }),
      ),
  });
}

export function useSummary(budgetId: string, month: string) {
  return useQuery({
    queryKey: keys.summary(budgetId, month),
    queryFn: () =>
      unwrap(
        api.GET("/budgets/{budgetId}/months/{month}/summary", {
          params: { path: { budgetId, month } },
        }),
      ),
  });
}

export const PAGE_SIZE = 50;

export function useTransactions(
  budgetId: string,
  filters: TransactionFilters,
  limit = PAGE_SIZE,
  /** False until the filters are known (quick-add opened before the budget loaded). */
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...keys.transactions(budgetId, filters), limit],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/budgets/{budgetId}/transactions", {
          params: {
            path: { budgetId },
            query: {
              month: filters.month,
              limit,
              ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function getTransaction(budgetId: string, transactionId: string) {
  return unwrap(
    api.GET("/budgets/{budgetId}/transactions/{transactionId}", {
      params: { path: { budgetId, transactionId } },
    }),
  );
}

/** Everything a transaction write can change. */
export function invalidateBudgetActivity(
  client: QueryClient,
  budgetId: string,
): Promise<void> {
  return client.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "budget" &&
      q.queryKey[1] === budgetId &&
      (q.queryKey[2] === "summary" || q.queryKey[2] === "transactions"),
  });
}

export function useCreateTransaction(budgetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      idempotencyKey,
    }: {
      body: TransactionCreate;
      idempotencyKey: string;
    }) =>
      unwrap(
        api.POST("/budgets/{budgetId}/transactions", {
          params: {
            path: { budgetId },
            header: { "Idempotency-Key": idempotencyKey },
          },
          body,
        }),
      ),
    onSuccess: () => invalidateBudgetActivity(client, budgetId),
  });
}

export function useReplaceTransaction(budgetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      transactionId,
      body,
    }: {
      transactionId: string;
      body: Schemas["TransactionReplace"];
    }) =>
      unwrap(
        api.PUT("/budgets/{budgetId}/transactions/{transactionId}", {
          params: { path: { budgetId, transactionId } },
          body,
        }),
      ),
    onSuccess: () => invalidateBudgetActivity(client, budgetId),
  });
}

export function useDeleteTransaction(budgetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      transactionId,
      version,
    }: {
      transactionId: string;
      version: number;
    }) =>
      unwrap(
        api.DELETE("/budgets/{budgetId}/transactions/{transactionId}", {
          params: { path: { budgetId, transactionId }, query: { version } },
        }),
      ),
    onSuccess: () => invalidateBudgetActivity(client, budgetId),
  });
}

// ---------------------------------------------------------------- Phase 2b

export const moreKeys = {
  plan: (id: string, month: string) => ["budget", id, "plan", month] as const,
  members: (id: string) => ["budget", id, "members"] as const,
  budgetInvitations: (id: string) => ["budget", id, "invitations"] as const,
  myInvitations: ["me", "invitations"] as const,
  sessions: ["me", "sessions"] as const,
  deletedBudgets: ["me", "deleted-budgets"] as const,
};

/** Everything cached for one budget (after plan, category or membership changes). */
export function invalidateBudget(
  client: QueryClient,
  budgetId: string,
): Promise<void> {
  return client.invalidateQueries({
    predicate: (q) =>
      (q.queryKey[0] === "budget" && q.queryKey[1] === budgetId) ||
      q.queryKey[0] === "budgets",
  });
}

export function usePlan(budgetId: string, month: string) {
  return useQuery({
    queryKey: moreKeys.plan(budgetId, month),
    queryFn: () =>
      unwrap(
        api.GET("/budgets/{budgetId}/months/{month}/plan", {
          params: { path: { budgetId, month } },
        }),
      ),
  });
}

export function useMembers(budgetId: string) {
  return useQuery({
    queryKey: moreKeys.members(budgetId),
    queryFn: () =>
      unwrap(
        api.GET("/budgets/{budgetId}/members", {
          params: { path: { budgetId } },
        }),
      ),
  });
}

export function useBudgetInvitations(budgetId: string, enabled: boolean) {
  return useQuery({
    queryKey: moreKeys.budgetInvitations(budgetId),
    enabled,
    queryFn: () =>
      unwrap(
        api.GET("/budgets/{budgetId}/invitations", {
          params: { path: { budgetId } },
        }),
      ),
  });
}

export function useMyInvitations() {
  return useQuery({
    queryKey: moreKeys.myInvitations,
    queryFn: () => unwrap(api.GET("/me/invitations")),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: moreKeys.sessions,
    queryFn: () => unwrap(api.GET("/me/sessions")),
  });
}

export function useDeletedBudgets() {
  return useQuery({
    queryKey: moreKeys.deletedBudgets,
    queryFn: () => unwrap(api.GET("/me/deleted-budgets")),
  });
}

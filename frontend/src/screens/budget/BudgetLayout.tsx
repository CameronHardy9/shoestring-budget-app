// Frame for every /budgets/{budgetId}/… screen: loads the budget (404 shows one
// "not found or no access" screen, auth.md §15), remembers it as the last-used
// budget, and owns the quick-add / edit sheet so "+" works on every tab.
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "../../api/errors.ts";
import type { Budget, Transaction } from "../../api/types.ts";
import { useMe } from "../../app/auth.tsx";
import {
  PAGE_SIZE,
  useBudget,
  useCategories,
  useTransactions,
} from "../../app/data.ts";
import { takeStashedDraft } from "../../app/draft-stash.ts";
import { AppShell, type NavId } from "../../components/AppShell.tsx";
import {
  ErrorState,
  LoadingState,
  OfflineState,
} from "../../components/States.tsx";
import { setLastBudgetId } from "../../lib/preferences.ts";
import { NotFoundScreen } from "../NotFoundScreen.tsx";
import { TransactionSheet, type SheetMode } from "./TransactionSheet.tsx";

interface BudgetContextValue {
  budget: Budget;
  openQuickAdd: () => void;
  openEdit: (t: Transaction) => void;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

export function useCurrentBudget(): BudgetContextValue {
  const value = useContext(BudgetContext);
  if (!value) throw new Error("useCurrentBudget outside BudgetLayout");
  return value;
}

export function BudgetLayout({
  budgetId,
  active,
  children,
}: {
  budgetId: string;
  active: NavId;
  children: ReactNode;
}) {
  const me = useMe();
  const budget = useBudget(budgetId);
  // Warm what quick-add needs so the sheet usually opens with its chips
  // ready: the categories, and this month's recent transactions that order
  // them (the sheet's own query and key, so it is one cached request). Neither
  // holds up the page; if the recent list fails, chips use the default order.
  useCategories(budgetId);
  useTransactions(
    budgetId,
    { month: budget.data?.currentMonth ?? "", categoryId: null },
    PAGE_SIZE,
    budget.data !== undefined,
  );
  const [mode, setMode] = useState<SheetMode | null>(() => {
    const draft = takeStashedDraft(budgetId, me.id);
    return draft ? { kind: "create", draft } : null;
  });

  const missing =
    budget.error instanceof ApiError && budget.error.code === "NOT_FOUND";
  useEffect(() => {
    if (budget.data) setLastBudgetId(budget.data.id);
    else if (missing) setLastBudgetId(null);
  }, [budget.data, missing]);

  if (missing) return <NotFoundScreen budgetMissing />;

  const shell = (content: ReactNode) => (
    <AppShell
      active={active}
      budgetId={budgetId}
      budgetName={budget.data?.name ?? null}
      // Never ignored: before the budget arrives the sheet opens anyway, with
      // the amount field ready, and shows its own loading or error state.
      onAdd={() => {
        setMode({ kind: "create" });
      }}
    >
      {content}
    </AppShell>
  );

  let page: ReactNode;
  if (budget.isPending) {
    page = shell(
      <div className="mx-auto max-w-5xl px-4 pt-6">
        {budget.isPaused ? (
          <OfflineState message="You're offline. This budget will appear when you reconnect." />
        ) : (
          <LoadingState label="Loading your budget…" />
        )}
      </div>,
    );
  } else if (budget.isError) {
    page = shell(
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <h1 className="mb-4 text-2xl font-semibold text-fg">Budget</h1>
        <ErrorState
          error={budget.error}
          onRetry={() => void budget.refetch()}
        />
      </div>,
    );
  } else {
    const value: BudgetContextValue = {
      budget: budget.data,
      openQuickAdd: () => {
        setMode({ kind: "create" });
      },
      openEdit: (transaction) => {
        setMode({ kind: "edit", transaction });
      },
    };
    page = (
      <BudgetContext.Provider value={value}>
        {/* A lazy screen suspends inside the shell. Without this the app's
            own boundary would hide the whole shell, and the tab bar would
            blink out and back (seen on the owner's iPhone, 2026-11-25). */}
        {shell(<Suspense fallback={<LoadingState />}>{children}</Suspense>)}
      </BudgetContext.Provider>
    );
  }

  // The sheet keeps its place in the tree whatever the page shows, so a sheet
  // opened while loading stays mounted (with what was typed, and focus) when
  // the budget arrives.
  return (
    <>
      {page}
      <TransactionSheet
        budgetId={budgetId}
        budget={budget.data}
        budgetError={budget.data ? null : budget.error}
        budgetPaused={budget.isPaused}
        onRetryBudget={() => void budget.refetch()}
        mode={mode}
        onClose={() => {
          setMode(null);
        }}
      />
    </>
  );
}

/** Month from ?month=YYYY-MM, else the budget's current month. */
export function monthFrom(search: URLSearchParams, budget: Budget): string {
  const month = search.get("month");
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= "2000-01"
    ? month
    : budget.currentMonth;
}

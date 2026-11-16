// Frame for every /budgets/{budgetId}/… screen: loads the budget (404 shows one
// "not found or no access" screen, auth.md §15), remembers it as the last-used
// budget, and owns the quick-add / edit sheet so "+" works on every tab.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "../../api/errors.ts";
import type { Budget, Transaction } from "../../api/types.ts";
import { useMe } from "../../app/auth.tsx";
import { useBudget, useCategories } from "../../app/data.ts";
import { takeStashedDraft } from "../../app/draft-stash.ts";
import { AppShell, type NavId } from "../../components/AppShell.tsx";
import { ErrorState, LoadingState } from "../../components/States.tsx";
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
  // Warm the categories cache so the sheet opens ready.
  useCategories(budgetId);
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
      onAdd={() => {
        if (budget.data) setMode({ kind: "create" });
      }}
    >
      {content}
    </AppShell>
  );

  if (budget.isPending) {
    return shell(
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <LoadingState label="Loading your budget…" />
      </div>,
    );
  }
  if (budget.isError) {
    return shell(
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <h1 className="mb-4 text-2xl font-semibold text-fg">Budget</h1>
        <ErrorState
          error={budget.error}
          onRetry={() => void budget.refetch()}
        />
      </div>,
    );
  }

  const value: BudgetContextValue = {
    budget: budget.data,
    openQuickAdd: () => {
      setMode({ kind: "create" });
    },
    openEdit: (transaction) => {
      setMode({ kind: "edit", transaction });
    },
  };
  return (
    <BudgetContext.Provider value={value}>
      {shell(children)}
      <TransactionSheet
        budget={budget.data}
        mode={mode}
        onClose={() => {
          setMode(null);
        }}
      />
    </BudgetContext.Provider>
  );
}

/** Month from ?month=YYYY-MM, else the budget's current month. */
export function monthFrom(search: URLSearchParams, budget: Budget): string {
  const month = search.get("month");
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= "2000-01"
    ? month
    : budget.currentMonth;
}

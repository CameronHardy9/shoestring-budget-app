// "/": go to the last-used budget if it is still one of mine, else the first
// budget, else onboarding.
import { useBudgets } from "../app/data.ts";
import { Redirect } from "../app/router.tsx";
import { ErrorState, PendingSlot } from "../components/States.tsx";
import { getLastBudgetId } from "../lib/preferences.ts";

export default function HomeScreen() {
  const budgets = useBudgets();
  if (budgets.isPending) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="sr-only">Shoestring</h1>
        <PendingSlot
          paused={budgets.isPaused}
          label="Loading your budgets…"
          offlineMessage="You're offline. Your budgets will appear when you reconnect."
        />
      </main>
    );
  }
  if (budgets.isError) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="mb-4 text-2xl font-semibold text-fg">Shoestring</h1>
        <ErrorState
          error={budgets.error}
          onRetry={() => void budgets.refetch()}
        />
      </main>
    );
  }
  const items = budgets.data.items;
  const last = getLastBudgetId();
  const target = items.find((b) => b.id === last) ?? items[0];
  return <Redirect to={target ? `/budgets/${target.id}` : "/budgets/new"} />;
}

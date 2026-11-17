// /settings/deleted-budgets (email link for budget_deleted, owner copy):
// budgets I own that were deleted in the last 30 days, with restore.
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { moreKeys, useDeletedBudgets } from "../../app/data.ts";
import { navigate } from "../../app/router.tsx";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { AppShell } from "../../components/AppShell.tsx";
import { Button } from "../../components/Button.tsx";
import { PageColumn } from "../../components/Section.tsx";
import {
  EmptyState,
  ErrorState,
  FormError,
  PendingSlot,
} from "../../components/States.tsx";
import { getLastBudgetId } from "../../lib/preferences.ts";

const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(iso),
  );

export default function DeletedBudgetsScreen() {
  const client = useQueryClient();
  const toast = useToast();
  const deleted = useDeletedBudgets();
  const action = useAction();
  const limit =
    action.error instanceof ApiError && action.error.code === "LIMIT_REACHED";
  return (
    <AppShell active="more" budgetId={getLastBudgetId()}>
      <PageColumn
        title="Deleted budgets"
        intro="Budgets you own can be restored for 30 days after deletion."
      >
        {limit ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft p-3 text-sm text-danger"
          >
            Restoring would put you, or one of its members, over the limit of
            budgets. Leave or delete another budget first.
          </p>
        ) : (
          <FormError error={action.error} />
        )}
        {deleted.isPending ? (
          <PendingSlot
            paused={deleted.isPaused}
            rows={2}
            offlineMessage="You're offline. Deleted budgets will appear when you reconnect."
          />
        ) : deleted.isError ? (
          <ErrorState
            error={deleted.error}
            onRetry={() => void deleted.refetch()}
          />
        ) : deleted.data.items.length === 0 ? (
          <EmptyState icon="trash" title="Nothing to restore">
            Budgets you delete stay here for 30 days.
          </EmptyState>
        ) : (
          <ul
            className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1"
            data-testid="deleted-budgets"
          >
            {deleted.data.items.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium text-fg">{b.name}</span>
                  <span className="text-sm text-fg-muted">
                    Deleted {day(b.deletedAt)} · restorable until{" "}
                    {day(b.restorableUntil)}
                    {b.memberCount > 1
                      ? ` · ${String(b.memberCount)} people`
                      : ""}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Restore ${b.name}`}
                  onPress={() =>
                    void action.run(async () => {
                      const budget = await unwrap(
                        api.POST(
                          "/me/deleted-budgets/{deletedBudgetId}/restore",
                          { params: { path: { deletedBudgetId: b.id } } },
                        ),
                      );
                      await client.invalidateQueries({
                        queryKey: moreKeys.deletedBudgets,
                      });
                      await client.invalidateQueries({ queryKey: ["budgets"] });
                      toast(`${budget.name} restored`);
                      navigate(`/budgets/${budget.id}`);
                    })
                  }
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PageColumn>
    </AppShell>
  );
}

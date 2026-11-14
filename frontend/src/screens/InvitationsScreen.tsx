// /invitations (task 11; email link for budget_invitation): pending budget
// invitations addressed to me. Accept joins and opens the budget; decline asks
// first.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { Schemas } from "../api/types.ts";
import { moreKeys, useMyInvitations } from "../app/data.ts";
import { navigate } from "../app/router.tsx";
import { useToast } from "../app/toast.tsx";
import { useAction } from "../app/useAction.ts";
import { AppShell } from "../components/AppShell.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { PageColumn } from "../components/Section.tsx";
import {
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
} from "../components/States.tsx";
import { getLastBudgetId } from "../lib/preferences.ts";

type Invitation = Schemas["MyInvitation"];

export default function InvitationsScreen() {
  const client = useQueryClient();
  const toast = useToast();
  const invitations = useMyInvitations();
  const [declining, setDeclining] = useState<Invitation | null>(null);
  const action = useAction();
  const refresh = () =>
    client.invalidateQueries({ queryKey: moreKeys.myInvitations });

  const accept = (inv: Invitation) =>
    void action.run(async () => {
      try {
        const budget = await unwrap(
          api.POST("/me/invitations/{invitationId}/accept", {
            params: { path: { invitationId: inv.id } },
          }),
        );
        await client.invalidateQueries({ queryKey: ["budgets"] });
        toast(`You joined ${budget.name}`);
        navigate(`/budgets/${budget.id}`);
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.code === "INVITATION_INVALID" || e.code === "NOT_FOUND")
        )
          await refresh();
        throw e;
      }
    });

  const limit =
    action.error instanceof ApiError && action.error.code === "LIMIT_REACHED";
  return (
    <AppShell active="more" budgetId={getLastBudgetId()}>
      <PageColumn
        title="Invitations"
        intro="Budgets other people have invited you to share."
      >
        {limit ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft p-3 text-sm text-danger"
          >
            You're in 10 budgets already, or that budget is full. Leave a budget
            first, or ask the owner.
          </p>
        ) : (
          <FormError error={declining ? null : action.error} />
        )}
        {invitations.isPending ? (
          <LoadingState rows={2} />
        ) : invitations.isError ? (
          <ErrorState
            error={invitations.error}
            onRetry={() => void invitations.refetch()}
          />
        ) : invitations.data.items.length === 0 ? (
          <EmptyState icon="user" title="No invitations">
            When someone invites you to their budget, it shows up here.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="my-invitations">
            {invitations.data.items.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-1"
              >
                <div>
                  <p className="text-lg font-semibold text-fg">
                    {inv.budgetName}
                  </p>
                  <p className="text-sm text-fg-muted">
                    {inv.invitedByDisplayName
                      ? `From ${inv.invitedByDisplayName} · `
                      : ""}
                    expires{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(inv.expiresAt))}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    aria-label={`Decline invitation to ${inv.budgetName}`}
                    onPress={() => {
                      action.setError(null);
                      setDeclining(inv);
                    }}
                  >
                    Decline
                  </Button>
                  <Button
                    className="flex-1"
                    aria-label={`Accept invitation to ${inv.budgetName}`}
                    isPending={action.busy}
                    onPress={() => {
                      accept(inv);
                    }}
                  >
                    Accept
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageColumn>
      <ConfirmDialog
        isOpen={declining !== null}
        title={`Decline ${declining?.budgetName ?? ""}?`}
        confirmLabel="Decline"
        busy={action.busy}
        error={action.error}
        onCancel={() => {
          setDeclining(null);
        }}
        onConfirm={() =>
          void action.run(async () => {
            if (!declining) return;
            await unwrap(
              api.POST("/me/invitations/{invitationId}/decline", {
                params: { path: { invitationId: declining.id } },
              }),
            );
            setDeclining(null);
            await refresh();
            toast("Invitation declined");
          })
        }
      >
        The owner can invite you again later.
      </ConfirmDialog>
    </AppShell>
  );
}

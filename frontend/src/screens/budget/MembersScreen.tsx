// /budgets/{budgetId}/members (task 11, J6; email link for
// invitation_accepted and ownership_transferred). Everyone sees the members.
// The owner invites (re-auth), revokes invitations, removes members, transfers
// ownership (re-auth), renames the budget or changes its time zone, and deletes
// it (re-auth; restorable for 30 days). A member can leave. The server enforces
// every rule; the screen only offers what the role allows.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import type { Schemas } from "../../api/types.ts";
import { useMe } from "../../app/auth.tsx";
import {
  invalidateBudget,
  moreKeys,
  useBudgetInvitations,
  useMembers,
} from "../../app/data.ts";
import { useReauth } from "../../app/reauth.tsx";
import { navigate } from "../../app/router.tsx";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Section } from "../../components/Section.tsx";
import {
  ErrorState,
  FormError,
  PendingSlot,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { setLastBudgetId } from "../../lib/preferences.ts";
import { useCurrentBudget } from "./BudgetLayout.tsx";

type Member = Schemas["Member"];
type Pending =
  | { kind: "remove" | "transfer"; member: Member }
  | { kind: "leave" }
  | { kind: "delete" }
  | null;

const date = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(iso),
  );

const STATUS_LABEL: Record<Schemas["Invitation"]["status"], string> = {
  pending: "Waiting",
  accepted: "Accepted",
  declined: "Declined",
  revoked: "Revoked",
  expired: "Expired",
};

const INVITE_COPY = {
  already_member: "This person is already a member.",
  invitation_pending: "An invitation is already waiting for this email.",
  duplicate: "An invitation is already waiting for this email.",
};

function timezones(current: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return all.includes(current) ? all : [current, ...all];
}

function InviteForm({ budgetId }: { budgetId: string }) {
  const client = useQueryClient();
  const reauth = useReauth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const action = useAction();
  const fields =
    action.error instanceof ApiError
      ? mapFieldErrors(action.error.details, ["email"], INVITE_COPY).fields
      : {};
  const limit =
    action.error instanceof ApiError && action.error.code === "LIMIT_REACHED";
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await reauth(() =>
            unwrap(
              api.POST("/budgets/{budgetId}/invitations", {
                params: { path: { budgetId } },
                body: { email: email.trim() },
              }),
            ),
          );
          setEmail("");
          await client.invalidateQueries({
            queryKey: moreKeys.budgetInvitations(budgetId),
          });
          toast("Invitation sent");
        });
      }}
    >
      <TextField
        label="Invite by email"
        description="They'll find it under Invitations after signing in. Shoestring is invite-only: someone without an account needs a sign-up invite from the app's owner first."
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        value={email}
        onChange={setEmail}
        errorMessage={fields.email}
      />
      {limit ? (
        <p role="alert" className="text-sm text-danger">
          A budget can have 6 people and 10 open invitations. Revoke an
          invitation or remove someone first.
        </p>
      ) : (
        <FormError
          error={Object.keys(fields).length > 0 ? null : action.error}
        />
      )}
      <Button
        type="submit"
        className="self-start"
        isPending={action.busy}
        data-testid="send-invitation"
      >
        Send invitation
      </Button>
    </form>
  );
}

function Invitations({ budgetId }: { budgetId: string }) {
  const client = useQueryClient();
  const invitations = useBudgetInvitations(budgetId, true);
  const action = useAction();
  // Rendered only once the sections below are shown (MembersScreen), so a
  // pending list here is paused offline or resuming after a reconnect.
  if (invitations.isPending)
    return (
      <PendingSlot
        paused={invitations.isPaused}
        rowsBelowShown
        offlineMessage="You're offline. Invitations will appear when you reconnect."
      />
    );
  if (invitations.isError)
    return (
      <ErrorState
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
      />
    );
  const items = invitations.data.items;
  if (items.length === 0)
    return <p className="text-sm text-fg-muted">No invitations yet.</p>;
  return (
    <>
      <FormError error={action.error} />
      <ul className="divide-y divide-line">
        {items.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-fg">{inv.email}</span>
              <span className="text-sm text-fg-muted">
                {inv.status === "pending"
                  ? `Waiting · expires ${date(inv.expiresAt)}`
                  : STATUS_LABEL[inv.status]}
              </span>
            </span>
            {inv.status === "pending" ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Revoke invitation for ${inv.email}`}
                onPress={() =>
                  void action.run(async () => {
                    await unwrap(
                      api.DELETE(
                        "/budgets/{budgetId}/invitations/{invitationId}",
                        {
                          params: { path: { budgetId, invitationId: inv.id } },
                        },
                      ),
                    );
                    await client.invalidateQueries({
                      queryKey: moreKeys.budgetInvitations(budgetId),
                    });
                  })
                }
              >
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function BudgetDetails({ budget }: { budget: Schemas["Budget"] }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(budget.name);
  const [timezone, setTimezone] = useState(budget.timezone);
  const action = useAction();
  const conflict =
    action.error instanceof ApiError &&
    action.error.code === "VERSION_CONFLICT";
  const changed = name.trim() !== budget.name || timezone !== budget.timezone;
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed || name.trim() === "") return;
        void action.run(async () => {
          await unwrap(
            api.PATCH("/budgets/{budgetId}", {
              params: { path: { budgetId: budget.id } },
              body: {
                version: budget.version,
                ...(name.trim() !== budget.name ? { name: name.trim() } : {}),
                ...(timezone !== budget.timezone ? { timezone } : {}),
              },
            }),
          );
          await invalidateBudget(client, budget.id);
          toast("Budget updated");
        });
      }}
    >
      <TextField
        label="Budget name"
        maxLength={60}
        value={name}
        onChange={setName}
      />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
        Time zone
        <select
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
          }}
          className="min-h-touch rounded-md border border-line-strong bg-surface px-3 text-base text-fg"
        >
          {timezones(budget.timezone).map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="font-normal text-fg-muted">
          Decides when "today" and each month start, for everyone.
        </span>
      </label>
      {conflict ? (
        <p role="alert" className="text-sm text-fg">
          Someone changed the budget just now. The latest is loaded; save again
          if you still want this change.
        </p>
      ) : (
        <FormError error={action.error} />
      )}
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        isDisabled={!changed}
        isPending={action.busy}
      >
        Save changes
      </Button>
    </form>
  );
}

export default function MembersScreen() {
  const { budget } = useCurrentBudget();
  const me = useMe();
  const client = useQueryClient();
  const reauth = useReauth();
  const toast = useToast();
  const members = useMembers(budget.id);
  const [pending, setPending] = useState<Pending>(null);
  const action = useAction();
  const isOwner = budget.myRole === "owner";
  // Same query as <Invitations>; read here only to know when it has settled.
  const invitations = useBudgetInvitations(budget.id, isOwner);
  // The sections below the member list (and, for the owner, below the
  // invitation list) appear only once both lists have their final length, so
  // the invite field, rename and Delete never move under a finger. A read
  // paused offline (nothing cached) counts as settled, or they'd never appear.
  // Latched, so they stay while a paused read resumes after a reconnect.
  const [settled, setSettled] = useState(false);
  const listSettled = (q: { isPending: boolean; isPaused: boolean }) =>
    !q.isPending || q.isPaused;
  if (
    !settled &&
    listSettled(members) &&
    (!isOwner || listSettled(invitations))
  )
    setSettled(true);

  const leaveBudget = async () => {
    setLastBudgetId(null);
    await client.invalidateQueries({ queryKey: ["budgets"] });
    navigate("/", { replace: true });
  };

  const confirm = () =>
    void action.run(async () => {
      if (!pending) return;
      if (pending.kind === "remove") {
        await unwrap(
          api.DELETE("/budgets/{budgetId}/members/{userId}", {
            params: {
              path: { budgetId: budget.id, userId: pending.member.userId },
            },
          }),
        );
        await invalidateBudget(client, budget.id);
        toast(`Removed ${pending.member.displayName}`);
      } else if (pending.kind === "transfer") {
        await reauth(() =>
          unwrap(
            api.POST("/budgets/{budgetId}/transfer-ownership", {
              params: { path: { budgetId: budget.id } },
              body: { userId: pending.member.userId },
            }),
          ),
        );
        await invalidateBudget(client, budget.id);
        toast(`${pending.member.displayName} is now the owner`);
      } else if (pending.kind === "leave") {
        await unwrap(
          api.DELETE("/budgets/{budgetId}/members/{userId}", {
            params: { path: { budgetId: budget.id, userId: me.id } },
          }),
        );
        toast(`You left ${budget.name}`);
        await leaveBudget();
      } else {
        await reauth(() =>
          unwrap(
            api.DELETE("/budgets/{budgetId}", {
              params: {
                path: { budgetId: budget.id },
                query: { version: budget.version },
              },
            }),
          ),
        );
        toast(
          `${budget.name} deleted. You can restore it for 30 days from Settings.`,
        );
        await leaveBudget();
      }
      setPending(null);
    });

  const dialog = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "remove":
        return {
          title: `Remove ${pending.member.displayName}?`,
          label: "Remove",
          body: `They lose access to ${budget.name} straight away and are emailed. Their past transactions stay.`,
        };
      case "transfer":
        return {
          title: `Make ${pending.member.displayName} the owner?`,
          label: "Transfer ownership",
          body: "This takes effect at once and everyone is emailed. You stay a member, and only the new owner can invite, remove, rename or delete.",
        };
      case "leave":
        return {
          title: `Leave ${budget.name}?`,
          label: "Leave",
          body: "You'll lose access until the owner invites you again.",
        };
      case "delete":
        return {
          title: `Delete ${budget.name}?`,
          label: "Delete budget",
          body: "Every member loses access and is emailed. You can restore it from Settings › Deleted budgets for 30 days; after that it's gone for good.",
        };
    }
  })();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-6 lg:px-8 lg:pt-8">
      <div>
        <p className="text-sm font-medium text-fg-muted">{budget.name}</p>
        <h1 className="text-2xl font-semibold text-fg">
          Members &amp; settings
        </h1>
      </div>
      <Section title="Members" id="members-heading">
        {members.isPending ? (
          <PendingSlot
            paused={members.isPaused}
            rowsBelowShown={settled}
            offlineMessage="You're offline. Members will appear when you reconnect."
          />
        ) : members.isError ? (
          <ErrorState
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="member-list">
            {members.data.items.map((m) => {
              const isMe = m.userId === me.id;
              return (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium text-fg">
                      {m.displayName}
                      {isMe ? " (you)" : ""}
                    </span>
                    <span className="text-sm text-fg-muted">
                      {m.role === "owner" ? "Owner" : "Member"} · joined{" "}
                      {date(m.joinedAt)}
                    </span>
                  </span>
                  {isOwner && !isMe ? (
                    <span className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={() => {
                          setPending({ kind: "transfer", member: m });
                        }}
                      >
                        Make owner
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={() => {
                          setPending({ kind: "remove", member: m });
                        }}
                      >
                        Remove
                      </Button>
                    </span>
                  ) : null}
                  {!isOwner && isMe ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => {
                        setPending({ kind: "leave" });
                      }}
                      data-testid="leave-budget"
                    >
                      Leave
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {isOwner ? (
          <p className="text-sm text-fg-muted">
            To leave this budget, first make someone else the owner.
          </p>
        ) : (
          <p className="text-sm text-fg-muted">
            Only the owner can invite or remove people.
          </p>
        )}
      </Section>

      {!settled ? null : isOwner ? (
        <>
          <Section title="Invite someone" id="invite-heading">
            <InviteForm budgetId={budget.id} />
            <h3 className="pt-2 text-sm font-semibold text-fg">Invitations</h3>
            <Invitations budgetId={budget.id} />
          </Section>
          <Section title="Budget" id="budget-heading">
            <BudgetDetails key={budget.version} budget={budget} />
          </Section>
          <Section title="Delete budget" id="delete-heading">
            <p className="text-sm text-fg-muted">
              Deletes it for every member. You can undo this for 30 days.
            </p>
            <Button
              variant="danger"
              className="self-start"
              onPress={() => {
                setPending({ kind: "delete" });
              }}
              data-testid="delete-budget"
            >
              Delete budget
            </Button>
          </Section>
        </>
      ) : (
        <Section title="Budget" id="budget-heading">
          <p className="text-sm text-fg">
            Time zone: {budget.timezone.replace(/_/g, " ")}. Only the owner can
            rename the budget or change its time zone.
          </p>
        </Section>
      )}

      {dialog ? (
        <ConfirmDialog
          isOpen
          title={dialog.title}
          confirmLabel={dialog.label}
          tone={pending?.kind === "transfer" ? "primary" : "danger"}
          busy={action.busy}
          error={action.error}
          onCancel={() => {
            setPending(null);
            action.setError(null);
          }}
          onConfirm={confirm}
        >
          {dialog.body}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

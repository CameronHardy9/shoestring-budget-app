// /budgets/{budgetId}/categories (task 9, J5): categories and this month's
// limits. Members and owners can add, rename, archive and delete unused
// categories, set a month's limit, and copy last month's plan (fills only empty
// limits unless the person chooses to replace them). Edits send versions; a
// conflict refetches and asks again rather than overwriting.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import type { Category, CategoryKind, Schemas } from "../../api/types.ts";
import { invalidateBudget, useCategories, usePlan } from "../../app/data.ts";
import { useLocation } from "../../app/router.tsx";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { AmountField } from "../../components/AmountField.tsx";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Money } from "../../components/Money.tsx";
import { MonthNav } from "../../components/MonthNav.tsx";
import { SegmentedControl } from "../../components/SegmentedControl.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import {
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { monthLabel, monthName, shiftMonth } from "../../lib/dates.ts";
import { centsToInputString, parseMoneyInput } from "../../lib/money.ts";
import { monthFrom, useCurrentBudget } from "./BudgetLayout.tsx";

type PlanEntry = Schemas["PlanEntry"];
type Editing = { kind: "new" } | { kind: "edit"; category: Category } | null;

function CategoryEditor({
  budgetId,
  month,
  editing,
  entry,
  onDone,
}: {
  budgetId: string;
  month: string;
  editing: Exclude<Editing, null>;
  entry: PlanEntry | undefined;
  onDone: (message: string) => void;
}) {
  const client = useQueryClient();
  const existing = editing.kind === "edit" ? editing.category : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(existing?.kind ?? "expense");
  const [limit, setLimit] = useState(
    entry && entry.amountCents > 0 ? centsToInputString(entry.amountCents) : "",
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [touched, setTouched] = useState(false);
  const save = useAction();
  const del = useAction();

  const parsed =
    limit.trim() === "" ? null : parseMoneyInput(limit, { min: 0 });
  const nameError =
    save.error instanceof ApiError
      ? (mapFieldErrors(save.error.details, ["name"], {
          duplicate: "A category with this name already exists.",
        }).fields.name ??
        (save.error.code === "ALREADY_EXISTS"
          ? "A category with this name already exists."
          : undefined))
      : undefined;

  const latestEntry = async () =>
    (
      await unwrap(
        api.GET("/budgets/{budgetId}/months/{month}/plan", {
          params: { path: { budgetId, month } },
        }),
      )
    ).items;

  async function putLimit(categoryId: string, cents: number) {
    const current = (await latestEntry()).find(
      (e) => e.categoryId === categoryId,
    );
    if (!current && cents === 0) return;
    if (current?.amountCents === cents) return;
    await unwrap(
      api.PUT("/budgets/{budgetId}/months/{month}/plan/{categoryId}", {
        params: { path: { budgetId, month, categoryId } },
        body: { amountCents: cents, version: current?.version ?? null },
      }),
    );
  }

  const submit = () => {
    setTouched(true);
    if (name.trim() === "" || (parsed && !parsed.ok)) return;
    void save.run(async () => {
      let category = existing;
      if (!category) {
        category = await unwrap(
          api.POST("/budgets/{budgetId}/categories", {
            params: { path: { budgetId } },
            body: { name: name.trim(), kind },
          }),
        );
      } else if (name.trim() !== category.name) {
        category = await unwrap(
          api.PATCH("/budgets/{budgetId}/categories/{categoryId}", {
            params: { path: { budgetId, categoryId: category.id } },
            body: { name: name.trim(), version: category.version },
          }),
        );
      }
      if (!category.archived)
        await putLimit(category.id, parsed?.ok ? parsed.cents : 0);
      await invalidateBudget(client, budgetId);
      onDone(existing ? `Saved ${category.name}` : `Added ${category.name}`);
    });
  };

  const setArchived = (archived: boolean) =>
    void save.run(async () => {
      if (!existing) return;
      await unwrap(
        api.PATCH("/budgets/{budgetId}/categories/{categoryId}", {
          params: { path: { budgetId, categoryId: existing.id } },
          body: { archived, version: existing.version },
        }),
      );
      await invalidateBudget(client, budgetId);
      onDone(
        archived ? `Archived ${existing.name}` : `Restored ${existing.name}`,
      );
    });

  const conflict =
    save.error instanceof ApiError && save.error.code === "VERSION_CONFLICT";
  const inUse =
    del.error instanceof ApiError && del.error.code === "CATEGORY_IN_USE";

  return (
    <form
      className="flex flex-col gap-4 pt-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {conflict ? (
        <p
          role="alert"
          className="rounded-md bg-warning-soft p-3 text-sm text-fg"
        >
          Someone else changed this category or its limit just now. The latest
          version is loaded; check it and save again.
        </p>
      ) : (
        <FormError
          error={
            save.error instanceof ApiError &&
            (save.error.code === "VALIDATION_FAILED" ||
              save.error.code === "ALREADY_EXISTS")
              ? null
              : save.error
          }
        />
      )}
      <TextField
        label="Name"
        maxLength={40}
        isRequired
        value={name}
        onChange={setName}
        errorMessage={
          touched && name.trim() === ""
            ? "Give the category a name."
            : nameError
        }
      />
      {existing ? (
        <p className="text-sm text-fg-muted">
          {existing.kind === "income" ? "Income category" : "Spending category"}
        </p>
      ) : (
        <SegmentedControl
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { id: "expense", label: "Spending" },
            { id: "income", label: "Income" },
          ]}
        />
      )}
      {existing?.archived ? (
        <p className="text-sm text-fg-muted">
          Archived categories keep their history but can't get new limits or
          transactions.
        </p>
      ) : (
        <AmountField
          label={`${kind === "income" ? "Expected" : "Limit"} for ${monthLabel(month)}`}
          min={0}
          value={limit}
          showError={touched}
          onChange={setLimit}
          data-testid="category-limit"
        />
      )}
      <Button
        type="submit"
        size="lg"
        isPending={save.busy}
        data-testid="category-save"
      >
        {existing ? "Save" : "Add category"}
      </Button>
      {existing ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <Button
            variant="secondary"
            onPress={() => {
              setArchived(!existing.archived);
            }}
            isDisabled={save.busy}
          >
            {existing.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            variant="quiet"
            onPress={() => {
              del.setError(null);
              setConfirmDelete(true);
            }}
          >
            <Icon name="trash" /> Delete category
          </Button>
        </div>
      ) : null}
      {existing ? (
        <ConfirmDialog
          isOpen={confirmDelete}
          title={`Delete ${existing.name}?`}
          confirmLabel={inUse ? "Archive instead" : "Delete"}
          busy={del.busy || save.busy}
          error={inUse ? null : del.error}
          onCancel={() => {
            setConfirmDelete(false);
          }}
          onConfirm={() => {
            if (inUse) {
              setConfirmDelete(false);
              setArchived(true);
              return;
            }
            void del.run(async () => {
              await unwrap(
                api.DELETE("/budgets/{budgetId}/categories/{categoryId}", {
                  params: {
                    path: { budgetId, categoryId: existing.id },
                    query: { version: existing.version },
                  },
                }),
              );
              setConfirmDelete(false);
              await invalidateBudget(client, budgetId);
              onDone(`Deleted ${existing.name}`);
            });
          }}
        >
          {inUse
            ? "Transactions use this category, so it can't be deleted. Archive it to hide it from new entries and keep its history."
            : "Only categories that no transaction uses can be deleted. Its limits are removed too."}
        </ConfirmDialog>
      ) : null}
    </form>
  );
}

function Row({
  category,
  entry,
  onOpen,
}: {
  category: Category;
  entry: PlanEntry | undefined;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-sunken"
        data-testid="category-row"
      >
        <span className="flex-1 text-base font-medium text-fg">
          {category.name}
        </span>
        {entry && entry.amountCents > 0 ? (
          <Money
            cents={entry.amountCents}
            className="text-base font-semibold text-fg"
          />
        ) : (
          <span className="text-sm text-fg-muted">
            {category.archived ? "Archived" : "No limit"}
          </span>
        )}
        <Icon name="chevronRight" size={18} className="text-fg-muted" />
      </button>
    </li>
  );
}

export default function CategoriesScreen() {
  const { budget } = useCurrentBudget();
  const location = useLocation();
  const client = useQueryClient();
  const toast = useToast();
  const month = monthFrom(location.search, budget);
  const categories = useCategories(budget.id);
  const plan = usePlan(budget.id, month);
  const [editing, setEditing] = useState<Editing>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const copy = useAction();
  const prevName = monthName(shiftMonth(month, -1));

  const copyPrevious = (overwrite: boolean) =>
    void copy.run(async () => {
      const result = await unwrap(
        api.POST("/budgets/{budgetId}/months/{month}/plan/copy-previous", {
          params: { path: { budgetId: budget.id, month } },
          body: { overwrite },
        }),
      );
      setConfirmReplace(false);
      await invalidateBudget(client, budget.id);
      toast(
        result.copiedCount === 0
          ? `Nothing to copy from ${prevName}`
          : `Copied ${String(result.copiedCount)} limit${result.copiedCount === 1 ? "" : "s"} from ${prevName}`,
      );
    });

  const entries = new Map(
    (plan.data?.items ?? []).map((e) => [e.categoryId, e]),
  );
  const all = categories.data?.items ?? [];
  const active = all.filter((c) => !c.archived);
  const archived = all.filter((c) => c.archived);
  const total = (kind: CategoryKind) =>
    active
      .filter((c) => c.kind === kind)
      .reduce((sum, c) => sum + (entries.get(c.id)?.amountCents ?? 0), 0);

  const list = (items: Category[], label: string, id: string) =>
    items.length === 0 ? null : (
      <section aria-labelledby={id} className="flex flex-col gap-1.5">
        <h2 id={id} className="px-1 text-sm font-semibold text-fg">
          {label}
        </h2>
        <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1">
          {items.map((c) => (
            <Row
              key={c.id}
              category={c}
              entry={entries.get(c.id)}
              onOpen={() => {
                setEditing({ kind: "edit", category: c });
              }}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pt-4 lg:px-8 lg:pt-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-fg-muted">{budget.name}</p>
          <h1 className="text-2xl font-semibold text-fg">
            Categories &amp; limits
          </h1>
        </div>
        <MonthNav month={month} currentMonth={budget.currentMonth} />
      </header>

      {categories.isPending || plan.isPending ? (
        <LoadingState label="Loading categories…" />
      ) : categories.isError || plan.isError ? (
        <ErrorState
          error={categories.error ?? plan.error}
          onRetry={() => {
            void categories.refetch();
            void plan.refetch();
          }}
        />
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-lg bg-surface p-4 shadow-1">
            <p className="text-sm text-fg-muted">
              Planned spending for {monthLabel(month)}:{" "}
              <Money
                cents={total("expense")}
                className="font-semibold text-fg"
              />
              {active.some((c) => c.kind === "income") ? (
                <>
                  {" "}
                  · expected income{" "}
                  <Money
                    cents={total("income")}
                    className="font-semibold text-fg"
                  />
                </>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                isPending={copy.busy}
                onPress={() => {
                  copyPrevious(false);
                }}
                data-testid="copy-previous"
              >
                Copy {prevName}'s limits
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onPress={() => {
                  setConfirmReplace(true);
                }}
              >
                Replace all with {prevName}'s
              </Button>
            </div>
            <FormError error={confirmReplace ? null : copy.error} />
          </div>

          {active.length === 0 ? (
            <EmptyState icon="budgets" title="No categories yet">
              Add the things you spend on, like groceries or rent, and give each
              a monthly limit.
            </EmptyState>
          ) : (
            <>
              {list(
                active.filter((c) => c.kind === "expense"),
                "Spending",
                "spending-heading",
              )}
              {list(
                active.filter((c) => c.kind === "income"),
                "Income",
                "income-heading",
              )}
            </>
          )}
          <Button
            onPress={() => {
              setEditing({ kind: "new" });
            }}
            data-testid="add-category"
          >
            <Icon name="plus" /> Add category
          </Button>
          {archived.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                aria-expanded={showArchived}
                onPress={() => {
                  setShowArchived((v) => !v);
                }}
              >
                {showArchived
                  ? "Hide archived"
                  : `Show archived (${String(archived.length)})`}
              </Button>
              {showArchived
                ? list(archived, "Archived", "archived-heading")
                : null}
            </div>
          ) : null}
          <Link
            href={`/budgets/${budget.id}/members`}
            className="flex min-h-touch items-center gap-2 self-start font-semibold text-brand"
          >
            Members and budget settings <Icon name="chevronRight" size={18} />
          </Link>
        </>
      )}

      <Sheet
        title={
          editing?.kind === "edit" ? editing.category.name : "New category"
        }
        isOpen={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        data-testid="category-sheet"
      >
        {editing ? (
          <CategoryEditor
            budgetId={budget.id}
            month={month}
            editing={editing}
            entry={
              editing.kind === "edit"
                ? entries.get(editing.category.id)
                : undefined
            }
            onDone={(message) => {
              setEditing(null);
              toast(message);
            }}
          />
        ) : null}
      </Sheet>
      <ConfirmDialog
        isOpen={confirmReplace}
        title={`Replace ${monthName(month)}'s limits?`}
        confirmLabel="Replace"
        tone="primary"
        busy={copy.busy}
        error={copy.error}
        onCancel={() => {
          setConfirmReplace(false);
        }}
        onConfirm={() => {
          copyPrevious(true);
        }}
      >
        Every limit for {monthLabel(month)} will be set to {prevName}'s amount,
        including ones you already set. Archived categories are skipped.
      </ConfirmDialog>
    </div>
  );
}

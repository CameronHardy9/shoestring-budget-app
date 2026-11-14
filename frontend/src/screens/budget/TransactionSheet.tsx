// Quick-add and edit (J2, J4). Three taps: "+" → type the amount (the keypad
// is already up) → tap a category → Save. Date (budget's today), payee, memo
// and split are optional and one tap away.
//
// Honest saving: the Save button shows progress; on failure everything typed
// stays and Retry re-sends with the SAME Idempotency-Key (ADR-0002), so a save
// whose response was lost can never create a duplicate. A new key is made only
// after a success, or when the person chooses to save a changed entry as new.
// Edits send `version`; 409 VERSION_CONFLICT shows both versions and never
// overwrites silently.
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/errors.ts";
import { newIdempotencyKey } from "../../api/ids.ts";
import type { Budget, Category, Transaction } from "../../api/types.ts";
import {
  getTransaction,
  useCategories,
  useCreateTransaction,
  useDeleteTransaction,
  useReplaceTransaction,
  useTransactions,
} from "../../app/data.ts";
import { useToast } from "../../app/toast.tsx";
import {
  buildTransaction,
  dateBounds,
  draftFrom,
  emptyDraft,
  endSplit,
  MAX_SPLITS,
  newRow,
  orderCategories,
  recentCategoryIds,
  serverErrors,
  startSplit,
  type Draft,
  type DraftErrors,
} from "../../app/transaction-form.ts";
import { Alert } from "../../components/Alert.tsx";
import { AmountField } from "../../components/AmountField.tsx";
import { Button } from "../../components/Button.tsx";
import { ChipGroup } from "../../components/ChipGroup.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Money } from "../../components/Money.tsx";
import { SegmentedControl } from "../../components/SegmentedControl.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import {
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { dayLabel } from "../../lib/dates.ts";
import {
  centsToInputString,
  formatCents,
  parseMoneyInput,
} from "../../lib/money.ts";
import { remainderFor } from "../../lib/splits.ts";
import { describeSplits } from "./TransactionRow.tsx";

/** Unsaved quick-add input kept in memory across a sign-in (errors.md "Client handling"). */
let stashed: { budgetId: string; draft: Draft } | null = null;
function stashDraft(budgetId: string, draft: Draft): void {
  stashed = { budgetId, draft };
}
export function takeStashedDraft(budgetId: string): Draft | null {
  if (!stashed || stashed.budgetId !== budgetId) return null;
  const { draft } = stashed;
  stashed = null;
  return draft;
}

export type SheetMode =
  | { kind: "create"; draft?: Draft }
  | { kind: "edit"; transaction: Transaction };

const CHIP_LIMIT = 6;

function CategorySelect({
  label,
  categories,
  value,
  onChange,
  error,
}: {
  label: string;
  categories: readonly Category[];
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="min-h-touch w-full rounded-full border border-line-strong bg-surface px-4 text-base font-medium text-fg"
      >
        <option value="">Choose…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </label>
  );
}

function OptionPill({
  icon,
  label,
  pressed,
  onPress,
  children,
}: {
  icon: "calendar" | "note" | "split";
  label?: string;
  pressed: boolean;
  onPress: () => void;
  children: string;
}) {
  return (
    <Button
      variant={pressed ? "selected" : "secondary"}
      size="sm"
      weight={pressed ? "semibold" : "medium"}
      shape="pill"
      className="flex-1"
      aria-pressed={pressed}
      onPress={onPress}
      {...(label ? { "aria-label": label } : {})}
    >
      <Icon name={icon} size={18} />
      {children}
    </Button>
  );
}

function ConflictPanel({
  theirs,
  categories,
  onUseTheirs,
  onKeepMine,
  busy,
}: {
  theirs: Transaction;
  categories: readonly Category[];
  onUseTheirs: () => void;
  onKeepMine: () => void;
  busy: boolean;
}) {
  const names = describeSplits(theirs, categories);
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md bg-warning-soft p-3 text-sm"
      data-testid="conflict"
    >
      <p className="flex items-center gap-2 font-semibold text-warning">
        <Icon name="alert" size={18} /> Someone else changed this transaction
      </p>
      <p className="text-fg">
        Their version:{" "}
        <Money cents={theirs.amountCents} className="font-semibold" /> · {names}{" "}
        · {theirs.date}
        {theirs.payee ? ` · ${theirs.payee}` : ""}
      </p>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          onPress={onUseTheirs}
        >
          Use their version
        </Button>
        <Button
          size="sm"
          className="flex-1"
          isPending={busy}
          onPress={onKeepMine}
        >
          Save mine instead
        </Button>
      </div>
    </div>
  );
}

function Editor({
  budget,
  mode,
  onClose,
}: {
  budget: Budget;
  mode: SheetMode;
  onClose: () => void;
}) {
  const toast = useToast();
  const categoriesQuery = useCategories(budget.id);
  const recent = useTransactions(budget.id, {
    month: budget.currentMonth,
    categoryId: null,
  });
  const create = useCreateTransaction(budget.id);
  const replace = useReplaceTransaction(budget.id);
  const remove = useDeleteTransaction(budget.id);

  const editing = mode.kind === "edit" ? mode.transaction : null;
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? draftFrom(editing)
      : (mode.kind === "create" && mode.draft) || emptyDraft(budget.today),
  );
  const [version, setVersion] = useState(editing?.version ?? 0);
  const [showErrors, setShowErrors] = useState(false);
  const [server, setServer] = useState<{
    errors: DraftErrors;
    form: string[];
  } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Transaction | null>(null);
  const [gone, setGone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Announced inside the sheet: the modal hides the page (and its toasts)
  // from screen readers while open.
  const [savedNote, setSavedNote] = useState("");
  const [showDate, setShowDate] = useState(false);
  const [showNote, setShowNote] = useState(
    draft.payee !== "" || draft.memo !== "",
  );
  const keyRef = useRef(newIdempotencyKey());
  const amountRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  // Move focus to the confirmation when it appears (screen readers hear it).
  useEffect(() => {
    if (confirmDelete) confirmRef.current?.focus();
  }, [confirmDelete]);

  const allCategories = useMemo(
    () => categoriesQuery.data?.items ?? [],
    [categoriesQuery.data],
  );
  const recentIds = useMemo(
    () => recentCategoryIds(recent.data?.pages[0]?.items ?? []),
    [recent.data],
  );
  const keepIds = editing ? editing.splits.map((s) => s.categoryId) : [];
  const ordered = orderCategories(
    allCategories,
    recentIds,
    draft.direction,
    keepIds,
  );
  const chips = showAll ? ordered : ordered.slice(0, CHIP_LIMIT);
  const selectedHidden =
    draft.categoryId !== null && !chips.some((c) => c.id === draft.categoryId);
  const visibleChips = selectedHidden
    ? [...chips, ...ordered.filter((c) => c.id === draft.categoryId)]
    : chips;

  const built = buildTransaction(draft, budget.today);
  const local = built.ok ? { rows: {} } : built.errors;
  const errors: DraftErrors = showErrors
    ? {
        ...(server?.errors ?? {}),
        ...local,
        rows: { ...server?.errors.rows, ...local.rows },
      }
    : (server?.errors ?? { rows: {} });
  const busy = create.isPending || replace.isPending || remove.isPending;

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServer(null);
    setSavedNote("");
  };

  const categoryName = (id: string) =>
    allCategories.find((c) => c.id === id)?.name ?? "category";

  async function save(
    andNew: boolean,
    opts: { overrideVersion?: number } = {},
  ) {
    setShowErrors(true);
    setFailure(null);
    if (!built.ok) return;
    try {
      if (editing) {
        await replace.mutateAsync({
          transactionId: editing.id,
          body: {
            ...built.body,
            payee: built.body.payee ?? null,
            memo: built.body.memo ?? null,
            version: opts.overrideVersion ?? version,
          },
        });
        toast("Changes saved");
        onClose();
        return;
      }
      await create.mutateAsync({
        body: built.body,
        idempotencyKey: keyRef.current,
      });
      keyRef.current = newIdempotencyKey();
      const where =
        built.body.splits.length === 1
          ? ` to ${categoryName(built.body.splits[0]?.categoryId ?? "")}`
          : "";
      const message = `Saved ${formatCents(built.body.amountCents)}${where}`;
      toast(message);
      if (andNew) {
        setSavedNote(message);
        setDraft({
          ...emptyDraft(budget.today),
          direction: draft.direction,
          date: draft.date,
        });
        setShowErrors(false);
        setServer(null);
        amountRef.current?.querySelector("input")?.focus();
      } else {
        onClose();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "UNAUTHENTICATED") stashDraft(budget.id, draft);
        if (error.code === "VERSION_CONFLICT" && editing) {
          try {
            setConflict(await getTransaction(budget.id, editing.id));
          } catch (e) {
            if (e instanceof ApiError && e.code === "NOT_FOUND") setGone(true);
            else setFailure(e);
          }
          return;
        }
        if (error.code === "NOT_FOUND" && editing) {
          setGone(true);
          return;
        }
        if (error.details.length > 0) {
          const mapped = serverErrors(error.details, draft);
          setServer(mapped);
          if (
            mapped.form.length === 0 &&
            error.code !== "IDEMPOTENCY_KEY_REUSED"
          )
            return;
        }
      }
      setFailure(error);
    }
  }

  async function doDelete() {
    if (!editing) return;
    setFailure(null);
    try {
      await remove.mutateAsync({ transactionId: editing.id, version });
      toast("Transaction deleted");
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND") {
        toast("Already deleted");
        onClose();
        return;
      }
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        setConfirmDelete(false);
        try {
          setConflict(await getTransaction(budget.id, editing.id));
        } catch (e) {
          setFailure(e);
        }
        return;
      }
      setFailure(error);
    }
  }

  if (categoriesQuery.isPending) return <LoadingState rows={2} />;
  if (categoriesQuery.isError) {
    return (
      <ErrorState
        error={categoriesQuery.error}
        onRetry={() => void categoriesQuery.refetch()}
      />
    );
  }
  if (allCategories.length === 0) {
    return (
      <Alert tone="info">
        This budget has no categories yet. Add some under Budgets first.
      </Alert>
    );
  }
  if (gone) {
    return (
      <div className="flex flex-col gap-3 pt-2">
        <Alert tone="warning">
          This transaction was deleted, so your changes can't be saved.
        </Alert>
        <Button variant="secondary" onPress={onClose}>
          Close
        </Button>
      </div>
    );
  }

  // The total even while the split is unbalanced (built.ok is false then).
  const totalParsed = parseMoneyInput(draft.amountText);
  const amountCents = totalParsed.ok ? totalParsed.cents : null;
  const balance = built.balance;
  const rowCents = draft.rows.map((r) => {
    const parsed = parseMoneyInput(r.text);
    return parsed.ok ? parsed.cents : null;
  });
  const lastIndex = draft.rows.length - 1;
  const lastCategory = draft.rows[lastIndex]?.categoryId ?? "";
  const rest =
    amountCents !== null && draft.split
      ? remainderFor(amountCents, rowCents, lastIndex)
      : null;
  const { min, max } = dateBounds(budget.today);
  const reused =
    failure instanceof ApiError && failure.code === "IDEMPOTENCY_KEY_REUSED";

  return (
    <form
      className="flex flex-col gap-4 pt-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      {conflict ? (
        <ConflictPanel
          theirs={conflict}
          categories={allCategories}
          busy={busy}
          onUseTheirs={() => {
            setDraft(draftFrom(conflict));
            setVersion(conflict.version);
            setConflict(null);
          }}
          onKeepMine={() => {
            const next = conflict.version;
            setVersion(next);
            setConflict(null);
            void save(false, { overrideVersion: next });
          }}
        />
      ) : null}

      <SegmentedControl
        label="Type"
        value={draft.direction}
        onChange={(direction) => {
          update({ direction });
        }}
        options={[
          { id: "outflow", label: "Spent" },
          { id: "inflow", label: "Received" },
        ]}
      />

      <div ref={amountRef}>
        <AmountField
          label="Amount"
          hideLabel
          size="display"
          autoFocus={!editing}
          value={draft.amountText}
          onChange={(amountText) => {
            update({ amountText });
          }}
          {...(errors.amount ? { errorMessage: errors.amount } : {})}
          data-testid="quick-add-amount"
        />
      </div>

      {!draft.split ? (
        <div className="flex flex-col gap-2">
          <ChipGroup
            label="Category"
            hideLabel
            chips={visibleChips.map((c) => ({ id: c.id, label: c.name }))}
            value={draft.categoryId}
            onChange={(categoryId) => {
              update({ categoryId });
            }}
            {...(errors.category ? { errorMessage: errors.category } : {})}
          />
          {ordered.length > CHIP_LIMIT ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              aria-expanded={showAll}
              onPress={() => {
                setShowAll((v) => !v);
              }}
            >
              {showAll
                ? "Fewer categories"
                : `All categories (${String(ordered.length)})`}
            </Button>
          ) : null}
        </div>
      ) : (
        <fieldset className="flex flex-col gap-2" data-testid="split-editor">
          <legend className="mb-2 text-sm font-medium text-fg">
            Split between categories
          </legend>
          {draft.rows.map((row, i) => (
            <div key={row.key} className="flex items-start gap-2">
              <CategorySelect
                label={`Category ${String(i + 1)}`}
                categories={ordered}
                value={row.categoryId}
                error={errors.rows[i]?.category}
                onChange={(categoryId) => {
                  update({
                    rows: draft.rows.map((r, j) =>
                      j === i ? { ...r, categoryId } : r,
                    ),
                  });
                }}
              />
              <AmountField
                label={`Amount ${String(i + 1)}${row.categoryId ? `, ${categoryName(row.categoryId)}` : ""}`}
                hideLabel
                className="w-32"
                value={row.text}
                onChange={(text) => {
                  update({
                    rows: draft.rows.map((r, j) =>
                      j === i ? { ...r, text } : r,
                    ),
                  });
                }}
                errorMessage={errors.rows[i]?.amount}
              />
              <Button
                variant="quiet"
                size="icon"
                aria-label={`Remove ${row.categoryId ? categoryName(row.categoryId) : `line ${String(i + 1)}`}`}
                onPress={() => {
                  const rows = draft.rows.filter((_, j) => j !== i);
                  update(
                    rows.length === 1 ? endSplit({ ...draft, rows }) : { rows },
                  );
                }}
              >
                <Icon name="trash" />
              </Button>
            </div>
          ))}
          {draft.rows.length < MAX_SPLITS ? (
            <Button
              variant="ghost"
              size="md"
              className="self-start"
              onPress={() => {
                update({ rows: [...draft.rows, newRow()] });
              }}
            >
              <Icon name="plus" /> Add category
            </Button>
          ) : null}
          <div aria-live="polite" data-testid="split-left-to-assign">
            {balance?.kind === "under" ? (
              <Alert tone="warning">
                <Money cents={balance.leftCents} /> left to assign
              </Alert>
            ) : balance?.kind === "over" ? (
              <Alert tone="danger">
                Splits are <Money cents={balance.overCents} /> more than the
                total
              </Alert>
            ) : balance?.kind === "balanced" ? (
              <Alert tone="success">Fully assigned</Alert>
            ) : null}
          </div>
          {rest !== null && balance?.kind === "under" && lastCategory ? (
            <Button
              variant="secondary"
              onPress={() => {
                update({
                  rows: draft.rows.map((r, j) =>
                    j === lastIndex
                      ? { ...r, text: centsToInputString(rest) }
                      : r,
                  ),
                });
              }}
            >
              Put the rest on {categoryName(lastCategory)}
            </Button>
          ) : null}
          {errors.split && balance?.kind !== "under" ? (
            <p className="text-sm text-danger">{errors.split}</p>
          ) : null}
        </fieldset>
      )}

      <div className="flex gap-2">
        <OptionPill
          icon="calendar"
          pressed={showDate}
          label={`Date: ${dayLabel(draft.date, budget.today)}`}
          onPress={() => {
            setShowDate((v) => !v);
          }}
        >
          {dayLabel(draft.date, budget.today)}
        </OptionPill>
        <OptionPill
          icon="note"
          pressed={showNote}
          onPress={() => {
            setShowNote((v) => !v);
          }}
        >
          Note
        </OptionPill>
        <OptionPill
          icon="split"
          pressed={draft.split}
          label={draft.split ? "Split, on" : "Split"}
          onPress={() => {
            update(draft.split ? endSplit(draft) : startSplit(draft));
          }}
        >
          Split
        </OptionPill>
      </div>

      {showDate ? (
        <TextField
          label="Date"
          type="date"
          min={min}
          max={max}
          value={draft.date}
          onChange={(date) => {
            update({ date });
          }}
          {...(errors.date ? { errorMessage: errors.date } : {})}
        />
      ) : errors.date ? (
        <p className="text-sm text-danger">{errors.date}</p>
      ) : null}
      {showNote ? (
        <>
          <TextField
            label="Payee"
            description="Optional, e.g. the shop's name."
            maxLength={100}
            value={draft.payee}
            onChange={(payee) => {
              update({ payee });
            }}
            {...(errors.payee ? { errorMessage: errors.payee } : {})}
          />
          <TextField
            label="Memo"
            maxLength={500}
            value={draft.memo}
            onChange={(memo) => {
              update({ memo });
            }}
            {...(errors.memo ? { errorMessage: errors.memo } : {})}
          />
        </>
      ) : null}

      {server?.form.length ? (
        <Alert tone="danger">{server.form.join(" ")}</Alert>
      ) : null}
      {failure && !reused ? <FormError error={failure} /> : null}
      {reused ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm"
        >
          <p className="font-medium text-fg">
            Your first save went through, but these later changes weren't saved.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              keyRef.current = newIdempotencyKey();
              void save(false);
            }}
          >
            Save this as a new transaction
          </Button>
        </div>
      ) : null}

      {confirmDelete ? (
        <div
          ref={confirmRef}
          tabIndex={-1}
          role="group"
          aria-label="Confirm delete"
          className="flex flex-col gap-2 rounded-md bg-danger-soft p-3"
        >
          <p className="text-sm font-medium text-fg">
            Delete this transaction? Totals update straight away.
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onPress={() => {
                setConfirmDelete(false);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              isPending={remove.isPending}
              onPress={() => void doDelete()}
              data-testid="confirm-delete"
            >
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      <p
        role="status"
        className="text-sm font-medium text-success empty:hidden"
        data-testid="sheet-status"
      >
        {savedNote}
      </p>
      <div className="flex gap-2 pt-1">
        {editing ? (
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            isDisabled={busy}
            onPress={() => {
              setConfirmDelete(true);
            }}
            data-testid="delete-transaction"
          >
            Delete
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            isPending={create.isPending}
            onPress={() => void save(true)}
            data-testid="quick-add-save-new"
          >
            Save &amp; new
          </Button>
        )}
        <Button
          type="submit"
          size="lg"
          className="flex-[1.4]"
          isPending={create.isPending || replace.isPending}
          data-testid="quick-add-save"
        >
          {failure && !reused ? "Retry" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function TransactionSheet({
  budget,
  mode,
  onClose,
}: {
  budget: Budget;
  mode: SheetMode | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={mode?.kind === "edit" ? "Edit transaction" : "Add transaction"}
      isOpen={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      data-testid="quick-add-sheet"
    >
      {mode ? <Editor budget={budget} mode={mode} onClose={onClose} /> : null}
    </Sheet>
  );
}

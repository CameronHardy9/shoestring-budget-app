// Pure logic behind the quick-add / edit sheet: the draft the person edits,
// validation (mirroring the contract so most mistakes never reach the server),
// the request body, and mapping server FieldErrors back onto inputs.
import type { MappedFieldErrors } from "../api/messages.ts";
import { mapFieldErrors } from "../api/messages.ts";
import type {
  Category,
  Direction,
  FieldError,
  Transaction,
  TransactionCreate,
} from "../api/types.ts";
import {
  centsToInputString,
  parseMoneyInput,
  type MoneyParseError,
} from "../lib/money.ts";
import { splitBalance, type SplitBalance } from "../lib/splits.ts";

export const MAX_SPLITS = 20;

export interface SplitRow {
  key: string;
  categoryId: string;
  text: string;
}

export interface Draft {
  direction: Direction;
  amountText: string;
  categoryId: string | null;
  date: string;
  payee: string;
  memo: string;
  split: boolean;
  rows: SplitRow[];
}

let rowSeq = 0;
export function newRow(categoryId = "", text = ""): SplitRow {
  rowSeq += 1;
  return { key: `row-${String(rowSeq)}`, categoryId, text };
}

export function emptyDraft(today: string): Draft {
  return {
    direction: "outflow",
    amountText: "",
    categoryId: null,
    date: today,
    payee: "",
    memo: "",
    split: false,
    rows: [],
  };
}

export function draftFrom(t: Transaction): Draft {
  const single = t.splits.length === 1;
  return {
    direction: t.direction,
    amountText: centsToInputString(t.amountCents),
    categoryId: single ? (t.splits[0]?.categoryId ?? null) : null,
    date: t.date,
    payee: t.payee ?? "",
    memo: t.memo ?? "",
    split: !single,
    rows: single
      ? []
      : t.splits.map((s) =>
          newRow(s.categoryId, centsToInputString(s.amountCents)),
        ),
  };
}

/** Turn split mode on: the chosen category keeps the whole amount, plus an empty row. */
export function startSplit(draft: Draft): Draft {
  return {
    ...draft,
    split: true,
    rows: [newRow(draft.categoryId ?? "", draft.amountText), newRow()],
  };
}

/** Turn split mode off: keep the first row's category. */
export function endSplit(draft: Draft): Draft {
  return {
    ...draft,
    split: false,
    categoryId: draft.rows[0]?.categoryId || draft.categoryId,
    rows: [],
  };
}

export const AMOUNT_COPY: Record<MoneyParseError, string> = {
  empty: "Enter an amount.",
  invalid: "Use digits, like 12.50.",
  too_many_decimals: "Use at most two decimal places.",
  too_small: "Enter an amount above $0.00.",
  too_big: "The most you can enter is $1,000,000.00.",
};

export interface DraftErrors {
  amount?: string;
  category?: string;
  date?: string;
  payee?: string;
  memo?: string;
  /** Split-level problem (sum, duplicates, count). */
  split?: string;
  rows: Partial<Record<number, { category?: string; amount?: string }>>;
}

export type BuildResult =
  | { ok: true; body: TransactionCreate; balance: SplitBalance | null }
  | { ok: false; errors: DraftErrors; balance: SplitBalance | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Length in Unicode code points (the contract's maxLength unit). */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

function lastAllowedDate(today: string): string {
  const [y = "2000", m = "01", d = "01"] = today.split("-");
  return `${String(Number(y) + 1)}-${m}-${m === "02" && d === "29" ? "28" : d}`;
}

export function dateBounds(today: string): { min: string; max: string } {
  return { min: "2000-01-01", max: lastAllowedDate(today) };
}

/** Validates the draft against the contract rules and builds the body. */
export function buildTransaction(draft: Draft, today: string): BuildResult {
  const errors: DraftErrors = { rows: {} };
  const amount = parseMoneyInput(draft.amountText);
  if (!amount.ok) errors.amount = AMOUNT_COPY[amount.error];

  const { min, max } = dateBounds(today);
  if (!DATE.test(draft.date) || draft.date < min || draft.date > max) {
    errors.date = "Choose a date from 2000 up to one year from today.";
  }
  const payee = draft.payee.trim();
  const memo = draft.memo.trim();
  if (codePoints(payee) > 100) errors.payee = "Use at most 100 characters.";
  if (codePoints(memo) > 500) errors.memo = "Use at most 500 characters.";

  let splits: TransactionCreate["splits"] = [];
  let balance: SplitBalance | null = null;
  if (!draft.split) {
    if (!draft.categoryId) errors.category = "Choose a category.";
    else if (amount.ok)
      splits = [{ categoryId: draft.categoryId, amountCents: amount.cents }];
  } else {
    const seen = new Set<string>();
    const cents = draft.rows.map((row, i) => {
      const rowErrors: { category?: string; amount?: string } = {};
      if (!row.categoryId) rowErrors.category = "Choose a category.";
      else if (seen.has(row.categoryId))
        rowErrors.category = "This category is already in the split.";
      seen.add(row.categoryId);
      const parsed = parseMoneyInput(row.text);
      if (!parsed.ok) rowErrors.amount = AMOUNT_COPY[parsed.error];
      if (rowErrors.category ?? rowErrors.amount) errors.rows[i] = rowErrors;
      return parsed.ok ? parsed.cents : null;
    });
    if (draft.rows.length < 2)
      errors.split = "Add at least two categories, or turn off split.";
    if (draft.rows.length > MAX_SPLITS)
      errors.split = `Use at most ${String(MAX_SPLITS)} categories.`;
    if (amount.ok) {
      balance = splitBalance(amount.cents, cents);
      if (balance.kind === "under")
        errors.split ??= "Assign the rest of the amount before saving.";
      if (balance.kind === "over")
        errors.split ??= "The split adds up to more than the total.";
    }
    splits = draft.rows.map((row, i) => ({
      categoryId: row.categoryId,
      amountCents: cents[i] ?? 0,
    }));
  }

  const hasErrors =
    errors.amount ??
    errors.category ??
    errors.date ??
    errors.payee ??
    errors.memo ??
    errors.split;
  if (
    hasErrors !== undefined ||
    Object.keys(errors.rows).length > 0 ||
    !amount.ok
  ) {
    return { ok: false, errors, balance };
  }
  return {
    ok: true,
    balance,
    body: {
      date: draft.date,
      direction: draft.direction,
      amountCents: amount.cents,
      payee: payee === "" ? null : payee,
      memo: memo === "" ? null : memo,
      splits,
    },
  };
}

/** Server FieldErrors (VALIDATION_FAILED, 422s) mapped back onto the draft's inputs. */
export function serverErrors(
  details: readonly FieldError[],
  draft: Draft,
): { errors: DraftErrors; form: string[] } {
  const rowFields = draft.rows.flatMap((_, i) => [
    `splits.${String(i)}.categoryId`,
    `splits.${String(i)}.amountCents`,
  ]);
  const mapped: MappedFieldErrors = mapFieldErrors(details, [
    "amountCents",
    "date",
    "payee",
    "memo",
    "splits",
    "splits.0.categoryId",
    "splits.0.amountCents",
    ...rowFields,
  ]);
  const f = mapped.fields;
  const errors: DraftErrors = { rows: {} };
  if (f.amountCents) errors.amount = f.amountCents;
  if (f.date) errors.date = f.date;
  if (f.payee) errors.payee = f.payee;
  if (f.memo) errors.memo = f.memo;
  if (f.splits) errors.split = f.splits;
  if (!draft.split) {
    const category = f["splits.0.categoryId"];
    if (category) errors.category = category;
    if (f["splits.0.amountCents"]) errors.amount ??= f["splits.0.amountCents"];
  } else {
    draft.rows.forEach((_, i) => {
      const category = f[`splits.${String(i)}.categoryId`];
      const amount = f[`splits.${String(i)}.amountCents`];
      if (category ?? amount) {
        errors.rows[i] = {
          ...(category ? { category } : {}),
          ...(amount ? { amount } : {}),
        };
      }
    });
  }
  return { errors, form: mapped.form };
}

/**
 * Chips for quick-add: categories used most recently first, then the rest,
 * with the kind that matches the direction (expense for Spent, income for
 * Received) ahead of the other kind. Archived categories are left out unless
 * the transaction being edited already uses them.
 */
export function orderCategories(
  categories: readonly Category[],
  recentIds: readonly string[],
  direction: Direction,
  keepIds: readonly string[] = [],
): Category[] {
  const preferred = direction === "outflow" ? "expense" : "income";
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return categories
    .filter((c) => !c.archived || keepIds.includes(c.id))
    .slice()
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      if (a.kind !== b.kind) return a.kind === preferred ? -1 : 1;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
}

/**
 * Chip order frozen for one sheet session: categories that existed when the
 * order was captured keep their relative order; ones added since go last, so
 * no existing chip moves. Removed or archived ones simply drop out (a chip
 * that no longer exists can't be tapped).
 */
export function keepKnownFirst(
  ordered: readonly Category[],
  known: ReadonlySet<string>,
): Category[] {
  return [
    ...ordered.filter((c) => known.has(c.id)),
    ...ordered.filter((c) => !known.has(c.id)),
  ];
}

/** Category IDs in order of most recent use, from newest-first transactions. */
export function recentCategoryIds(
  transactions: readonly Transaction[],
): string[] {
  const out: string[] = [];
  for (const t of transactions) {
    for (const s of t.splits)
      if (!out.includes(s.categoryId)) out.push(s.categoryId);
  }
  return out;
}

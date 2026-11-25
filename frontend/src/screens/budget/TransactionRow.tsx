// One transaction line. Outflows show plain amounts; inflows show "+" in the
// success colour plus the word "refund" or "income", never colour alone.
import type { Category, Transaction } from "../../api/types.ts";
import { cx } from "../../components/cx.ts";
import { Money } from "../../components/Money.tsx";
import { dayLabel } from "../../lib/dates.ts";

export function describeSplits(
  t: Transaction,
  categories: readonly Category[],
): string {
  const names = t.splits.map(
    (s) =>
      categories.find((c) => c.id === s.categoryId)?.name ?? "Unknown category",
  );
  return names.length === 1 ? (names[0] ?? "") : `Split: ${names.join(", ")}`;
}

export function TransactionRow({
  transaction: t,
  categories,
  today,
  showDate = false,
  onOpen,
}: {
  transaction: Transaction;
  categories: readonly Category[];
  today: string;
  showDate?: boolean;
  onOpen: (t: Transaction) => void;
}) {
  const inflow = t.direction === "inflow";
  const allIncome = t.splits.every(
    (s) => categories.find((c) => c.id === s.categoryId)?.kind === "income",
  );
  const categoryText = describeSplits(t, categories);
  const title = t.payee ?? t.memo ?? categoryText;
  const titleIsMemo = t.payee === null && t.memo !== null;
  const detail = [
    (t.payee ?? t.memo) ? categoryText : null,
    inflow ? (allIncome ? "income" : "refund") : null,
    showDate ? dayLabel(t.date, today) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => {
        onOpen(t);
      }}
      className="flex min-h-14 w-full flex-wrap items-center gap-x-3 px-4 py-2.5 text-left active:bg-sunken"
      data-testid="transaction-row"
    >
      {/* Wraps, so whole names are readable; the amount moves below only where
          there's no room beside it. */}
      <span className="flex min-w-0 flex-1 basis-28 flex-col">
        <span
          className={cx(
            "text-base font-medium wrap-anywhere text-fg",
            // A memo can be 500 characters; all of it is in the edit sheet.
            titleIsMemo && "line-clamp-3",
          )}
        >
          {title}
        </span>
        {detail ? (
          <span className="text-sm wrap-anywhere text-fg-muted">{detail}</span>
        ) : null}
      </span>
      <Money
        cents={inflow ? t.amountCents : -t.amountCents}
        sign={inflow ? "always" : "never"}
        className={
          inflow
            ? "ml-auto text-base font-semibold text-success"
            : "ml-auto text-base font-semibold text-fg"
        }
      />
    </button>
  );
}

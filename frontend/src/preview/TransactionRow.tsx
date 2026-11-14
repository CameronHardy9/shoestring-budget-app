// DEV PREVIEW ONLY: one transaction line (shared by the overview and the list).
import type { Transaction } from "../api/types.ts";
import { Money } from "../components/Money.tsx";
import { dayLabel } from "../lib/dates.ts";
import { categoryName } from "./mock-data.ts";

export function describeSplits(t: Transaction): string {
  const names = t.splits.map((s) => categoryName(s.categoryId));
  return names.length === 1 ? (names[0] ?? "") : `Split: ${names.join(", ")}`;
}

export function TransactionRow({
  transaction: t,
  today,
  showDate = false,
}: {
  transaction: Transaction;
  today: string;
  showDate?: boolean;
}) {
  const inflow = t.direction === "inflow";
  const title = t.payee ?? t.memo ?? describeSplits(t);
  const detail = [
    describeSplits(t),
    inflow ? "refund" : null,
    showDate ? dayLabel(t.date, today) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-sunken"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base font-medium text-fg">{title}</span>
        <span className="truncate text-sm text-fg-muted">{detail}</span>
      </span>
      <Money
        cents={inflow ? t.amountCents : -t.amountCents}
        sign={inflow ? "always" : "never"}
        className={
          inflow
            ? "text-base font-semibold text-success"
            : "text-base font-semibold text-fg"
        }
      />
    </button>
  );
}

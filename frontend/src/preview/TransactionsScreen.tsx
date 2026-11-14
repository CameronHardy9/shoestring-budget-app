// DEV PREVIEW ONLY: the month's transactions grouped by day (J4).
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Money } from "../components/Money.tsx";
import { dayLabel, monthLabel, shiftMonth, shortDate } from "../lib/dates.ts";
import { sumCents } from "../lib/splits.ts";
import type { Transaction } from "../api/types.ts";
import { budget, transactions } from "./mock-data.ts";
import { TransactionRow } from "./TransactionRow.tsx";

function groupByDay(items: Transaction[]): [string, Transaction[]][] {
  const groups = new Map<string, Transaction[]>();
  for (const t of items) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
  return [...groups.entries()];
}

export function TransactionsScreen() {
  const month = budget.currentMonth;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 px-4 pt-4 lg:px-8 lg:pt-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-fg">Transactions</h1>
          <div className="flex items-center">
            <Button
              variant="quiet"
              size="icon"
              aria-label={`Previous month, ${monthLabel(shiftMonth(month, -1))}`}
            >
              <Icon name="chevronLeft" />
            </Button>
            <span className="text-sm font-semibold text-fg">
              {monthLabel(month)}
            </span>
            <Button
              variant="quiet"
              size="icon"
              isDisabled
              aria-label={`Next month, ${monthLabel(shiftMonth(month, 1))}`}
            >
              <Icon name="chevronRight" />
            </Button>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          shape="pill"
          weight="medium"
          className="self-start"
        >
          <Icon name="filter" size={18} /> All categories{" "}
          <Icon name="chevronDown" size={16} />
        </Button>
      </header>

      {groupByDay(transactions).map(([date, items]) => {
        const spent = sumCents(
          items.map((t) =>
            t.direction === "outflow" ? t.amountCents : -t.amountCents,
          ),
        );
        const headingId = `day-${date}`;
        return (
          <section
            key={date}
            aria-labelledby={headingId}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-baseline justify-between px-1">
              <h2 id={headingId} className="text-sm font-semibold text-fg">
                {dayLabel(date, budget.today)}
                {dayLabel(date, budget.today) !== shortDate(date) ? (
                  <span className="font-normal text-fg-muted">
                    {" "}
                    · {shortDate(date)}
                  </span>
                ) : null}
              </h2>
              <span className="text-xs text-fg-muted">
                {spent >= 0 ? "Spent " : "Received "}
                <Money cents={Math.abs(spent)} />
              </span>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1">
              {items.map((t) => (
                <li key={t.id}>
                  <TransactionRow transaction={t} today={budget.today} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <Button variant="secondary" size="md" className="my-2 w-full">
        Load more
      </Button>
    </div>
  );
}

// /budgets/{budgetId}/transactions (J4): the month's transactions grouped by
// day, newest first, filtered by month and category, cursor-paged with an
// explicit "Load more" (keyboard and screen-reader friendly). Tapping a row
// opens it for editing or deleting.
import { useMemo } from "react";
import type { Transaction } from "../../api/types.ts";
import { useCategories, useTransactions } from "../../app/data.ts";
import { navigate, useLocation, withSearch } from "../../app/router.tsx";
import { Button } from "../../components/Button.tsx";
import { Money } from "../../components/Money.tsx";
import { MonthNav } from "../../components/MonthNav.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../components/States.tsx";
import { dayLabel, monthLabel, shortDate } from "../../lib/dates.ts";
import { sumCents } from "../../lib/splits.ts";
import { monthFrom, useCurrentBudget } from "./BudgetLayout.tsx";
import { TransactionRow } from "./TransactionRow.tsx";

export function groupByDay(
  items: readonly Transaction[],
): [string, Transaction[]][] {
  const groups = new Map<string, Transaction[]>();
  for (const t of items) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
  return [...groups.entries()];
}

const UUID = /^[0-9a-f-]{36}$/i;

export default function TransactionsScreen() {
  const { budget, openEdit, openQuickAdd } = useCurrentBudget();
  const location = useLocation();
  const month = monthFrom(location.search, budget);
  const categoryParam = location.search.get("category");
  const categoryId =
    categoryParam && UUID.test(categoryParam) ? categoryParam : null;
  const categories = useCategories(budget.id);
  const list = useTransactions(budget.id, { month, categoryId });
  const items = useMemo(
    () => list.data?.pages.flatMap((p) => p.items) ?? [],
    [list.data],
  );
  const allCategories = categories.data?.items ?? [];
  const filterName = categoryId
    ? allCategories.find((c) => c.id === categoryId)?.name
    : null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 px-4 pt-4 lg:px-8 lg:pt-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold text-fg">Transactions</h1>
          <MonthNav month={month} currentMonth={budget.currentMonth} />
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-fg sm:max-w-xs">
          Category
          <select
            value={categoryId ?? ""}
            onChange={(e) => {
              navigate(
                withSearch(location, { category: e.target.value || null }),
                { replace: true },
              );
            }}
            className="min-h-touch rounded-full border border-line-strong bg-surface px-4 text-base font-medium text-fg"
            data-testid="category-filter"
          >
            <option value="">All categories</option>
            {allCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>

      {list.isPending ? (
        <LoadingState label="Loading transactions…" />
      ) : list.isError && items.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            filterName
              ? `No ${filterName} transactions in ${monthLabel(month)}`
              : `Nothing in ${monthLabel(month)} yet`
          }
          action={
            <Button onPress={openQuickAdd} data-testid="empty-add">
              Add a transaction
            </Button>
          }
        />
      ) : (
        <>
          {groupByDay(items).map(([date, dayItems]) => {
            const net = sumCents(
              dayItems.map((t) =>
                t.direction === "outflow" ? t.amountCents : -t.amountCents,
              ),
            );
            const headingId = `day-${date}`;
            const label = dayLabel(date, budget.today);
            return (
              <section
                key={date}
                aria-labelledby={headingId}
                className="flex flex-col gap-1.5"
              >
                <div className="flex items-baseline justify-between px-1">
                  <h2 id={headingId} className="text-sm font-semibold text-fg">
                    {label}
                    {label !== shortDate(date) ? (
                      <span className="font-normal text-fg-muted">
                        {" "}
                        · {shortDate(date)}
                      </span>
                    ) : null}
                  </h2>
                  {net !== 0 ? (
                    <span className="text-xs text-fg-muted">
                      {net > 0 ? "Spent " : "Received "}
                      <Money cents={Math.abs(net)} />
                    </span>
                  ) : null}
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1">
                  {dayItems.map((t) => (
                    <li key={t.id}>
                      <TransactionRow
                        transaction={t}
                        categories={allCategories}
                        today={budget.today}
                        onOpen={openEdit}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {list.isFetchNextPageError ? (
            <ErrorState
              error={list.error}
              title="Couldn't load more"
              onRetry={() => void list.fetchNextPage()}
            />
          ) : null}
          {list.hasNextPage ? (
            <Button
              variant="secondary"
              className="my-2 w-full"
              isPending={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
              data-testid="load-more"
            >
              Load more
            </Button>
          ) : (
            <p className="py-3 text-center text-sm text-fg-muted">
              {items.length === 1
                ? "1 transaction"
                : `${String(items.length)} transactions`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

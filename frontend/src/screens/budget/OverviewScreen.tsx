// /budgets/{budgetId}: the month at a glance (J3). Every number comes from
// GET …/summary; overspending is shown in words and with an icon, and the
// chart has a table alternative.
import { useState, type ReactNode } from "react";
import { Link } from "react-aria-components";
import type { CategorySummary } from "../../api/types.ts";
import { useCategories, useSummary, useTransactions } from "../../app/data.ts";
import { useLocation } from "../../app/router.tsx";
import { BudgetBar } from "../../components/BudgetBar.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Money } from "../../components/Money.tsx";
import { MonthNav } from "../../components/MonthNav.tsx";
import { SegmentedControl } from "../../components/SegmentedControl.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../components/States.tsx";
import { daysLeftInMonth, monthLabel, monthName } from "../../lib/dates.ts";
import { monthFrom, useCurrentBudget } from "./BudgetLayout.tsx";
import { TransactionRow } from "./TransactionRow.tsx";

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg bg-surface p-4 shadow-1 ${className}`}>
      {children}
    </section>
  );
}

function Remaining({ line }: { line: CategorySummary }) {
  if (line.remainingCents < 0) {
    return (
      <span className="flex items-center gap-1 text-sm font-semibold text-danger">
        <Icon name="alert" size={16} />
        Over by <Money cents={-line.remainingCents} />
      </span>
    );
  }
  return (
    <span className="text-sm text-fg-muted">
      <Money cents={line.remainingCents} className="font-semibold text-fg" />{" "}
      left
    </span>
  );
}

export function CategoryChart({
  lines,
}: {
  lines: readonly CategorySummary[];
}) {
  return (
    <ul
      className="flex flex-col divide-y divide-line"
      data-testid="category-chart"
    >
      {lines.map((line) => (
        <li
          key={line.categoryId}
          className="flex flex-col gap-2 py-3.5 first:pt-1 last:pb-1"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-base font-medium text-fg">
              {line.name}
              {line.archived ? (
                <span className="text-sm font-normal text-fg-muted">
                  {" "}
                  (archived)
                </span>
              ) : null}
            </span>
            <Remaining line={line} />
          </div>
          <BudgetBar
            plannedCents={line.plannedCents}
            actualCents={line.actualCents}
          />
          <span className="text-xs text-fg-muted">
            <Money cents={line.actualCents} /> spent of{" "}
            <Money cents={line.plannedCents} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CategoryTable({
  lines,
  month,
  totals,
}: {
  lines: readonly CategorySummary[];
  month: string;
  totals: { plannedCents: number; actualCents: number; remainingCents: number };
}) {
  const cell = "px-1 py-2.5 text-right";
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="category-table">
        <caption className="sr-only">
          Spending by category, {monthLabel(month)}
        </caption>
        <thead className="text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-1 py-2 font-medium">
              Category
            </th>
            <th scope="col" className="px-1 py-2 text-right font-medium">
              Planned
            </th>
            <th scope="col" className="px-1 py-2 text-right font-medium">
              Spent
            </th>
            <th scope="col" className="px-1 py-2 text-right font-medium">
              Left
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.map((line) => (
            <tr key={line.categoryId}>
              <th scope="row" className="px-1 py-2.5 font-medium text-fg">
                {line.name}
              </th>
              <td className={cell}>
                <Money cents={line.plannedCents} />
              </td>
              <td className={cell}>
                <Money cents={line.actualCents} />
              </td>
              <td className={cell}>
                {line.remainingCents < 0 ? (
                  <span className="font-semibold text-danger">
                    <Money cents={line.remainingCents} />{" "}
                    <span className="text-xs">(over)</span>
                  </span>
                ) : (
                  <Money cents={line.remainingCents} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-line-strong font-semibold text-fg">
          <tr>
            <th scope="row" className="px-1 py-2.5">
              Total
            </th>
            <td className={cell}>
              <Money cents={totals.plannedCents} />
            </td>
            <td className={cell}>
              <Money cents={totals.actualCents} />
            </td>
            <td className={cell}>
              <Money cents={totals.remainingCents} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function OverviewScreen() {
  const { budget, openEdit } = useCurrentBudget();
  const location = useLocation();
  const month = monthFrom(location.search, budget);
  const summary = useSummary(budget.id, month);
  const categories = useCategories(budget.id);
  const recent = useTransactions(budget.id, { month, categoryId: null }, 5);
  const [view, setView] = useState<"chart" | "table">("chart");

  const header = (
    <header className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg-muted">
          {budget.name}
        </p>
        <h1 className="text-2xl font-semibold text-fg">
          {monthName(month)}
          {month.slice(0, 4) !== budget.currentMonth.slice(0, 4)
            ? ` ${month.slice(0, 4)}`
            : ""}
        </h1>
      </div>
      <MonthNav
        month={month}
        currentMonth={budget.currentMonth}
        showLabel={false}
      />
    </header>
  );

  if (summary.isPending) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-4 lg:px-8 lg:pt-8">
        {header}
        <LoadingState label="Loading this month…" />
      </div>
    );
  }
  if (summary.isError) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-4 lg:px-8 lg:pt-8">
        {header}
        <ErrorState
          error={summary.error}
          onRetry={() => void summary.refetch()}
        />
      </div>
    );
  }

  const data = summary.data;
  const expense = data.totals.expense;
  const income = data.totals.income;
  const expenseLines = data.categories.filter((c) => c.kind === "expense");
  const incomeLines = data.categories.filter((c) => c.kind === "income");
  const overCount = expenseLines.filter((c) => c.remainingCents < 0).length;
  const isCurrent = month === budget.currentMonth;
  const recentItems = recent.data?.pages[0]?.items ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-4 lg:px-8 lg:pt-8">
      {header}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-sm font-medium text-fg-muted">
              {expense.remainingCents < 0 ? "Over budget by" : "Left to spend"}
            </h2>
            <p
              className={`mt-0.5 text-3xl font-semibold ${expense.remainingCents < 0 ? "text-danger" : "text-fg"}`}
              data-testid="total-remaining"
            >
              <Money cents={Math.abs(expense.remainingCents)} />
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              <Money cents={expense.actualCents} /> spent of{" "}
              <Money cents={expense.plannedCents} /> planned
            </p>
            <BudgetBar
              className="mt-3"
              plannedCents={expense.plannedCents}
              actualCents={expense.actualCents}
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {isCurrent ? (
                <span className="text-fg-muted">
                  {daysLeftInMonth(budget.today)} days left
                </span>
              ) : null}
              {overCount > 0 ? (
                <span className="flex items-center gap-1 font-medium text-danger">
                  <Icon name="alert" size={16} />
                  {overCount === 1
                    ? "1 category over"
                    : `${String(overCount)} categories over`}
                </span>
              ) : null}
            </div>
          </Card>

          {expenseLines.length === 0 ? (
            <EmptyState
              icon="budgets"
              title="No spending categories yet"
              action={
                <Link
                  href={`/budgets/${budget.id}/categories`}
                  className="font-semibold text-brand"
                >
                  Set up categories
                </Link>
              }
            >
              Categories and monthly limits are how Shoestring knows what's
              left.
            </EmptyState>
          ) : (
            <Card>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-fg">Categories</h2>
                <SegmentedControl
                  label="Show categories as"
                  className="w-40"
                  value={view}
                  onChange={setView}
                  options={[
                    { id: "chart", label: "Chart" },
                    { id: "table", label: "Table" },
                  ]}
                />
              </div>
              {expense.plannedCents === 0 ? (
                <p className="mb-2 text-sm text-fg-muted">
                  No monthly limits are set for {monthLabel(month)} yet.
                </p>
              ) : null}
              {view === "chart" ? (
                <CategoryChart lines={expenseLines} />
              ) : (
                <CategoryTable
                  lines={expenseLines}
                  month={month}
                  totals={expense}
                />
              )}
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {incomeLines.length > 0 ? (
            <Card>
              <h2 className="text-lg font-semibold text-fg">Income</h2>
              <p className="mt-1 text-sm text-fg-muted">
                <Money
                  cents={income.actualCents}
                  className="font-semibold text-fg"
                />{" "}
                received of <Money cents={income.plannedCents} /> expected
              </p>
            </Card>
          ) : null}
          <Card className="pb-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-fg">Recent</h2>
              <Link
                href={`/budgets/${budget.id}/transactions${isCurrent ? "" : `?month=${month}`}`}
                className="flex min-h-touch items-center text-sm font-semibold text-brand"
              >
                See all
              </Link>
            </div>
            {recent.isError ? (
              <ErrorState
                error={recent.error}
                onRetry={() => void recent.refetch()}
              />
            ) : recent.isPending ? (
              <LoadingState rows={2} />
            ) : recentItems.length === 0 ? (
              <p className="pb-3 text-sm text-fg-muted">
                Nothing recorded in {monthLabel(month)} yet. Tap + to add a
                transaction.
              </p>
            ) : (
              <ul className="-mx-4 divide-y divide-line">
                {recentItems.map((t) => (
                  <li key={t.id}>
                    <TransactionRow
                      transaction={t}
                      categories={categories.data?.items ?? []}
                      today={budget.today}
                      showDate
                      onOpen={openEdit}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

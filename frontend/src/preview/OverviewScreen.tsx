// DEV PREVIEW ONLY: the month overview (J3) with mock data. Numbers come only
// from the MonthSummary shape, as they will from GET …/summary.
import { useState, type ReactNode } from "react";
import type { CategorySummary } from "../api/types.ts";
import { BudgetBar } from "../components/BudgetBar.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Money } from "../components/Money.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import {
  daysLeftInMonth,
  monthLabel,
  monthName,
  shiftMonth,
} from "../lib/dates.ts";
import { budget, summary, transactions } from "./mock-data.ts";
import { TransactionRow } from "./TransactionRow.tsx";

export type OverviewView = "chart" | "table";

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

function CategoryChart({ lines }: { lines: CategorySummary[] }) {
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

function CategoryTable({
  lines,
  month,
}: {
  lines: CategorySummary[];
  month: string;
}) {
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
              <td className="px-1 py-2.5 text-right">
                <Money cents={line.plannedCents} />
              </td>
              <td className="px-1 py-2.5 text-right">
                <Money cents={line.actualCents} />
              </td>
              <td className="px-1 py-2.5 text-right">
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
            <td className="px-1 py-2.5 text-right">
              <Money cents={summary.totals.expense.plannedCents} />
            </td>
            <td className="px-1 py-2.5 text-right">
              <Money cents={summary.totals.expense.actualCents} />
            </td>
            <td className="px-1 py-2.5 text-right">
              <Money cents={summary.totals.expense.remainingCents} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

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

export function OverviewScreen({
  initialView = "chart",
}: {
  initialView?: OverviewView;
}) {
  const [view, setView] = useState<OverviewView>(initialView);
  const month = summary.month;
  const expense = summary.totals.expense;
  const income = summary.totals.income;
  const expenseLines = summary.categories.filter((c) => c.kind === "expense");
  const overCount = expenseLines.filter((c) => c.remainingCents < 0).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-4 lg:px-8 lg:pt-8">
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg-muted">
            {budget.name} budget
          </p>
          <h1 className="text-2xl font-semibold text-fg">{monthName(month)}</h1>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="quiet"
            size="icon"
            aria-label={`Previous month, ${monthLabel(shiftMonth(month, -1))}`}
          >
            <Icon name="chevronLeft" />
          </Button>
          <Button
            variant="quiet"
            size="icon"
            isDisabled
            aria-label={`Next month, ${monthLabel(shiftMonth(month, 1))}`}
          >
            <Icon name="chevronRight" />
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-sm font-medium text-fg-muted">Left to spend</h2>
            <p
              className="mt-0.5 text-3xl font-semibold text-fg"
              data-testid="total-remaining"
            >
              <Money cents={expense.remainingCents} />
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
              <span className="text-fg-muted">
                {daysLeftInMonth(budget.today)} days left
              </span>
              {overCount > 0 ? (
                <span className="flex items-center gap-1 font-medium text-danger">
                  <Icon name="alert" size={16} />
                  {overCount === 1
                    ? "1 category over"
                    : `${overCount} categories over`}
                </span>
              ) : null}
            </div>
          </Card>

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
            {view === "chart" ? (
              <CategoryChart lines={expenseLines} />
            ) : (
              <CategoryTable lines={expenseLines} month={month} />
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
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
          <Card className="pb-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-fg">Recent</h2>
              <a
                href="/transactions"
                className="flex min-h-touch items-center text-sm font-semibold text-brand"
              >
                See all
              </a>
            </div>
            <ul className="-mx-4 divide-y divide-line">
              {transactions.slice(0, 4).map((t) => (
                <li key={t.id}>
                  <TransactionRow
                    transaction={t}
                    today={budget.today}
                    showDate
                  />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

# ADR-0004: Budgeting method and month rules
- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-12
- Areas affected: data, backend, frontend, tests

## Context
The budgeting method shapes the core entities and the summary math, and "totals are always right" is a core promise. The owner chose monthly limits per category (no envelopes, no rollover) and split transactions in the MVP.

## Decision
- **Plan:** for each budget, month and category there is at most one **plan entry** (`amountCents ≥ 0`). A missing entry means 0. The "monthly plan" is the set of entries for a month. There is no rollover between months.
- **Categories** have a `kind`: `expense` (planned = a spending limit) or `income` (planned = expected income). Kind is immutable. Categories used by any split are **archived, not deleted**; archived categories accept no new splits or plan entries but stay in historical summaries.
- **Transactions** have a positive `amountCents`, a `direction` (`outflow` = money spent, `inflow` = money received: income or a refund), a calendar `date`, optional payee and memo, and **1–20 splits** (distinct categories, positive amounts, summing exactly to the parent). An ordinary transaction has one split. The database enforces the sum.
- **Month of a transaction** = the `YYYY-MM` of its `date`. No timezone conversion is applied to dates.
- **Summary formulas** (server only; the client never recomputes totals). For month M and category c, over non-deleted transactions dated in M:
  - `out(c)` = sum of split amounts on `outflow` transactions; `in(c)` = sum on `inflow` transactions.
  - expense category: `actual = out − in` (spent, net of refunds); `remaining = planned − actual` (negative = overspent).
  - income category: `actual = in − out` (received); `remaining = planned − actual` (still expected).
  - Totals per kind: sums of planned, actual and remaining over the categories listed. Listed categories: every non-archived category plus archived ones with a plan entry or activity in M.
- **Copy last month (J5):** copies entries from M−1 for non-archived categories; by default only fills categories with no entry in M; `overwrite: true` replaces. Atomic.
- **Starter categories:** a client-side suggestion list; `POST /budgets` accepts the chosen categories and this month's amounts in one atomic call.

## Alternatives considered
- **Envelope / zero-based with rollover (YNAB style):** more powerful, but needs carry-over balances, "to be budgeted" logic and a heavier mental model. Not in the MVP; the plan-entry table can gain a rollover rule later.
- **Signed amounts (negative = spending):** sign confusion in UI, export and split sums; direction + positive amounts makes the split rule "all positive, sum equals parent".
- **Category on the transaction plus optional split rows:** two code paths for every read and the summary; "always at least one split" gives one path.
- **Expense-only categories (no income):** simpler, but the quick-add expense/income toggle and refunds need an inflow concept anyway; income categories add one branch to the formulas.

## Consequences
- One summary query shape; 100% branch coverage on these formulas, split validation and month math is a test gate.
- Seed data must cover: refunds exceeding spend, splits across expense and income categories, archived categories with history, month and year rollover, unplanned spending, and a DST-change date in the budget timezone.
- Changing a category's kind is impossible by design; users archive and create a new one.

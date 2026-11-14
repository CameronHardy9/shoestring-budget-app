import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, mockApi } from "../../test/api-mock.ts";
import { expectNoAxeViolations } from "../../test/axe.ts";
import {
  budget,
  BUDGET_ID,
  categories,
  summary,
  transaction,
  uuid,
} from "../../test/fixtures.ts";
import { renderWithApp } from "../../test/render.tsx";
import { BudgetLayout } from "./BudgetLayout.tsx";
import OverviewScreen from "./OverviewScreen.tsx";
import TransactionsScreen from "./TransactionsScreen.tsx";

const base = {
  [`GET /budgets/${BUDGET_ID}`]: json(200, budget),
  [`GET /budgets/${BUDGET_ID}/categories`]: json(200, { items: categories }),
  [`GET /budgets/${BUDGET_ID}/months/:month/summary`]: json(200, summary),
};

describe("overview", () => {
  it("shows the summary's numbers, overspending in words, and a table alternative", async () => {
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}/transactions`]: json(200, {
        items: [transaction(1, { payee: "Corner Market" })],
        nextCursor: null,
      }),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    expect(await screen.findByTestId("total-remaining")).toHaveTextContent(
      "$164.45",
    );
    expect(screen.getByText(/Over by/)).toHaveTextContent("Over by $23.10");
    expect(screen.getByText("1 category over")).toBeInTheDocument();
    expect(await screen.findByText("Corner Market")).toBeInTheDocument();
    expect(
      api.find("GET", `/budgets/${BUDGET_ID}/months/2026-11/summary`),
    ).toHaveLength(1);
    expect(
      api
        .find("GET", `/budgets/${BUDGET_ID}/transactions`)[0]
        ?.search.get("limit"),
    ).toBe("5");
    await expectNoAxeViolations(view.container);
    await userEvent.click(screen.getByText("Table", { exact: true }));
    const table = screen.getByRole("table", {
      name: /Spending by category, November 2026/,
    });
    expect(within(table).getByText("(over)")).toBeInTheDocument();
  });

  it("follows ?month= and opens quick-add from the + button", async () => {
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}/transactions`]: json(200, {
        items: [],
        nextCursor: null,
      }),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}?month=2026-10` },
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "October" }),
    ).toBeInTheDocument();
    expect(
      api.find("GET", `/budgets/${BUDGET_ID}/months/2026-10/summary`),
    ).toHaveLength(1);
    expect(
      await screen.findByText(/Nothing recorded in October 2026/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("quick-add-open"));
    expect(
      await screen.findByRole("dialog", { name: "Add transaction" }),
    ).toBeInTheDocument();
  });
});

describe("transactions", () => {
  it("groups by day, pages with the cursor, filters by category and opens a row", async () => {
    const page1 = [
      transaction(1, { payee: "Corner Market" }),
      transaction(2, {
        date: "2026-11-13",
        direction: "inflow",
        payee: "Hardware store",
        splits: [{ categoryId: uuid(4), amountCents: 1250 }],
      }),
    ];
    const page2 = [transaction(3, { date: "2026-11-02", payee: "Cinema" })];
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}/transactions`]: (req) =>
        json(
          200,
          req.search.get("cursor") === "next1"
            ? { items: page2, nextCursor: null }
            : { items: page1, nextCursor: "next1" },
        ),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="transactions">
        <TransactionsScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}/transactions` },
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: /Today/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /Yesterday/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("+$12.50")).toBeInTheDocument();
    expect(screen.getByText("Household · refund")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("load-more"));
    expect(await screen.findByText("Cinema")).toBeInTheDocument();
    expect(screen.getByText("3 transactions")).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByTestId("category-filter"),
      "Groceries",
    );
    await waitFor(() => {
      expect(
        api
          .find("GET", `/budgets/${BUDGET_ID}/transactions`)
          .some((c) => c.search.get("categoryId") === uuid(1)),
      ).toBe(true);
    });
    expect(window.location.search).toContain(`category=${uuid(1)}`);
    await userEvent.click(
      (await screen.findAllByTestId("transaction-row"))[0]!,
    );
    expect(
      await screen.findByRole("dialog", { name: "Edit transaction" }),
    ).toBeInTheDocument();
  });
});

import { onlineManager } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { apiError, json, mockApi } from "../../test/api-mock.ts";
import { expectNoAxeViolations } from "../../test/axe.ts";
import {
  budget,
  BUDGET_ID,
  categories,
  summary,
  transaction,
  uuid,
} from "../../test/fixtures.ts";
import { deferred, tappableAfter } from "../../test/layout.ts";
import { renderWithApp } from "../../test/render.tsx";
import { keys } from "../../app/data.ts";
import { BudgetLayout } from "./BudgetLayout.tsx";
import OverviewScreen from "./OverviewScreen.tsx";
import TransactionsScreen from "./TransactionsScreen.tsx";

afterEach(() => {
  onlineManager.setOnline(true);
});

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

describe("offline with nothing cached", () => {
  const TX = `/budgets/${BUDGET_ID}/transactions`;
  // The budget arrives just as the phone goes offline, so the screen's own
  // reads start paused: never sent, never failed.
  const goOffline = () => {
    onlineManager.setOnline(false);
    return json(200, budget);
  };

  it("overview: says so instead of loading forever, then shows the month", async () => {
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}`]: goOffline,
      [`GET ${TX}`]: json(200, { items: [], nextCursor: null }),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    const box = await screen.findByTestId("offline");
    expect(box).toHaveTextContent(
      "You're offline. This month will appear when you reconnect.",
    );
    expect(box).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "November" }),
    ).toBeInTheDocument();
    expect(
      api.find("GET", `/budgets/${BUDGET_ID}/months/2026-11/summary`),
    ).toHaveLength(0);
    await expectNoAxeViolations(view.container);
    onlineManager.setOnline(true);
    expect(await screen.findByTestId("total-remaining")).toHaveTextContent(
      "$164.45",
    );
    expect(screen.queryByTestId("offline")).toBeNull();
  });

  it("overview: the recent list says so when only the summary is cached", async () => {
    const reply = deferred<ReturnType<typeof json>>();
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}`]: () => reply.promise,
      [`GET ${TX}`]: json(200, {
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
    view.client.setQueryData(keys.summary(BUDGET_ID, "2026-11"), summary);
    onlineManager.setOnline(false);
    reply.resolve(json(200, budget));
    expect(await screen.findByTestId("total-remaining")).toHaveTextContent(
      "$164.45",
    );
    expect(await screen.findByTestId("offline")).toHaveTextContent(
      "You're offline. Recent transactions will appear when you reconnect.",
    );
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(api.find("GET", TX)).toHaveLength(0);
    onlineManager.setOnline(true);
    expect(await screen.findByText("Corner Market")).toBeInTheDocument();
    expect(screen.queryByTestId("offline")).toBeNull();
  });

  it("transactions: says so instead of loading forever, then lists them", async () => {
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}`]: goOffline,
      [`GET ${TX}`]: json(200, {
        items: [transaction(1, { payee: "Corner Market" })],
        nextCursor: null,
      }),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="transactions">
        <TransactionsScreen />
      </BudgetLayout>,
      { path: TX },
    );
    const box = await screen.findByTestId("offline");
    expect(box).toHaveTextContent(
      "You're offline. Transactions will appear when you reconnect.",
    );
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(api.find("GET", TX)).toHaveLength(0);
    await expectNoAxeViolations(view.container);
    onlineManager.setOnline(true);
    expect(await screen.findByText("Corner Market")).toBeInTheDocument();
    expect(screen.queryByTestId("offline")).toBeNull();
  });
});

describe("quick-add before the budget has loaded", () => {
  type Reply = ReturnType<typeof json>;
  const TX = `/budgets/${BUDGET_ID}/transactions`;

  function renderLoading(budgetReply: () => Reply | Promise<Reply>) {
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}`]: budgetReply,
      [`GET ${TX}`]: json(200, { items: [], nextCursor: null }),
      [`POST ${TX}`]: json(201, transaction(1)),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    return { api, view };
  }

  it("opens the sheet on the first tap, takes the amount at once, and saves with the budget's today", async () => {
    const reply = deferred<Reply>();
    const { api, view } = renderLoading(() => reply.promise);
    expect(screen.getByTestId("loading-slot")).toHaveAttribute(
      "data-label",
      "Loading your budget…",
    );

    await userEvent.click(screen.getByTestId("quick-add-open"));
    const sheet = await screen.findByRole("dialog", {
      name: "Add transaction",
    });
    const amount = within(sheet).getByRole("textbox", { name: "Amount" });
    expect(amount).toHaveFocus();
    await userEvent.type(amount, "12.50");
    // Busy, announced inside the sheet, and the last thing in it: no chip or
    // button exists yet that the loaded content could push or reorder.
    const status = within(sheet).getByTestId("loading");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("Loading categories…");
    expect(tappableAfter(status, sheet)).toEqual([]);
    expect(within(sheet).queryByTestId("quick-add-save")).toBeNull();
    await expectNoAxeViolations(view.baseElement);

    reply.resolve(json(200, budget));
    await userEvent.click(
      await within(sheet).findByText("Groceries", { exact: true }),
    );
    // The same field, still holding what was typed.
    expect(within(sheet).getByRole("textbox", { name: "Amount" })).toBe(amount);
    expect(amount).toHaveValue("12.50");
    await userEvent.click(within(sheet).getByTestId("quick-add-save"));
    await waitFor(() => {
      expect(api.find("POST", TX)[0]?.body).toMatchObject({
        date: budget.today,
        amountCents: 1250,
        splits: [{ categoryId: uuid(1), amountCents: 1250 }],
      });
    });
  });

  it("says so in the sheet when the budget can't load, and recovers on retry", async () => {
    let attempt = 0;
    const first = deferred<Reply>();
    renderLoading(() => (++attempt === 1 ? first.promise : json(200, budget)));
    await userEvent.click(screen.getByTestId("quick-add-open"));
    const sheet = await screen.findByRole("dialog", {
      name: "Add transaction",
    });
    await userEvent.type(
      within(sheet).getByRole("textbox", { name: "Amount" }),
      "4",
    );
    first.resolve(apiError(503, "UNAVAILABLE"));
    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this budget");
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    expect(
      await within(sheet).findByText("Groceries", { exact: true }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "Amount" })).toHaveValue(
      "4",
    );
  });

  it("offline with nothing cached: the page and the sheet say so instead of loading forever", async () => {
    onlineManager.setOnline(false);
    const api = renderLoading(() => json(200, budget)).api;
    expect(await screen.findByTestId("offline")).toHaveTextContent(
      "You're offline. This budget will appear when you reconnect.",
    );
    await userEvent.click(screen.getByTestId("quick-add-open"));
    const sheet = await screen.findByRole("dialog", {
      name: "Add transaction",
    });
    expect(
      within(sheet).getByRole("textbox", { name: "Amount" }),
    ).toHaveFocus();
    expect(within(sheet).getByTestId("offline")).toHaveTextContent(
      "The categories will appear when you reconnect",
    );
    expect(api.find("GET", `/budgets/${BUDGET_ID}`)).toHaveLength(0);
    onlineManager.setOnline(true);
    expect(
      await within(sheet).findByText("Groceries", { exact: true }),
    ).toBeInTheDocument();
  });

  it("shows not found instead of a waiting sheet when the budget is gone", async () => {
    const reply = deferred<Reply>();
    renderLoading(() => reply.promise);
    await userEvent.click(screen.getByTestId("quick-add-open"));
    await screen.findByRole("dialog", { name: "Add transaction" });
    reply.resolve(apiError(404, "NOT_FOUND"));
    expect(
      await screen.findByRole("heading", { name: "Budget not found" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("quick-add chip order and the recent-list prefetch", () => {
  const TX = `/budgets/${BUDGET_ID}/transactions`;
  const isChipOrderQuery = (c: { search: URLSearchParams }) =>
    c.search.get("limit") === "50" &&
    c.search.get("month") === budget.currentMonth &&
    !c.search.has("categoryId");

  /** A budget page whose recent list reflects what has been saved. */
  function renderWithSaves(child = <OverviewScreen />) {
    const saved: ReturnType<typeof transaction>[] = [];
    const api = mockApi({
      ...base,
      [`GET ${TX}`]: () =>
        json(200, { items: [...saved].reverse(), nextCursor: null }),
      [`POST ${TX}`]: (req) => {
        const body = req.body as { splits: { categoryId: string }[] };
        const t = transaction(saved.length + 1, {
          splits: [
            { categoryId: body.splits[0]!.categoryId, amountCents: 100 },
          ],
        });
        saved.push(t);
        return json(201, t);
      },
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        {child}
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    return api;
  }

  async function chipNames(): Promise<string[]> {
    const sheet = await screen.findByTestId("quick-add-sheet");
    const group = await within(sheet).findByRole("radiogroup", {
      name: "Category",
    });
    return within(group)
      .getAllByRole("radio")
      .map((r) => r.textContent);
  }

  it("keeps the chip order through Save & new; the category just used leads next time", async () => {
    const api = renderWithSaves();
    await screen.findByTestId("total-remaining");
    await userEvent.click(screen.getByTestId("quick-add-open"));
    const first = await chipNames();
    expect(first.slice(0, 4)).toEqual([
      "Groceries",
      "Dining out",
      "Transport",
      "Household",
    ]);

    const sheet = screen.getByTestId("quick-add-sheet");
    await userEvent.type(
      within(sheet).getByRole("textbox", { name: "Amount" }),
      "1",
    );
    await userEvent.click(
      within(sheet).getByText("Household", { exact: true }),
    );
    await userEvent.click(within(sheet).getByTestId("quick-add-save-new"));
    await waitFor(() => {
      expect(within(sheet).getByTestId("sheet-status")).toHaveTextContent(
        "Saved $1.00 to Household",
      );
    });
    // The recent list was refetched (Household is now the most recent)...
    await waitFor(() => {
      expect(api.find("GET", TX).filter(isChipOrderQuery).length).toBe(2);
    });
    // ...but nothing moved in the open sheet.
    expect(await chipNames()).toEqual(first);

    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("quick-add-sheet")).toBeNull();
    });
    await userEvent.click(screen.getByTestId("quick-add-open"));
    expect((await chipNames())[0]).toBe("Household");
  });

  it("prefetches the chip-order list once per budget page, without holding up the page, and the sheet reuses it", async () => {
    const recent = deferred<ReturnType<typeof json>>();
    const api = mockApi({
      ...base,
      [`GET ${TX}`]: () => recent.promise,
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <h1>Page body</h1>
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    // The page renders while the prefetch is still in flight.
    expect(
      await screen.findByRole("heading", { name: "Page body" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(api.find("GET", TX).filter(isChipOrderQuery)).toHaveLength(1);
    });
    recent.resolve(
      json(200, {
        items: [
          transaction(1, {
            splits: [{ categoryId: uuid(3), amountCents: 1250 }],
          }),
        ],
        nextCursor: null,
      }),
    );
    await userEvent.click(screen.getByTestId("quick-add-open"));
    expect((await chipNames())[0]).toBe("Transport");
    expect(api.find("GET", TX).filter(isChipOrderQuery)).toHaveLength(1);
  });

  it("offline: chips still come, in the default order, when the recent list can't load", async () => {
    const reply = deferred<ReturnType<typeof json>>();
    const api = mockApi({
      ...base,
      [`GET /budgets/${BUDGET_ID}`]: () => reply.promise,
      [`GET ${TX}`]: json(200, { items: [], nextCursor: null }),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <h1>Page body</h1>
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    await waitFor(() => {
      expect(api.find("GET", `/budgets/${BUDGET_ID}/categories`)).toHaveLength(
        1,
      );
    });
    onlineManager.setOnline(false);
    reply.resolve(json(200, budget));
    await screen.findByRole("heading", { name: "Page body" });
    await userEvent.click(screen.getByTestId("quick-add-open"));
    expect((await chipNames()).slice(0, 2)).toEqual([
      "Groceries",
      "Dining out",
    ]);
    expect(api.find("GET", TX)).toHaveLength(0);
  });

  it("falls back to the default chip order when the prefetch fails", async () => {
    mockApi({ ...base, [`GET ${TX}`]: apiError(500, "INTERNAL") });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <h1>Page body</h1>
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    await screen.findByRole("heading", { name: "Page body" });
    await userEvent.click(screen.getByTestId("quick-add-open"));
    expect((await chipNames()).slice(0, 2)).toEqual([
      "Groceries",
      "Dining out",
    ]);
  });
});

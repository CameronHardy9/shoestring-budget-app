// Long names on the month's screens. jsdom has no layout, so these pin what it
// can see: the whole text is in the page, nothing clips it, and the classes
// that let it wrap are there. That nothing scrolls sideways is checked in a
// real browser (see frontend/CLAUDE.md, "Text the person typed").
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategorySummary } from "../../api/types.ts";
import { json, mockApi } from "../../test/api-mock.ts";
import { expectNoAxeViolations } from "../../test/axe.ts";
import {
  budget,
  BUDGET_ID,
  category,
  summary,
  transaction,
  uuid,
} from "../../test/fixtures.ts";
import { renderWithApp } from "../../test/render.tsx";
import { BudgetLayout } from "./BudgetLayout.tsx";
import OverviewScreen, {
  CategoryChart,
  CategoryTable,
} from "./OverviewScreen.tsx";
import { TransactionRow } from "./TransactionRow.tsx";

const LONG = "Home repairs, garden and maintenance";
const WORD = "x".repeat(40);

const line = (
  name: string,
  patch: Partial<CategorySummary> = {},
): CategorySummary => ({
  categoryId: uuid(1),
  name,
  kind: "expense",
  archived: false,
  plannedCents: 10000,
  actualCents: 2500,
  remainingCents: 7500,
  ...patch,
});
const totals = { plannedCents: 10000, actualCents: 2500, remainingCents: 7500 };

/** No ancestor up to `root` cuts text off (truncate, line-clamp, hidden). */
function expectNotClipped(el: Element, root: Element) {
  for (let e: Element | null = el; e && e !== root; e = e.parentElement)
    expect(e.getAttribute("class") ?? "").not.toMatch(
      /\b(truncate|line-clamp-|whitespace-nowrap|overflow-hidden)/,
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overview", () => {
  it("keeps one shrinkable column, so text can't widen the page", async () => {
    mockApi({
      [`GET /budgets/${BUDGET_ID}`]: json(200, { ...budget, name: WORD }),
      [`GET /budgets/${BUDGET_ID}/categories`]: json(200, {
        items: [category(1, LONG)],
      }),
      [`GET /budgets/${BUDGET_ID}/months/:month/summary`]: json(200, {
        ...summary,
        categories: [line(LONG)],
      }),
      [`GET /budgets/${BUDGET_ID}/transactions`]: json(200, {
        items: [transaction(1)],
        nextCursor: null,
      }),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    const chart = await screen.findByTestId("category-chart");
    expect(chart).toHaveTextContent(LONG);
    expect(chart.closest(".grid")).toHaveClass("grid-cols-1");
    const main = view.container.querySelector("main");
    if (!main) throw new Error("no <main>");
    for (const el of [
      ...screen.getAllByText(LONG),
      ...screen.getAllByText(WORD),
    ])
      expectNotClipped(el, main);
  });

  it.each([
    [999_999, "text-total"],
    [1_000_000, "text-total-long"],
    [-1_000_000, "text-total-long"],
  ])("sizes a total of %i cents with %s", async (remainingCents, size) => {
    mockApi({
      [`GET /budgets/${BUDGET_ID}`]: json(200, budget),
      [`GET /budgets/${BUDGET_ID}/categories`]: json(200, { items: [] }),
      [`GET /budgets/${BUDGET_ID}/months/:month/summary`]: json(200, {
        ...summary,
        totals: {
          ...summary.totals,
          expense: { ...summary.totals.expense, remainingCents },
        },
      }),
      [`GET /budgets/${BUDGET_ID}/transactions`]: json(200, {
        items: [],
        nextCursor: null,
      }),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="overview">
        <OverviewScreen />
      </BudgetLayout>,
      { path: `/budgets/${BUDGET_ID}` },
    );
    expect((await screen.findByTestId("total-remaining")).classList).toContain(
      size,
    );
  });
});

describe("category chart", () => {
  it.each([
    ["left", { actualCents: -2500, remainingCents: 12500 }],
    ["over", { actualCents: 12500, remainingCents: -2500 }],
  ])("wraps the whole name, amount kept in one piece (%s)", (_, patch) => {
    const { container } = render(<CategoryChart lines={[line(WORD, patch)]} />);
    const name = screen.getByText(WORD);
    expectNotClipped(name, container);
    expect(name).toHaveClass("wrap-anywhere", "min-w-0");
    expect(name.parentElement).toHaveClass("flex-wrap");
    for (const money of container.querySelectorAll(".tabular"))
      expect(money).toHaveClass("whitespace-nowrap");
  });
});

describe("category table", () => {
  it("breaks only names with a word too long to keep whole", () => {
    render(
      <CategoryTable
        lines={[line(LONG), line(WORD, { categoryId: uuid(2) })]}
        month="2026-11"
        totals={totals}
      />,
    );
    const plain = screen.getByRole("rowheader", { name: LONG });
    expect(plain.childElementCount).toBe(0);
    expect(screen.getByText(WORD)).toHaveClass("wrap-anywhere");
  });

  it("is a labelled tab stop only while it scrolls inside its card", async () => {
    let measure = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { container, unmount } = render(
      <CategoryTable lines={[line(LONG)]} month="2026-11" totals={totals} />,
    );
    const box = screen.getByRole("table").parentElement;
    if (!box) throw new Error("no scroll container");
    let width = 300;
    Object.defineProperty(box, "clientWidth", { get: () => 300 });
    Object.defineProperty(box, "scrollWidth", { get: () => width });
    act(() => {
      measure();
    });
    expect(screen.queryByRole("region")).toBeNull();
    expect(box).not.toHaveAttribute("tabindex");

    width = 420;
    act(() => {
      measure();
    });
    expect(
      screen.getByRole("region", {
        name: "Spending by category, November 2026",
      }),
    ).toBe(box);
    await userEvent.tab();
    expect(box).toHaveFocus();
    await expectNoAxeViolations(container);

    width = 300;
    act(() => {
      measure();
    });
    await waitFor(() => {
      expect(box).not.toHaveAttribute("tabindex");
    });
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("transaction row", () => {
  const cats = [category(1, LONG), category(2, WORD), category(3, "Rent")];
  const row = (patch: Parameters<typeof transaction>[1]) =>
    render(
      <TransactionRow
        transaction={transaction(1, patch)}
        categories={cats}
        today="2026-11-14"
        showDate
        onOpen={() => {}}
      />,
    );

  it("shows a split's whole category names, the refund and the date", () => {
    const { container } = row({
      payee: "y".repeat(100),
      direction: "inflow",
      splits: [1, 2, 3].map((n) => ({ categoryId: uuid(n), amountCents: 100 })),
    });
    const detail = screen.getByText(
      `Split: ${LONG}, ${WORD}, Rent · refund · Today`,
    );
    expectNotClipped(detail, container);
    expectNotClipped(screen.getByText("y".repeat(100)), container);
  });

  it("limits a memo used as the title to three lines (the sheet has it all)", () => {
    row({ memo: "z".repeat(500) });
    expect(screen.getByText("z".repeat(500))).toHaveClass("line-clamp-3");
  });

  it("never limits a category used as the title", () => {
    const { container } = row({
      splits: [{ categoryId: uuid(2), amountCents: 1 }],
    });
    expectNotClipped(screen.getByText(WORD), container);
  });
});

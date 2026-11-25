// Moving between months, and between category filters on Transactions (owner
// rulings 2026-11-25): the loader leaves as soon as the data is there. By
// cause: only on a screen that has shown content. Cold starts and tabs keep
// whole cycles.
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../../app/router.tsx";
import { LACE_CYCLE_MS, LACE_GRACE_MS } from "../../components/lace-timing.ts";
import { registerPageLoad } from "../../components/page-loader.ts";
import { apiError, json, mockApi } from "../../test/api-mock.ts";
import {
  budget,
  BUDGET_ID,
  categories,
  plan,
  summary,
  transaction,
  uuid,
} from "../../test/fixtures.ts";
import { deferred } from "../../test/layout.ts";
import { renderWithApp } from "../../test/render.tsx";
import { BudgetLayout } from "./BudgetLayout.tsx";
import CategoriesScreen from "./CategoriesScreen.tsx";
import OverviewScreen from "./OverviewScreen.tsx";
import TransactionsScreen from "./TransactionsScreen.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const overlay = () => screen.queryByTestId("loading");

/** Month data held until released, by "2026-10" or, filtered, "2026-11+1". */
function heldMonths() {
  const gates = new Map<string, ReturnType<typeof deferred<undefined>>>();
  const gate = (key: string) => {
    const g = gates.get(key) ?? deferred<undefined>();
    gates.set(key, g);
    return g;
  };
  return {
    hold: (key: string) => gate(key).promise,
    holdAgain: (key: string) => {
      gates.delete(key);
    },
    release: async (key: string) => {
      gate(key).resolve(undefined);
      await wait(0);
      await wait(5);
    },
  };
}

const screens = [
  {
    name: "Overview",
    path: "",
    active: "overview" as const,
    Screen: OverviewScreen,
    loaded: () => screen.queryByTestId("total-remaining"),
  },
  {
    name: "Transactions",
    path: "/transactions",
    active: "transactions" as const,
    Screen: TransactionsScreen,
    loaded: () => screen.queryByText("1 transaction"),
  },
  {
    name: "Categories",
    path: "/categories",
    active: "budgets" as const,
    Screen: CategoriesScreen,
    loaded: () => screen.queryByText(/Planned spending for/),
  },
];

function start(
  index: number,
  fail: string[] = [],
  { fromAnotherTab = false } = {},
) {
  const { name, path, active, Screen, loaded } = screens[index]!;
  const months = heldMonths();
  const B = `/budgets/${BUDGET_ID}`;
  mockApi({
    [`GET ${B}`]: json(200, budget),
    [`GET ${B}/categories`]: json(200, { items: categories }),
    [`GET ${B}/months/:month/summary`]: async (_, { month = "" }) => {
      await months.hold(month);
      return fail.includes(month)
        ? apiError(409, "VERSION_CONFLICT")
        : json(200, { ...summary, month });
    },
    [`GET ${B}/months/:month/plan`]: async (_, { month = "" }) => {
      await months.hold(month);
      return json(200, plan(month));
    },
    [`GET ${B}/transactions`]: async (req) => {
      // Only the screen's own list (not the layout's chip-order prefetch).
      const month = req.search.get("month") ?? "";
      const category = req.search.get("categoryId");
      const key =
        month + (category ? `+${String(Number(category.slice(-12)))}` : "");
      if (name === "Transactions") {
        await months.hold(key);
        if (fail.includes(key)) return apiError(500, "INTERNAL");
      }
      return json(200, { items: [transaction(1)], nextCursor: null });
    },
  });
  let openTab: () => void = () => undefined;
  function Tabs() {
    const [open, setOpen] = useState(!fromAnotherTab);
    openTab = () => {
      setOpen(true);
    };
    return open ? <Screen /> : <h1>Another tab</h1>;
  }
  renderWithApp(
    <BudgetLayout budgetId={BUDGET_ID} active={active}>
      <Tabs />
    </BudgetLayout>,
    { path: `${B}${path}` },
  );
  return {
    months,
    loaded,
    path: `${B}${path}`,
    openTab: () => {
      act(openTab);
    },
  };
}

/** The first month, released in the grace: content, no loader. */
async function startLoaded(index: number, fail: string[] = []) {
  const view = start(index, fail);
  await wait(10);
  await view.months.release("2026-11");
  await wait(20);
  expect(view.loaded()).toBeInTheDocument();
  await wait(1000);
  expect(overlay()).toBeNull();
  return view;
}

/** Keyboard or screen-reader activation (user-event stalls on fake timers). */
function tap(label: RegExp) {
  const link = screen.getByRole("link", { name: label });
  act(() => {
    link.focus();
  });
  fireEvent.click(link);
}

describe.each(screens.map((s, i) => [s.name, i] as const))(
  "%s: months",
  (_, index) => {
    it("the first month is held for a whole cycle", async () => {
      const { months, loaded } = start(index);
      await wait(LACE_GRACE_MS + 500);
      expect(overlay()).not.toBeNull();
      await months.release("2026-11");
      await wait(100);
      expect(loaded()).toBeInTheDocument();
      expect(overlay()).not.toBeNull();
      await wait(LACE_CYCLE_MS);
      expect(overlay()).toBeNull();
    });

    it("so is the first month of a tab opened later, its only load", async () => {
      const { months, loaded, openTab } = start(index, [], {
        fromAnotherTab: true,
      });
      // The budget, its categories and their session are long done.
      await wait(LACE_CYCLE_MS * 2);
      openTab();
      await wait(LACE_GRACE_MS + 500);
      expect(overlay()).not.toBeNull();
      await months.release("2026-11");
      await wait(100);
      expect(loaded()).toBeInTheDocument();
      expect(overlay()).not.toBeNull();
      await wait(LACE_CYCLE_MS);
      expect(overlay()).toBeNull();
    });

    it("the next one leaves as soon as it has loaded, mid-cycle; the arrow keeps focus", async () => {
      const { months, loaded } = await startLoaded(index);
      tap(/^Previous month/);
      const arrow = screen.getByRole("link", { name: /^Previous month/ });
      await wait(LACE_GRACE_MS - 20);
      expect(overlay()).toBeNull();
      expect(arrow).toHaveFocus();
      await wait(20 + 700);
      expect(overlay()).not.toBeNull();
      // What a browser does to focus inside an inert page.
      arrow.blur();
      await months.release("2026-10");
      expect(loaded()).toBeInTheDocument();
      expect(overlay()).toBeNull();
      expect(arrow).toHaveFocus();
    });

    it("a quick switch shows no loader and keeps focus on the arrow", async () => {
      const { months, loaded } = await startLoaded(index);
      tap(/^Next month/);
      await wait(60);
      await months.release("2026-12");
      expect(loaded()).toBeInTheDocument();
      await wait(LACE_CYCLE_MS);
      expect(overlay()).toBeNull();
      expect(screen.getByRole("link", { name: /^Next month/ })).toHaveFocus();
    });
  },
);

describe("what is and isn't a month switch", () => {
  it("rapid taps: the last month's data ends it, nothing gets stuck", async () => {
    const { months, loaded } = await startLoaded(0);
    tap(/^Previous month/);
    await wait(60);
    tap(/^Previous month/);
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    // The month passed over doesn't end it.
    await months.release("2026-10");
    await wait(300);
    expect(overlay()).not.toBeNull();
    await months.release("2026-09");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "September" }),
    ).toBeInTheDocument();
  });

  it("any other way to another month (back, a link) is one too", async () => {
    const { months, loaded, path } = await startLoaded(0);
    act(() => {
      navigate(`${path}?month=2026-08`);
    });
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    await months.release("2026-08");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it("a month asked for before the first one was ever shown is not one", async () => {
    const { months, path } = start(0);
    await wait(50);
    act(() => {
      navigate(`${path}?month=2026-10`);
    });
    await wait(LACE_GRACE_MS + 500);
    await months.release("2026-10");
    await wait(0);
    expect(overlay()).not.toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });

  it("a month that fails shows its error at once", async () => {
    const { months } = await startLoaded(0, ["2026-10"]);
    tap(/^Previous month/);
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    await months.release("2026-10");
    expect(screen.getByTestId("error")).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });
});

describe("Transactions: the category filter", () => {
  const filter = () => screen.getByTestId("category-filter");

  /** As a person does: the filter has focus and gets a value ("" = all). */
  function choose(category: string) {
    act(() => {
      filter().focus();
    });
    fireEvent.change(filter(), { target: { value: category } });
  }

  /** The lace is up, well before any boundary; focus lost, as in a browser. */
  async function untilCovered() {
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
  }

  it("leaves as soon as the list has loaded, and the filter gets focus back", async () => {
    const { months, loaded } = await startLoaded(1);
    choose(uuid(1));
    await wait(LACE_GRACE_MS - 10);
    expect(overlay()).toBeNull();
    expect(filter()).toHaveFocus();
    await wait(10);
    await untilCovered();
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(filter()).toHaveFocus();
    expect(filter()).toHaveValue(uuid(1));
  });

  it("a quick one shows no loader and keeps focus on the filter", async () => {
    const { months, loaded } = await startLoaded(1);
    choose(uuid(1));
    await wait(60);
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(filter()).toHaveFocus();
  });

  it("the first load of a screen opened with a filter is held for a whole cycle", async () => {
    const { months, loaded, path } = start(1);
    act(() => {
      navigate(`${path}?category=${uuid(1)}`, { replace: true });
    });
    await wait(LACE_GRACE_MS + 500);
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).not.toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });

  it("clearing a filter the screen was opened with: the whole list, as soon as it's there", async () => {
    const { months, loaded, path, openTab } = start(1, [], {
      fromAnotherTab: true,
    });
    act(() => {
      navigate(`${path}?category=${uuid(1)}`, { replace: true });
    });
    await wait(LACE_CYCLE_MS * 2);
    openTab();
    await wait(50);
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    await wait(1000);
    choose("");
    await untilCovered();
    await months.release("2026-11");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(filter()).toHaveFocus();
    expect(filter()).toHaveValue("");
  });

  it("clearing back to a list already seen needs no loader", async () => {
    const { months, loaded } = await startLoaded(1);
    choose(uuid(1));
    await untilCovered();
    await months.release("2026-11+1");
    choose("");
    expect(loaded()).toBeInTheDocument();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });

  it("clearing while the filtered list still loads reveals the list at once", async () => {
    const { loaded } = await startLoaded(1);
    choose(uuid(1));
    await untilCovered();
    // Through the address: the covered page can't be used.
    act(() => {
      window.history.replaceState(null, "", window.location.pathname);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await wait(0);
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it("with the month in one step: leaves when that list has loaded", async () => {
    const { months, loaded, path } = await startLoaded(1);
    act(() => {
      navigate(`${path}?month=2026-10&category=${uuid(1)}`);
    });
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    await months.release("2026-10+1");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it.each([
    ["the month, then the filter", true],
    ["the filter, then the month", false],
  ])(
    "%s in quick succession: only the last list ends it, and nothing gets stuck",
    async (_, monthFirst) => {
      const { months, loaded } = await startLoaded(1);
      const steps = [
        () => {
          tap(/^Previous month/);
        },
        () => {
          choose(uuid(1));
        },
      ];
      if (!monthFirst) steps.reverse();
      steps[0]!();
      await wait(60);
      steps[1]!();
      const last = document.activeElement as HTMLElement;
      await wait(LACE_GRACE_MS);
      await untilCovered();
      // The list passed over.
      await months.release(monthFirst ? "2026-10" : "2026-11+1");
      await wait(300);
      expect(overlay()).not.toBeNull();
      await months.release("2026-10+1");
      expect(loaded()).toBeInTheDocument();
      expect(overlay()).toBeNull();
      expect(last).toHaveFocus();
      await wait(LACE_CYCLE_MS);
      expect(overlay()).toBeNull();
    },
  );

  it("a filter switch right after another one's reveal gets its own grace", async () => {
    const { months, loaded } = await startLoaded(1);
    choose(uuid(1));
    await untilCovered();
    await months.release("2026-11+1");
    choose(uuid(2));
    await wait(LACE_GRACE_MS - 10);
    expect(overlay()).toBeNull();
    await months.release("2026-11+2");
    expect(loaded()).toBeInTheDocument();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });

  it("a gated load in the same session wins", async () => {
    const { months, loaded } = await startLoaded(1);
    choose(uuid(1));
    await untilCovered();
    const endOther = registerPageLoad("Loading something else…");
    await wait(100);
    endOther();
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).not.toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(filter()).toHaveFocus();
  });

  it("one that fails shows its error at once; its retry leaves when loaded", async () => {
    const fail = ["2026-11+1"];
    const { months, loaded } = await startLoaded(1, fail);
    choose(uuid(1));
    await untilCovered();
    await months.release("2026-11+1");
    expect(screen.getByTestId("error")).toBeInTheDocument();
    expect(overlay()).toBeNull();
    fail.length = 0;
    months.holdAgain("2026-11+1");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    await months.release("2026-11+1");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it("retrying a first load that failed is still a first load: a whole cycle", async () => {
    const fail = ["2026-11"];
    const { months, loaded } = start(1, fail);
    await wait(50);
    await months.release("2026-11");
    expect(screen.getByTestId("error")).toBeInTheDocument();
    await wait(1000);
    fail.length = 0;
    months.holdAgain("2026-11");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(LACE_GRACE_MS + 500);
    expect(overlay()).not.toBeNull();
    await months.release("2026-11");
    expect(loaded()).toBeInTheDocument();
    expect(overlay()).not.toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });
});

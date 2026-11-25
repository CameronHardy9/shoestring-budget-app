// The opening through the real App with a mocked API: a cold start and signing
// in show no navigation until the first page is revealed with it. The session
// rules themselves: components/opening.test.tsx.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, use, useState } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "./App.tsx";
import { queryClient } from "./app/query.ts";
import { LACE_CYCLE_MS, LACE_GRACE_MS } from "./components/lace-timing.ts";
import { BudgetLayout } from "./screens/budget/BudgetLayout.tsx";
import { apiError, json, mockApi } from "./test/api-mock.ts";
import {
  authenticated,
  budget,
  BUDGET_ID,
  categories,
  plan,
  summary,
} from "./test/fixtures.ts";
import { deferred } from "./test/layout.ts";
import { recordNavigation } from "./test/nav-recorder.ts";
import { preloadScreens } from "./test/preload-screens.ts";
import { renderWithApp } from "./test/render.tsx";

beforeAll(preloadScreens);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
  localStorage.clear();
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Answers after `ms` on the fake clock. */
function slow<T>(ms: number, reply: T) {
  return () =>
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(reply);
      }, ms);
    });
}

const B = `/budgets/${BUDGET_ID}`;
const routes = {
  "GET /auth/session": slow(300, json(200, authenticated)),
  "GET /budgets": slow(200, json(200, { items: [budget] })),
  [`GET ${B}`]: slow(300, json(200, budget)),
  [`GET ${B}/categories`]: slow(300, json(200, { items: categories })),
  [`GET ${B}/months/:month/summary`]: slow(500, json(200, summary)),
  [`GET ${B}/months/:month/plan`]: slow(500, json(200, plan())),
  [`GET ${B}/transactions`]: slow(
    300,
    json(200, { items: [], nextCursor: null }),
  ),
};

function start(path: string) {
  window.history.replaceState(null, "", path);
  const nav = recordNavigation();
  render(<App />);
  return nav;
}

const overlay = () => screen.queryByTestId("loading");
const navigation = () => screen.queryAllByRole("navigation", { name: "Main" });

describe("cold start", () => {
  it.each([
    ["a budget", B],
    ["/", "/"],
  ])(
    "to %s: the lace alone, then the page with its navigation, once",
    async (_, path) => {
      mockApi(routes);
      const nav = start(path);
      await wait(LACE_GRACE_MS);
      expect(overlay()).not.toBeNull();
      await wait(1800);
      // All there, under the cover.
      expect(screen.getByTestId("total-remaining")).toBeInTheDocument();
      expect(navigation()).toEqual([]);
      await wait(LACE_CYCLE_MS - 1800 - 10);
      expect(overlay()).not.toBeNull();
      expect(navigation()).toEqual([]);
      await wait(20);
      expect(overlay()).toBeNull();
      expect(navigation()).toHaveLength(2);
      await wait(LACE_CYCLE_MS);
      nav.stop();
      expect(nav.changes).toEqual([{ nav: true, covered: false }]);
    },
  );

  it("a budget that fails: the error at once, with navigation", async () => {
    mockApi({
      ...routes,
      [`GET ${B}`]: slow(300, apiError(409, "VERSION_CONFLICT")),
    });
    const nav = start(B);
    await wait(500);
    expect(navigation()).toEqual([]);
    await wait(200);
    expect(screen.getByTestId("error")).toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(navigation()).toHaveLength(2);
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });

  it("a failed session check, then Try again: still the opening", async () => {
    let fail = true;
    mockApi({
      ...routes,
      "GET /auth/session": () =>
        fail ? apiError(429, "RATE_LIMITED") : json(200, authenticated),
    });
    const nav = start(B);
    await wait(10);
    expect(screen.getByTestId("error")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(LACE_GRACE_MS + 100);
    expect(overlay()).not.toBeNull();
    expect(navigation()).toEqual([]);
    await wait(LACE_CYCLE_MS);
    expect(navigation()).toHaveLength(2);
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });
});

describe("signing in", () => {
  it("no navigation from the form to the first page; later loads keep it", async () => {
    mockApi({
      ...routes,
      "GET /auth/session": apiError(401, "UNAUTHENTICATED"),
      "POST /auth/login": slow(200, json(200, authenticated)),
    });
    const nav = start("/signin");
    await wait(LACE_CYCLE_MS * 2);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "a@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a long password!" },
    });
    fireEvent.click(screen.getByTestId("sign-in-submit"));
    await wait(300);
    // Signed in: the plain cover is there in the grace, then the lace.
    expect(screen.getByTestId("opening-cover")).toBeInTheDocument();
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    await wait(1500);
    expect(screen.getByTestId("total-remaining")).toBeInTheDocument();
    expect(navigation()).toEqual([]);
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(navigation()).toHaveLength(2);
    // A tab's first load: the navigation stays.
    fireEvent.click(screen.getAllByRole("link", { name: "Budgets" })[0]!);
    await wait(LACE_GRACE_MS + 50);
    expect(overlay()).not.toBeNull();
    expect(navigation()).toHaveLength(2);
    await wait(LACE_CYCLE_MS * 2);
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });
});

describe("a lazy screen inside the budget's shell", () => {
  it("doesn't hide the shell: the navigation stays while it loads", async () => {
    mockApi(routes);
    const chunk = deferred<undefined>();
    function LazyPage() {
      use(chunk.promise);
      return <h1>Lazy page</h1>;
    }
    let go: () => void = () => undefined;
    function Screen() {
      const [lazy, setLazy] = useState(false);
      go = () => {
        setLazy(true);
      };
      return (
        <Suspense fallback={<p>the app&apos;s boundary</p>}>
          <BudgetLayout budgetId={BUDGET_ID} active="overview">
            {lazy ? <LazyPage /> : <h1>First page</h1>}
          </BudgetLayout>
        </Suspense>
      );
    }
    renderWithApp(<Screen />, { path: B });
    await wait(LACE_CYCLE_MS * 2);
    const nav = recordNavigation();
    act(() => {
      go();
    });
    await wait(LACE_GRACE_MS + 50);
    expect(screen.queryByText("the app's boundary")).toBeNull();
    expect(overlay()).not.toBeNull();
    expect(navigation()).toHaveLength(2);
    await act(async () => {
      chunk.resolve(undefined);
      await chunk.promise;
    });
    await wait(LACE_CYCLE_MS * 2);
    expect(screen.getByRole("heading", { name: "Lazy page" })).toBeVisible();
    nav.stop();
    expect(nav.changes).toEqual([]);
  });
});

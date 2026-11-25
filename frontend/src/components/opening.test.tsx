// The opening (owner ruling 2026-11-25): from signing in to the first page
// revealed there is no navigation, not even for a frame, and it arrives in the
// same commit as the page. Unit level: the session (page-loader.ts) with the
// real AppShell. The whole app's cold start and sign-in: src/opening.test.tsx.
import { act, render, screen } from "@testing-library/react";
import { Suspense, use } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordNavigation } from "../test/nav-recorder.ts";
import { stubReducedMotion } from "../test/reduced-motion.ts";
import { AppShell } from "./AppShell.tsx";
import { LACE_CHAIN_MS, LACE_CYCLE_MS, LACE_GRACE_MS } from "./lace-timing.ts";
import { beginOpening, whenPageUncovered } from "./page-loader.ts";
import { PageLoader } from "./PageLoader.tsx";
import { PageMain } from "./PageMain.tsx";
import { ErrorState, LoadingState, OfflineState } from "./States.tsx";

type View =
  /** On the way to a page: boot, the lazy-route fallback, "/". */
  | "way"
  /** Also on the way, but with a message instead of a loader. */
  | "way-error"
  /** A redirect: nothing at all for a commit or two. */
  | "nothing"
  | "shell-loading"
  | "shell-two-loading"
  | "shell-offline"
  | "shell-error-and-loading"
  | "page";

const BUDGET = "b1";

function Shown({ view }: { view: View }) {
  switch (view) {
    case "way":
      return (
        <PageMain interstitial key="way">
          <LoadingState label="Starting Shoestring…" />
        </PageMain>
      );
    case "way-error":
      return (
        <PageMain interstitial key="way">
          <ErrorState error={new Error("boom")} />
        </PageMain>
      );
    case "nothing":
      return null;
    default:
      return (
        <AppShell active="overview" budgetId={BUDGET} onAdd={() => undefined}>
          <h1>November</h1>
          {view === "page" ? <button type="button">Content</button> : null}
          {view === "shell-loading" || view === "shell-two-loading" ? (
            <LoadingState label="Loading your budget…" />
          ) : null}
          {view === "shell-two-loading" ||
          view === "shell-error-and-loading" ? (
            <LoadingState label="Loading the rest…" />
          ) : null}
          {view === "shell-offline" ? (
            <OfflineState message="You're offline." />
          ) : null}
          {view === "shell-error-and-loading" ? (
            <ErrorState error={new Error("boom")} />
          ) : null}
        </AppShell>
      );
  }
}

function app(view: View) {
  return (
    <>
      <Shown view={view} />
      <PageLoader />
    </>
  );
}

function setup(first: View) {
  const view = render(app(first));
  return {
    show: async (next: View) => {
      await act(async () => {
        view.rerender(app(next));
        // The end of the commit's task: microtasks run before any paint.
        await Promise.resolve();
      });
    },
  };
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const overlay = () => screen.queryByTestId("loading");
const plainCover = () => screen.queryByTestId("opening-cover");
const content = () => screen.queryByRole("button", { name: "Content" });

function expectNoNavigation() {
  expect(screen.queryAllByRole("navigation")).toEqual([]);
  expect(screen.queryByTestId("quick-add-open")).toBeNull();
  expect(screen.queryByTestId("quick-add-open-rail")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
}

function expectNavigation() {
  expect(screen.queryAllByRole("navigation")).toHaveLength(2);
  expect(screen.getByTestId("quick-add-open")).toBeInTheDocument();
  expect(screen.getByTestId("quick-add-open-rail")).toBeInTheDocument();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opening: no navigation", () => {
  it("through the grace, the lace and chained loads; then with the page, in one commit", async () => {
    const { show } = setup("way");
    beginOpening();
    const nav = recordNavigation();
    // The grace: the shell is there already, under a plain cover, inert.
    await show("shell-loading");
    expectNoNavigation();
    expect(plainCover()).toHaveClass("fixed", "inset-0", "bg-canvas");
    expect(overlay()).toBeNull();
    expect(screen.getByRole("main")).toHaveAttribute("inert");
    // The rail's width is kept, so nothing is laid out twice.
    expect(
      screen.getByRole("main").previousElementSibling?.className,
    ).toContain("lg:w-60");
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    expect(plainCover()).toBeNull();
    expectNoNavigation();
    // Chained loads, a redirect's gap included.
    await show("nothing");
    await wait(200);
    await show("shell-loading");
    await wait(1000);
    // Loaded, but the cycle isn't over.
    await show("page");
    expectNoNavigation();
    await wait(LACE_CYCLE_MS - 1200 - 1);
    expectNoNavigation();
    expect(overlay()).not.toBeNull();
    await wait(1);
    expect(overlay()).toBeNull();
    expectNavigation();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
    await wait(LACE_CHAIN_MS + LACE_CYCLE_MS);
    nav.stop();
    // It came once, never with a cover up, and never went.
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });

  it("keeps running whole cycles while something loads, without navigation", async () => {
    const { show } = setup("shell-loading");
    beginOpening();
    await wait(LACE_GRACE_MS + LACE_CYCLE_MS + 200);
    expectNoNavigation();
    await show("page");
    await wait(LACE_CYCLE_MS - 200 - 1);
    expectNoNavigation();
    await wait(1);
    expectNavigation();
  });

  it("with everything loaded within the grace: the page and its navigation together, at once, no lace", async () => {
    const { show } = setup("way");
    beginOpening();
    const nav = recordNavigation();
    await show("shell-loading");
    await wait(LACE_GRACE_MS - 50);
    expectNoNavigation();
    await show("page");
    expectNavigation();
    expect(content()).toBeInTheDocument();
    expect(plainCover()).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
    await wait(LACE_CYCLE_MS);
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
    expect(overlay()).toBeNull();
  });

  it("when no load was needed at all: with the page", async () => {
    beginOpening();
    const { show } = setup("nothing");
    await show("page");
    expectNavigation();
    expect(plainCover()).toBeNull();
  });

  it("a boundary inside a redirect's gap doesn't lift the cover: the next load joins the same animation", async () => {
    const { show } = setup("way");
    beginOpening();
    await wait(LACE_GRACE_MS + LACE_CYCLE_MS - 20);
    const cover = overlay();
    const lace = screen.getByTestId("lace-loader");
    await show("nothing");
    const nav = recordNavigation();
    await wait(60);
    expect(overlay()).toBe(cover);
    await show("shell-loading");
    await wait(500);
    await show("page");
    expectNoNavigation();
    // Still the first animation's boundaries.
    await wait(LACE_CYCLE_MS - 40 - 500 - 1);
    expect(overlay()).toBe(cover);
    expect(screen.getByTestId("lace-loader")).toBe(lace);
    expectNoNavigation();
    await wait(1);
    expect(overlay()).toBeNull();
    expectNavigation();
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });

  it("a page that needs no load after such a gap is revealed at once", async () => {
    const { show } = setup("way");
    beginOpening();
    await wait(LACE_GRACE_MS + LACE_CYCLE_MS - 20);
    await show("nothing");
    await wait(60);
    expect(overlay()).not.toBeNull();
    await show("page");
    expect(overlay()).toBeNull();
    expectNavigation();
  });

  it("a gap with nothing after it doesn't cover the page for ever, and the opening goes on", async () => {
    const { show } = setup("way");
    beginOpening();
    await wait(LACE_GRACE_MS + LACE_CYCLE_MS - 20);
    await show("nothing");
    await wait(20 + LACE_CHAIN_MS - 1);
    expect(overlay()).not.toBeNull();
    await wait(1);
    expect(overlay()).toBeNull();
    await wait(LACE_CHAIN_MS);
    await show("shell-loading");
    expectNoNavigation();
    await wait(LACE_GRACE_MS);
    await show("page");
    await wait(LACE_CYCLE_MS);
    expectNavigation();
  });

  it("a shell that a lazy screen hides and shows again never shows navigation", async () => {
    let arrive: () => void = () => undefined;
    const chunk = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    function LazyPage() {
      use(chunk);
      return <button type="button">Content</button>;
    }
    const tree = (loaded: boolean) => (
      <>
        <Suspense
          fallback={
            <PageMain interstitial>
              <LoadingState />
            </PageMain>
          }
        >
          <AppShell active="overview" budgetId={BUDGET} onAdd={() => undefined}>
            {loaded ? <LazyPage /> : <LoadingState label="Loading budget…" />}
          </AppShell>
        </Suspense>
        <PageLoader />
      </>
    );
    const view = render(tree(false));
    act(() => {
      beginOpening();
    });
    const nav = recordNavigation();
    await wait(LACE_GRACE_MS + 100);
    // The shell is on the page and gets hidden (React: display none).
    await act(async () => {
      view.rerender(tree(true));
      await Promise.resolve();
    });
    // Hidden, with its own slot, behind the fallback's.
    expect(screen.getAllByTestId("loading-slot")).toHaveLength(2);
    await wait(500);
    expectNoNavigation();
    await act(async () => {
      arrive();
      await chunk;
    });
    await wait(400);
    expect(
      screen.getByRole("button", { name: "Content", hidden: true }),
    ).toBeInTheDocument();
    expectNoNavigation();
    await wait(LACE_CYCLE_MS - 1000 - 1);
    expectNoNavigation();
    await wait(1);
    expectNavigation();
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });

  it("announces once", async () => {
    const { show } = setup("way");
    beginOpening();
    await show("shell-loading");
    await wait(LACE_GRACE_MS);
    const status = screen.getByTestId("loading-status");
    const text = status.textContent;
    expect(text).not.toBe("");
    await show("nothing");
    await show("shell-two-loading");
    expect(screen.getByTestId("loading-status")).toBe(status);
    expect(status).toHaveTextContent(text);
  });

  it("runs what waited for the page, and gives focus back, with the reveal", async () => {
    function Editor({ loading }: { loading: boolean }) {
      return (
        <>
          <PageMain>
            <button type="button">Content</button>
            {loading ? <LoadingState /> : null}
          </PageMain>
          <PageLoader />
        </>
      );
    }
    const view = render(<Editor loading />);
    const button = screen.getByRole("button", { name: "Content" });
    button.focus();
    // The plain cover makes the page inert already, before the lace.
    act(() => {
      beginOpening();
    });
    expect(button.closest("[inert]")).not.toBeNull();
    // What a browser does to focus inside an inert page.
    button.blur();
    const waited = vi.fn();
    whenPageUncovered(waited);
    await wait(LACE_GRACE_MS + 10);
    view.rerender(<Editor loading={false} />);
    await wait(LACE_CYCLE_MS - 10 - 1);
    expect(waited).not.toHaveBeenCalled();
    expect(button).not.toHaveFocus();
    await wait(1);
    expect(waited).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
  });

  it("reduced motion: ends as soon as loading ends, with the page", async () => {
    stubReducedMotion(true);
    const { show } = setup("way");
    beginOpening();
    const nav = recordNavigation();
    await show("shell-loading");
    await wait(LACE_GRACE_MS + 300);
    expect(overlay()).not.toBeNull();
    expectNoNavigation();
    // A redirect's gap doesn't lift it.
    await show("nothing");
    await wait(LACE_CHAIN_MS - 10);
    expect(overlay()).not.toBeNull();
    await show("shell-loading");
    await wait(500);
    expect(overlay()).not.toBeNull();
    await show("page");
    expect(overlay()).toBeNull();
    expectNavigation();
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });
});

describe("opening: nobody is stranded", () => {
  it.each(["with the lace up", "in the grace"])(
    "an offline message (%s) shows at once, with navigation",
    async (when) => {
      const { show } = setup("shell-loading");
      beginOpening();
      await wait(when === "in the grace" ? 50 : LACE_GRACE_MS + 700);
      expectNoNavigation();
      await show("shell-offline");
      expect(screen.getByTestId("offline")).toBeVisible();
      expect(overlay()).toBeNull();
      expect(plainCover()).toBeNull();
      expect(screen.getByRole("main")).not.toHaveAttribute("inert");
      expectNavigation();
    },
  );

  it("an error shows at once, with navigation, even while something else still loads", async () => {
    const { show } = setup("shell-two-loading");
    beginOpening();
    await wait(LACE_GRACE_MS + 700);
    await show("shell-error-and-loading");
    expect(screen.getByTestId("error")).toBeVisible();
    expect(overlay()).toBeNull();
    expectNavigation();
  });

  it("a page whose first commit is already an error has navigation", async () => {
    const { show } = setup("way");
    beginOpening();
    await wait(LACE_GRACE_MS + 700);
    await show("shell-error-and-loading");
    expect(screen.getByTestId("error")).toBeVisible();
    expectNavigation();
  });

  it("a message on the way to a page (no navigation there) doesn't end the opening: after a retry the page still comes at once", async () => {
    const { show } = setup("way");
    beginOpening();
    await wait(LACE_GRACE_MS + 700);
    await show("way-error");
    expect(screen.getByTestId("error")).toBeVisible();
    expect(overlay()).toBeNull();
    expect(plainCover()).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
    await wait(5000);
    const nav = recordNavigation();
    await show("way");
    await show("shell-loading");
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    expectNoNavigation();
    await show("page");
    await wait(LACE_CYCLE_MS);
    expectNavigation();
    nav.stop();
    expect(nav.changes).toEqual([{ nav: true, covered: false }]);
  });
});

describe("after the opening", () => {
  it("later page loads keep the navigation, above the cover", async () => {
    const { show } = setup("shell-loading");
    beginOpening();
    await wait(LACE_GRACE_MS);
    await show("page");
    await wait(LACE_CYCLE_MS + LACE_CHAIN_MS);
    const nav = recordNavigation();
    await show("shell-loading");
    expectNavigation();
    // Nothing covers the grace any more.
    expect(plainCover()).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
    await wait(LACE_GRACE_MS);
    expect(overlay()).toHaveClass("z-20");
    expectNavigation();
    await show("page");
    await wait(LACE_CYCLE_MS);
    nav.stop();
    expect(nav.changes).toEqual([]);
  });

  it("a load in the chain window after the opening's reveal keeps the navigation", async () => {
    const { show } = setup("shell-loading");
    beginOpening();
    await wait(LACE_GRACE_MS);
    await show("page");
    await wait(LACE_CYCLE_MS + 50);
    expectNavigation();
    const nav = recordNavigation();
    await show("shell-loading");
    expect(overlay()).not.toBeNull();
    expectNavigation();
    nav.stop();
    expect(nav.changes).toEqual([]);
  });
});

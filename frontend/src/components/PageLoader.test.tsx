// The page loader session (owner rulings 2026-11-24): grace, whole cycles,
// one animation across chained loads, reduced motion, offline / error
// interrupts, and inline loaders left alone. Fake timers fake
// performance.now() too, so the session's clock and the test's agree.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LACE_CHAIN_MS,
  LACE_CYCLE_MS,
  LACE_GRACE_MS,
  LACE_SEAM_MS,
} from "./lace-timing.ts";
import { usePageCovered, whenPageUncovered } from "./page-loader.ts";
import { PageLoader } from "./PageLoader.tsx";
import { ErrorState, LoadingState, OfflineState } from "./States.tsx";

type Slot =
  | { kind: "loading"; label?: string }
  | { kind: "inline" }
  | { kind: "offline" }
  | { kind: "error" }
  | { kind: "content" };

function Page({ slots }: { slots: Slot[] }) {
  const covered = usePageCovered();
  return (
    <main inert={covered} data-testid="page">
      <h1>Overview</h1>
      {slots.map((slot, i) => {
        switch (slot.kind) {
          case "loading":
            return <LoadingState key={i} label={slot.label ?? "Loading…"} />;
          case "inline":
            return (
              <LoadingState
                key={i}
                placement="inline"
                label="Loading recent…"
              />
            );
          case "offline":
            return <OfflineState key={i} message="You're offline." />;
          case "error":
            return <ErrorState key={i} error={new Error("boom")} />;
          case "content":
            return (
              <button key={i} type="button">
                Content
              </button>
            );
        }
      })}
    </main>
  );
}

function app(slots: Slot[]) {
  return (
    <>
      <Page slots={slots} />
      <PageLoader />
    </>
  );
}

function setup(slots: Slot[]) {
  const view = render(app(slots));
  return {
    show: (next: Slot[]) => {
      view.rerender(app(next));
    },
  };
}

/** Moves the fake clock, letting React and microtasks settle. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const overlay = () => screen.queryByTestId("loading");
const status = () => screen.queryByTestId("loading-status");
const page = () => screen.getByTestId("page");
const delay = () =>
  screen.getByTestId("lace-loader").style.getPropertyValue("--ss-lace-delay");

function prefersReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  prefersReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PageLoader: grace", () => {
  it("shows nothing if everything loads within the grace period, and adds no delay", async () => {
    const { show } = setup([{ kind: "loading" }]);
    // The status region is there from the start, empty, so the label is a
    // change when it comes.
    expect(status()).toHaveAttribute("role", "status");
    expect(status()).toBeEmptyDOMElement();
    await wait(LACE_GRACE_MS - 50);
    expect(overlay()).toBeNull();
    show([{ kind: "content" }]);
    expect(screen.getByRole("button", { name: "Content" })).toBeVisible();
    expect(page()).not.toHaveAttribute("inert");
    await wait(50);
    expect(overlay()).toBeNull();
    expect(status()).toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
  });

  it("after the grace period shows the lace over an opaque cover, under the nav, and makes the page inert", async () => {
    setup([{ kind: "loading", label: "Starting Shoestring…" }]);
    await wait(LACE_GRACE_MS - 1);
    expect(overlay()).toBeNull();
    expect(page()).not.toHaveAttribute("inert");
    await wait(1);
    const cover = overlay()!;
    expect(cover).toHaveAttribute("data-placement", "viewport");
    for (const name of ["fixed", "inset-0", "z-20", "bg-canvas"])
      expect(cover).toHaveClass(name);
    expect(cover).not.toHaveClass("pointer-events-none");
    expect(screen.getByTestId("lace-loader")).toHaveAttribute("width", "96");
    // Cycle 0 starts as it appears.
    expect(delay()).toBe("0ms");
    expect(status()).toHaveTextContent("Starting Shoestring…");
    expect(status()).not.toContainElement(cover);
    expect(page()).toHaveAttribute("inert");
  });
});

describe("PageLoader: whole cycles", () => {
  it("keeps covering loaded content until the cycle boundary, then reveals it", async () => {
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS);
    const cover = overlay();
    await wait(1000);
    show([{ kind: "content" }]);
    await wait(0);
    // Loaded, but hidden and inert until the lace finishes its cycle.
    expect(overlay()).toBe(cover);
    expect(page()).toHaveAttribute("inert");
    await wait(LACE_CYCLE_MS - 1000 - 1);
    expect(overlay()).toBe(cover);
    await wait(1);
    expect(overlay()).toBeNull();
    expect(page()).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Content" })).toBeVisible();
    await wait(LACE_CHAIN_MS);
    expect(status()).toBeNull();
  });

  it("runs another whole cycle when a load is still going at the boundary", async () => {
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS + LACE_CYCLE_MS + 200);
    show([{ kind: "content" }]);
    await wait(LACE_CYCLE_MS - 200 - 1);
    expect(overlay()).not.toBeNull();
    await wait(1);
    expect(overlay()).toBeNull();
  });

  it("is one animation and one announcement across chained loads: no restart, no cut-off", async () => {
    const { show } = setup([
      { kind: "loading", label: "Starting Shoestring…" },
    ]);
    await wait(LACE_GRACE_MS);
    const cover = overlay();
    const lace = screen.getByTestId("lace-loader");
    const region = status();
    // Boot done; the budgets list replaces it in the same commit.
    await wait(400);
    show([{ kind: "loading", label: "Loading your budgets…" }]);
    // A redirect: nothing on the page for a while, then the next load.
    await wait(400);
    show([]);
    await wait(300);
    show([{ kind: "loading", label: "Loading your budget…" }]);
    // Still loading at the first boundary: the session runs on.
    await wait(LACE_CYCLE_MS);
    show([{ kind: "content" }]);
    for (const el of [cover, lace, region]) expect(el).toBeInTheDocument();
    expect(overlay()).toBe(cover);
    expect(screen.getByTestId("lace-loader")).toBe(lace);
    expect(delay()).toBe("0ms");
    expect(status()).toBe(region);
    expect(region).toHaveTextContent("Starting Shoestring…");
    // Revealed at the second boundary (2 cycles after it appeared).
    await wait(2 * LACE_CYCLE_MS - (400 + 400 + 300 + LACE_CYCLE_MS) - 1);
    expect(overlay()).toBe(cover);
    await wait(1);
    expect(overlay()).toBeNull();
  });

  it("a load that starts just after a reveal joins the session: shown at once, in phase, not announced again", async () => {
    const { show } = setup([
      { kind: "loading", label: "Loading your budgets…" },
    ]);
    await wait(LACE_GRACE_MS + 500);
    show([]);
    await wait(LACE_CYCLE_MS - 500);
    expect(overlay()).toBeNull();
    const region = status();
    expect(region).toHaveTextContent("Loading your budgets…");
    await wait(LACE_CHAIN_MS - 10);
    show([{ kind: "loading", label: "Loading your budget…" }]);
    expect(overlay()).not.toBeNull();
    expect(delay()).toBe(`-${String(LACE_CHAIN_MS - 10)}ms`);
    expect(status()).toBe(region);
    expect(region).toHaveTextContent("Loading your budgets…");
    show([{ kind: "content" }]);
    await wait(LACE_CYCLE_MS - (LACE_CHAIN_MS - 10) - 1);
    expect(overlay()).not.toBeNull();
    await wait(1);
    expect(overlay()).toBeNull();
  });

  it("a load after the chain window is a new session, with its own grace", async () => {
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS);
    show([]);
    await wait(LACE_CYCLE_MS + LACE_CHAIN_MS);
    expect(status()).toBeNull();
    show([{ kind: "loading" }]);
    expect(overlay()).toBeNull();
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    expect(delay()).toBe("0ms");
  });

  /** A boundary timer that fires `late` ms late (a busy main thread). */
  async function lateBoundary(late: number) {
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS);
    show([{ kind: "content" }]);
    await wait(LACE_CYCLE_MS - 1);
    const fakeNow = performance.now.bind(performance);
    let skew = late;
    const now = vi
      .spyOn(performance, "now")
      .mockImplementation(() => fakeNow() + skew);
    await wait(1);
    skew = 0;
    return now;
  }

  it("a late timer doesn't reveal mid-cycle: it waits for the next boundary", async () => {
    const now = await lateBoundary(500);
    expect(overlay()).not.toBeNull();
    await wait(LACE_CYCLE_MS - 1);
    expect(overlay()).not.toBeNull();
    await wait(1);
    expect(overlay()).toBeNull();
    now.mockRestore();
  });

  it("a late timer within the seam still reveals", async () => {
    const now = await lateBoundary(LACE_SEAM_MS);
    expect(overlay()).toBeNull();
    now.mockRestore();
  });

  it("in a hidden tab a late timer reveals at once: nobody sees the seam", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const now = await lateBoundary(500);
    expect(overlay()).toBeNull();
    now.mockRestore();
    visibility.mockRestore();
  });
});

describe("PageLoader: focus", () => {
  it("gives focus back when the cover took it, and runs what waited for the page", async () => {
    const { show } = setup([{ kind: "content" }, { kind: "loading" }]);
    const button = screen.getByRole("button", { name: "Content" });
    button.focus();
    await wait(LACE_GRACE_MS);
    expect(page()).toHaveAttribute("inert");
    // What a browser does to focus inside an inert page.
    button.blur();
    const waited = vi.fn();
    whenPageUncovered(waited);
    expect(waited).not.toHaveBeenCalled();
    show([{ kind: "content" }]);
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(button).toHaveFocus();
    expect(waited).toHaveBeenCalledOnce();
    const now = vi.fn();
    whenPageUncovered(now);
    expect(now).toHaveBeenCalledOnce();
  });

  it("focuses the page's heading when the focused element was replaced", async () => {
    const { show } = setup([{ kind: "content" }, { kind: "loading" }]);
    screen.getByRole("button", { name: "Content" }).focus();
    await wait(LACE_GRACE_MS);
    // The loaded page has no such button any more.
    show([]);
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toHaveFocus();
  });
});

describe("PageLoader: reduced motion", () => {
  it("still has the grace period, but no minimum: content shows as soon as it has loaded", async () => {
    prefersReducedMotion(true);
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS - 1);
    expect(overlay()).toBeNull();
    await wait(1);
    expect(overlay()).not.toBeNull();
    await wait(300);
    show([{ kind: "content" }]);
    await wait(0);
    expect(overlay()).toBeNull();
    expect(page()).not.toHaveAttribute("inert");
  });

  it("doesn't flicker when one load replaces another in the same commit", async () => {
    prefersReducedMotion(true);
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS);
    const cover = overlay();
    show([{ kind: "loading", label: "Next" }]);
    await wait(0);
    expect(overlay()).toBe(cover);
  });
});

describe("PageLoader: offline and error interrupt", () => {
  it.each([
    ["an offline message", { kind: "offline" } as const, "offline"],
    ["an error", { kind: "error" } as const, "error"],
  ])(
    "%s replacing the loader shows at once, mid-cycle, and ends the session",
    async (_, slot, testId) => {
      const { show } = setup([{ kind: "loading" }]);
      await wait(LACE_GRACE_MS + 1000);
      show([slot]);
      expect(overlay()).toBeNull();
      expect(status()).toBeNull();
      expect(page()).not.toHaveAttribute("inert");
      expect(screen.getByTestId(testId)).toBeVisible();
      await wait(LACE_CYCLE_MS);
      expect(overlay()).toBeNull();
    },
  );

  it("in the grace period, no loader ever appears", async () => {
    const { show } = setup([{ kind: "loading" }]);
    await wait(50);
    show([{ kind: "offline" }]);
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    expect(status()).toBeNull();
  });

  it("with another load still going, no new cover hides the message; the next session starts fresh", async () => {
    const { show } = setup([{ kind: "loading" }, { kind: "loading" }]);
    await wait(LACE_GRACE_MS);
    show([{ kind: "error" }, { kind: "loading" }]);
    expect(overlay()).toBeNull();
    await wait(LACE_CYCLE_MS);
    expect(overlay()).toBeNull();
    show([{ kind: "error" }, { kind: "content" }]);
    await wait(LACE_CHAIN_MS);
    show([{ kind: "content" }, { kind: "loading" }]);
    expect(overlay()).toBeNull();
    await wait(LACE_GRACE_MS);
    expect(overlay()).not.toBeNull();
    expect(delay()).toBe("0ms");
  });
});

describe("PageLoader: inline loaders", () => {
  it("are untouched: shown at once in place, gone as soon as the data is, no cover", async () => {
    const { show } = setup([{ kind: "content" }, { kind: "inline" }]);
    const inline = screen.getByTestId("loading");
    expect(inline).toHaveAttribute("data-placement", "inline");
    expect(inline).toHaveTextContent("Loading recent…");
    expect(status()).toBeNull();
    await wait(LACE_GRACE_MS + 1000);
    expect(screen.getAllByTestId("loading")).toEqual([inline]);
    expect(page()).not.toHaveAttribute("inert");
    show([{ kind: "content" }, { kind: "content" }]);
    expect(screen.queryByTestId("loading")).toBeNull();
  });

  it("join the page loader's phase while it is on screen", async () => {
    const { show } = setup([{ kind: "loading" }]);
    await wait(LACE_GRACE_MS + 700);
    show([{ kind: "loading" }, { kind: "inline" }]);
    const inline = screen
      .getAllByTestId("loading")
      .find((el) => el.dataset.placement === "inline")!;
    const lace = inline.querySelector("svg")!;
    expect(lace.style.getPropertyValue("--ss-lace-delay")).toBe("-700ms");
  });
});

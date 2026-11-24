// The page loader in full motion (owner rulings 2026-11-24, mvp-planning/10
// "UI fixes: loader full cycles"): a cold start's chain of page loads is ONE
// lace session over an opaque cover; the page under it is inert; the cover
// lifts only at a cycle boundary, running whole extra cycles while anything
// still loads; the tab screens are preloaded after the first reveal, so a
// first tab visit doesn't suspend.
//
// Every other Playwright test runs with reduced motion (playwright.config.ts),
// where the page shows as soon as it has loaded, so this is the one test that
// sees the hold. The loader is observed from inside the page: an init script
// records, on the page's own performance.now() clock, every time the cover
// appears or goes, which cover and lace elements those were, whether every
// rendered <main> was inert while the cover was up, and which page loads
// mounted. The test runner's clock never enters the timing.
//
// Determinism: two loads of the chain are held with page.route.
//   - The Overview screen's module, until the cover is up. The budget's shell
//     (AppShell) is then already on screen when Overview suspends, so React
//     hides it (display: none) behind the lazy-route fallback under the cover,
//     and unhides it under the cover later: the case where a stale `inert`
//     would show (CI run 45469953508 met the first half by chance on WebKit).
//   - The month summary, until the lace has run 1.5 cycles, so the first
//     boundary certainly passes while a load is pending, and the load ends
//     half a cycle away from any boundary. A loader that revealed as soon as
//     loading ended would miss a boundary by ~1600 ms, far outside the
//     tolerance below.
//
// Failures here belong to frontend-engineer (frontend/src/components/
// page-loader.ts, PageLoader.tsx, frontend/src/app/preload.ts).
import type { Route } from "@playwright/test";
import { createBudget, createUser } from "../support/factories.ts";
import {
  expect,
  expectNoCspViolations,
  flushCspViolations,
  signInAs,
  test,
} from "./fixtures.ts";

/**
 * How far from k × LACE_CYCLE_MS (measured from the lace's first appearance)
 * the cover may lift. The product itself accepts a boundary timer up to
 * LACE_SEAM_MS (100 ms) late; on top of that both ends of the measurement are
 * seen one React commit after their timer (a dev build on an emulated phone
 * on a shared CI runner: budget ~100 ms each). 300 ms covers that, stays well
 * under half a cycle (1600 ms), and well under the ~1600 ms by which an
 * "as soon as loaded" reveal would miss a boundary in this setup.
 */
const BOUNDARY_TOLERANCE_MS = 300;

/** The summary is released this many cycles after the lace first appeared. */
const HOLD_CYCLES = 1.5;

interface LoaderLog {
  /** Every appearance and removal of the page loader's cover, in order. */
  changes: { shown: boolean; t: number }[];
  /** Distinct cover elements seen (one per session that never restarts). */
  covers: number;
  /** Distinct lace <svg> elements seen inside a cover. */
  laces: number;
  /**
   * A rendered <main> (checkVisibility) that was not inert while the cover
   * was up: "time: id or class". A <main> React has hidden behind a Suspense
   * fallback (display: none) isn't counted: it can't be seen, focused or
   * read, and React doesn't re-render it while hidden, so its `inert` is
   * stale until it is shown again (then it is counted).
   */
  mainNotInert: string[];
  /** Samples with the cover up and a <main> hidden by React (the held module). */
  hiddenMainSamples: number;
  /** Page-load slots (viewport LoadingStates) as they mounted. */
  slots: { label: string; t: number }[];
  /** fetchStart of the Transactions screen module (the idle preload). */
  transactionsModuleAt: number | null;
}

declare global {
  interface Window {
    __pageLoaderLog?: LoaderLog;
  }
}

test.describe("page loader in full motion", () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    "phone projects: the cold start the owner sees; the session logic has no desktop branch",
  );
  test.use({ reducedMotion: "no-preference" });

  test("a signed-in cold start to Overview is one lace session over an inert page, lifted only at a cycle boundary; a first tab visit then doesn't suspend", async ({
    page,
    cspViolations,
  }) => {
    const user = await createUser({ prefix: "loader" });
    const budget = await createBudget(user, { name: "Loader household" });
    await signInAs(page, user.email);

    await page.addInitScript(() => {
      const COVER = '[data-testid="loading"][data-placement="viewport"]';
      const LACE = '[data-testid="lace-loader"]';
      const SLOT = '[data-testid="loading-slot"]';
      const covers: Element[] = [];
      const laces: Element[] = [];
      const slots = new WeakSet<Element>();
      const log: LoaderLog = {
        changes: [],
        covers: 0,
        laces: 0,
        mainNotInert: [],
        hiddenMainSamples: 0,
        slots: [],
        transactionsModuleAt: null,
      };
      window.__pageLoaderLog = log;
      let shown = false;
      // After every batch of DOM changes (one React commit), the state of the
      // page as the user would see it.
      const sample = () => {
        const t = performance.now();
        const cover = document.querySelector(COVER);
        if (cover && !covers.includes(cover)) covers.push(cover);
        const lace = cover?.querySelector(LACE);
        if (lace && !laces.includes(lace)) laces.push(lace);
        log.covers = covers.length;
        log.laces = laces.length;
        if (Boolean(cover) !== shown) {
          shown = Boolean(cover);
          log.changes.push({ shown, t });
        }
        if (cover) {
          for (const main of document.querySelectorAll("main")) {
            if (!main.checkVisibility()) log.hiddenMainSamples += 1;
            else if (!main.hasAttribute("inert"))
              log.mainNotInert.push(
                `${String(Math.round(t))}: ${main.id || main.className}`,
              );
          }
        }
        for (const slot of document.querySelectorAll(SLOT)) {
          if (slots.has(slot)) continue;
          slots.add(slot);
          log.slots.push({ label: slot.getAttribute("data-label") ?? "", t });
        }
      };
      // `document`, not documentElement: that can still be null here.
      new MutationObserver(sample).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        // inert, and what React toggles to hide and unhide a suspended tree
        // (style display), so an unhidden <main> is sampled too.
        attributeFilter: ["inert", "style", "hidden"],
      });
      // An observer, not getEntries(): the dev server's hundreds of modules
      // overflow the resource timing buffer.
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            log.transactionsModuleAt === null &&
            entry.name.includes("/src/screens/budget/TransactionsScreen.tsx")
          )
            log.transactionsModuleAt = entry.startTime;
        }
      }).observe({ type: "resource", buffered: true });
    });

    // Hold this budget's month summary (the last load of the chain) until the
    // test releases it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(
      (url) =>
        url.pathname.startsWith(`/api/budgets/${budget.id}/months/`) &&
        url.pathname.endsWith("/summary"),
      async (route: Route) => {
        held += 1;
        await gate;
        await route.fallback();
      },
    );

    // Hold the Overview screen's module until the cover is up (the page's own
    // signal). Never longer than 20 s: then the checks below fail instead.
    await page.route(
      (url) => url.pathname === "/src/screens/budget/OverviewScreen.tsx",
      async (route: Route) => {
        await page
          .waitForFunction(
            () => (window.__pageLoaderLog?.changes.length ?? 0) > 0,
            undefined,
            { timeout: 20_000 },
          )
          .catch(() => undefined);
        await route.fallback().catch(() => undefined);
      },
    );

    let releasedAt: number;
    let cycleMs: number;
    try {
      await page.goto(`/budgets/${budget.id}`);
      // The app's own constants (same module instance on the dev server).
      const timing = await page.evaluate(async (moduleUrl) => {
        const m = (await import(/* @vite-ignore */ moduleUrl)) as {
          LACE_CYCLE_MS: number;
        };
        return { cycleMs: m.LACE_CYCLE_MS };
      }, "/src/components/lace-timing.ts");
      cycleMs = timing.cycleMs;
      expect(cycleMs, "the lace cycle the owner approved (3.2 s)").toBe(3200);

      await expect
        .poll(() => held, {
          message: "Overview asked for the month summary",
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      // Release HOLD_CYCLES into the session, on the page's clock.
      const released = await (
        await page.waitForFunction(
          (holdMs) => {
            const first = window.__pageLoaderLog?.changes[0];
            if (!first?.shown) return false;
            const now = performance.now();
            return now - first.t >= holdMs ? now : false;
          },
          HOLD_CYCLES * cycleMs,
          { timeout: 20_000 },
        )
      ).jsonValue();
      if (released === false) throw new Error("unreachable: waitForFunction");
      releasedAt = released;

      // 1. Under the cover the page is there but can't be seen or reached.
      const covered = await page.evaluate(() => {
        const main = document.querySelector("main");
        const heading = main?.querySelector("h1");
        const control = main?.querySelector<HTMLElement>("a[href], button");
        control?.focus();
        const box = heading?.getBoundingClientRect();
        const atHeading = box
          ? document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            )
          : null;
        return {
          mainInert: main?.hasAttribute("inert") ?? null,
          heading: heading?.textContent ?? null,
          headingUnderCover:
            atHeading?.closest('[data-testid="loading"]') != null,
          controlInMain: control != null,
          controlTookFocus: control ? document.activeElement === control : null,
        };
      });
      expect(
        covered,
        "while the lace is up, Overview's heading is rendered under the opaque cover and <main> is inert (no focus)",
      ).toEqual({
        mainInert: true,
        heading: "November",
        headingUnderCover: true,
        controlInMain: true,
        controlTookFocus: false,
      });
      expect(held, "the summary was still held during all this").toBe(1);
    } finally {
      release();
    }

    // 2. The cover lifts at a cycle boundary after the summary arrived.
    await page.waitForFunction(
      () => window.__pageLoaderLog?.changes.some((c) => !c.shown) === true,
      undefined,
      { timeout: 4 * cycleMs },
    );

    // 4. After the reveal: reachable, visible, no CSP violation.
    await expect(page.getByRole("main")).not.toHaveAttribute("inert");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "November",
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("total-remaining")).toBeVisible();
    await flushCspViolations(page);
    expectNoCspViolations(cspViolations);

    // The idle preload starts once the session has ended (after the chain
    // window), so the log read after it covers the whole cold start.
    await page.waitForFunction(
      () => window.__pageLoaderLog?.transactionsModuleAt != null,
      undefined,
      { timeout: 10_000 },
    );
    const log = await page.evaluate(() => window.__pageLoaderLog!);
    const trace = `page loader log: ${JSON.stringify(log)}`;

    // 3. One session: one cover, one lace, one appearance and one removal.
    expect(
      log.changes.map((c) => c.shown),
      `the cover appeared once and was removed once (no restart). ${trace}`,
    ).toEqual([true, false]);
    expect(log.covers, `one cover element. ${trace}`).toBe(1);
    expect(log.laces, `one lace element. ${trace}`).toBe(1);
    expect(
      log.mainNotInert,
      `every rendered <main> was inert whenever the cover was up. ${trace}`,
    ).toEqual([]);
    expect(
      log.hiddenMainSamples,
      `the budget's shell was hidden behind the lazy-route fallback under the cover (the held Overview module), so the check above saw it unhidden. ${trace}`,
    ).toBeGreaterThan(0);
    expect(
      log.slots.map((s) => s.label),
      `the cold start chained the boot, route and data loads, ending with the held month. ${trace}`,
    ).toEqual(
      expect.arrayContaining([
        "Starting Shoestring…",
        "Loading your budget…",
        "Loading…",
        "Loading this month…",
      ]),
    );

    const shownAt = log.changes[0]!.t;
    const removedAt = log.changes[1]!.t;
    const onScreen = removedAt - shownAt;
    const cycles = Math.round(onScreen / cycleMs);
    expect(
      removedAt,
      `the cover stayed up until the held summary was released. ${trace}`,
    ).toBeGreaterThan(releasedAt);
    expect(
      cycles,
      `whole cycles on screen (${String(onScreen)} ms): the boundary passed while the summary was held must not reveal. ${trace}`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      Math.abs(onScreen - cycles * cycleMs),
      `the cover lifted ${String(onScreen)} ms after the lace appeared: not within ${String(BOUNDARY_TOLERANCE_MS)} ms of a ${String(cycleMs)} ms boundary. ${trace}`,
    ).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_MS);
    expect(
      log.transactionsModuleAt,
      `the tab screens were preloaded only after the reveal. ${trace}`,
    ).toBeGreaterThan(removedAt);

    // Optional: a first tab visit doesn't suspend. Wait for the app's own
    // idle preload to finish (these are the promises it already started, so
    // this triggers nothing), then tap Transactions. Only the lazy-route
    // fallback ("Loading…") is asserted absent: whether the list's DATA takes
    // longer than the 150 ms grace depends on the runner, not the preload.
    await page.evaluate(async (moduleUrl) => {
      const routes = (await import(/* @vite-ignore */ moduleUrl)) as {
        TAB_SCREENS: readonly { preload: () => Promise<void> }[];
      };
      await Promise.all(routes.TAB_SCREENS.map((s) => s.preload()));
    }, "/src/app/routes.tsx");
    const slotsBefore = log.slots.length;
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Transactions" })
      .tap();
    await expect(
      page.getByRole("heading", { level: 1, name: "Transactions" }),
    ).toBeVisible();
    const after = await page.evaluate(() => window.__pageLoaderLog!);
    expect(
      after.slots.slice(slotsBefore).filter((s) => s.label === "Loading…"),
      `the preloaded Transactions screen rendered without suspending. page loader log: ${JSON.stringify(after)}`,
    ).toEqual([]);
  });
});

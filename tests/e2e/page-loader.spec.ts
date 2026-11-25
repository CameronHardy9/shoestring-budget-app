// The page loader and the opening (owner rulings 2026-11-24, mvp-planning/10
// "UI fixes: loader full cycles", and 2026-11-25, "iPhone check of the UI
// fixes"):
//   - a cold start's chain of page loads is ONE lace session over an opaque
//     cover; the page under it is inert; the cover lifts only at a cycle
//     boundary, running whole extra cycles while anything still loads; the tab
//     screens are preloaded after the first reveal, so a first tab visit
//     doesn't suspend;
//   - during the opening (cold start, and from sign-in to the first page) no
//     navigation is rendered at all; it appears once, in the commit that
//     reveals the page, and never disappears again;
//   - moving to another month leaves the loader as soon as the month is there,
//     mid-cycle, with focus still on the arrow.
//
// Every other Playwright test runs with reduced motion (playwright.config.ts),
// where the page shows as soon as it has loaded, so only the full-motion tests
// here see a hold. The page is observed from inside (recordLoader): an init
// script records, on the page's own performance.now() clock, after every batch
// of DOM changes, which cover is up, which navigation is visible or rendered,
// whether every rendered <main> is inert under the cover, and which page loads
// mounted. The test runner's clock never enters the timing.
//
// Determinism: loads are held with page.route and released on a signal from
// the page itself. In the cold start:
//   - The Overview screen's module, until the cover is up. The budget's shell
//     (AppShell) is then already on screen when Overview suspends; BudgetLayout's
//     own <Suspense> keeps the shell rendered (React used to hide it, and the
//     tab bar blinked out and back on the owner's iPhone).
//   - The month summary, until the lace has run 1.5 cycles, so the first
//     boundary certainly passes while a load is pending, and the load ends
//     half a cycle away from any boundary. A loader that revealed as soon as
//     loading ended would miss a boundary by ~1600 ms, far outside the
//     tolerance below.
//
// Failures here belong to frontend-engineer (frontend/src/components/
// page-loader.ts, PageLoader.tsx, AppShell.tsx, frontend/src/screens/budget/
// BudgetLayout.tsx and useSwitchExit.ts, frontend/src/app/preload.ts).
import type { Page, Route } from "@playwright/test";
import { createBudget, createUser } from "../support/factories.ts";
import {
  expect,
  expectNoCspViolations,
  flushCspViolations,
  quickAddOpener,
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

/** A new month's summary is released this long after the lace appeared. */
const MONTH_HOLD_MS = 1_000;

/**
 * A month switch must be gone this soon after the summary is released (the
 * rest of the request plus a commit; ~50 ms locally). The next boundary is
 * ~2200 ms after the release, so a held cycle can't pass.
 */
const MONTH_LEAVE_MS = 1_000;

/** What covers the page: the lace, the opening's plain cover, or nothing. */
type Cover = "lace" | "opening" | "none";

/** One sampled state; an entry is added only when something in it changed. */
interface LoaderState {
  t: number;
  cover: Cover;
  /** Visible navigation parts (checkVisibility), e.g. "nav quick-add-open". */
  nav: string;
  /** Navigation elements in the document, hidden ones and skip link included. */
  navInDom: number;
}

interface LoaderLog {
  /** Cover and navigation over time, in order. */
  states: LoaderState[];
  /** Every appearance and removal of the lace's cover, in order. */
  changes: { shown: boolean; t: number }[];
  /** Distinct cover elements seen (one per session that never restarts). */
  covers: number;
  /** Distinct lace <svg> elements seen inside a cover. */
  laces: number;
  /**
   * A rendered <main> (checkVisibility) that was not inert while a cover was
   * up: "time: id or class".
   */
  mainNotInert: string[];
  /** Samples with a <main> hidden by React (a suspended, already shown tree). */
  hiddenMainSamples: number;
  /**
   * Samples with the lace up and the lazy-screen slot ("Loading…") inside the
   * shell's rendered <main id="main">: the screen suspended, the shell didn't.
   */
  shellSuspendedSamples: number;
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

/** Installs the observer described at the top, in every document from now on. */
async function recordLoader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const LACE_COVER = '[data-testid="loading"][data-placement="viewport"]';
    const OPENING_COVER = '[data-testid="opening-cover"]';
    const LACE = '[data-testid="lace-loader"]';
    const SLOT = '[data-testid="loading-slot"]';
    // The tab bar, the desktop rail, "+" in both, and the skip link.
    const NAV: Record<string, string> = {
      nav: 'nav[aria-label="Main"]',
      aside: "aside",
      "quick-add-open": '[data-testid="quick-add-open"]',
      "quick-add-open-rail": '[data-testid="quick-add-open-rail"]',
    };
    const NAV_IN_DOM = [...Object.values(NAV), 'a[href="#main"]'].join(",");
    const covers: Element[] = [];
    const laces: Element[] = [];
    const slots = new WeakSet<Element>();
    const log: LoaderLog = {
      states: [],
      changes: [],
      covers: 0,
      laces: 0,
      mainNotInert: [],
      hiddenMainSamples: 0,
      shellSuspendedSamples: 0,
      slots: [],
      transactionsModuleAt: null,
    };
    window.__pageLoaderLog = log;
    let shown = false;
    // After every batch of DOM changes (one React commit), the state of the
    // page as the user would see it.
    const sample = () => {
      const t = performance.now();
      const lace = document.querySelector(LACE_COVER);
      const cover: Cover = lace
        ? "lace"
        : document.querySelector(OPENING_COVER)
          ? "opening"
          : "none";
      if (lace && !covers.includes(lace)) covers.push(lace);
      const svg = lace?.querySelector(LACE);
      if (svg && !laces.includes(svg)) laces.push(svg);
      log.covers = covers.length;
      log.laces = laces.length;
      if (Boolean(lace) !== shown) {
        shown = Boolean(lace);
        log.changes.push({ shown, t });
      }
      const nav = Object.entries(NAV)
        .filter(([, selector]) =>
          [...document.querySelectorAll(selector)].some((e) =>
            e.checkVisibility(),
          ),
        )
        .map(([name]) => name)
        .join(" ");
      const navInDom = document.querySelectorAll(NAV_IN_DOM).length;
      const last = log.states.at(-1);
      if (
        last?.cover !== cover ||
        last.nav !== nav ||
        last.navInDom !== navInDom
      )
        log.states.push({ t, cover, nav, navInDom });
      for (const main of document.querySelectorAll("main")) {
        const rendered = main.checkVisibility();
        if (!rendered) log.hiddenMainSamples += 1;
        else if (cover !== "none" && !main.hasAttribute("inert"))
          log.mainNotInert.push(
            `${String(Math.round(t))}: ${main.id || main.className}`,
          );
        if (
          rendered &&
          lace &&
          main.id === "main" &&
          main.querySelector(`${SLOT}[data-label="Loading…"]`)
        )
          log.shellSuspendedSamples += 1;
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
      // inert, and everything that can hide or show navigation or a <main>
      // without adding or removing it (React hides a suspended tree with an
      // inline display).
      attributeFilter: ["inert", "style", "hidden", "class"],
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
}

/** The log so far, and a one-line copy of it for failure messages. */
async function readLog(page: Page): Promise<{ log: LoaderLog; trace: string }> {
  const log = await page.evaluate(() => window.__pageLoaderLog!);
  return { log, trace: `page loader log: ${JSON.stringify(log)}` };
}

/** Every navigation part the current layout shows, as LoaderState.nav. */
function fullNav(isMobile: boolean): string {
  return isMobile ? "nav quick-add-open" : "nav aside quick-add-open-rail";
}

/**
 * The opening, in the states from its start to now: no navigation in the
 * document until the page is revealed, the page covered without a gap until
 * then, and all of the navigation in the same commit as the reveal; one change
 * only. Returns the reveal.
 */
function expectOpeningWithoutNav(
  states: readonly LoaderState[],
  isMobile: boolean,
  trace: string,
): LoaderState {
  const at = states.findIndex((s) => s.navInDom > 0);
  expect(at, `the navigation appeared in the end. ${trace}`).toBeGreaterThan(0);
  const reveal = states[at]!;
  expect(
    { cover: reveal.cover, nav: reveal.nav },
    `the navigation appeared whole, uncovered, in the same commit that removed the cover (${String(reveal.t)} ms). ${trace}`,
  ).toEqual({ cover: "none", nav: fullNav(isMobile) });
  const opening = states.slice(0, at);
  const firstCover = opening.findIndex((s) => s.cover !== "none");
  expect(
    firstCover,
    `the page was covered before the navigation appeared. ${trace}`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    opening.slice(firstCover).filter((s) => s.cover === "none"),
    `the opening stayed covered, without a gap, until the navigation appeared. ${trace}`,
  ).toEqual([]);
  expect(
    states.slice(at).filter((s) => s.nav !== fullNav(isMobile)),
    `once there, the navigation never changed or disappeared. ${trace}`,
  ).toEqual([]);
  return reveal;
}

/** A gate for page.route: held until release(); counts what waits at it. */
function gate(): {
  release: () => void;
  held: () => number;
  hold: (route: Route) => Promise<void>;
} {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  return {
    release: () => {
      release();
    },
    held: () => held,
    hold: async (route) => {
      held += 1;
      await open;
      await route.fallback().catch(() => undefined);
    },
  };
}

/** GET of one budget month's summary, whatever the month if none is given. */
function summaryOf(budgetId: string, month?: string): (url: URL) => boolean {
  const months = `/api/budgets/${budgetId}/months/`;
  return (url) =>
    month
      ? url.pathname === `${months}${month}/summary`
      : url.pathname.startsWith(months) && url.pathname.endsWith("/summary");
}

test.describe("page loader in full motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a signed-in cold start to Overview is one lace session over an inert page without navigation, lifted only at a cycle boundary; a first tab visit then doesn't suspend", async ({
    page,
    isMobile,
    cspViolations,
  }) => {
    test.skip(
      !isMobile,
      "phone projects: the cold start the owner sees; the session logic has no desktop branch, and the desktop rail's opening is the sign-in test below",
    );
    const user = await createUser({ prefix: "loader" });
    const budget = await createBudget(user, { name: "Loader household" });
    await signInAs(page, user.email);
    await recordLoader(page);

    // Hold this budget's month summary (the last load of the chain) until the
    // test releases it.
    const summary = gate();
    await page.route(summaryOf(budget.id), summary.hold);

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
        .poll(() => summary.held(), {
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
      expect(summary.held(), "the summary was still held during all this").toBe(
        1,
      );
    } finally {
      summary.release();
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
    const { log, trace } = await readLog(page);

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
      `React never hid a <main> already on screen: a suspended screen must stay inside the shell (BudgetLayout's <Suspense>), or the tab bar blinks. ${trace}`,
    ).toBe(0);
    expect(
      log.shellSuspendedSamples,
      `the held Overview module suspended inside the budget's shell, under the lace (else the check above proves nothing). ${trace}`,
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

    // 5. No navigation until the cover lifts, then all of it at once.
    const reveal = expectOpeningWithoutNav(log.states, isMobile, trace);
    expect(
      reveal.t,
      `the navigation appeared in the same sample as the cover's removal. ${trace}`,
    ).toBe(removedAt);

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
    const { log: after, trace: afterTrace } = await readLog(page);
    expect(
      after.slots.slice(slotsBefore).filter((s) => s.label === "Loading…"),
      `the preloaded Transactions screen rendered without suspending. ${afterTrace}`,
    ).toEqual([]);
    expectOpeningWithoutNav(after.states, isMobile, afterTrace);
  });

  test("moving to another month leaves the loader as soon as the month is there, mid-cycle; the arrow keeps focus and the navigation stays", async ({
    page,
    isMobile,
    taps,
  }) => {
    const user = await createUser({ prefix: "month" });
    const budget = await createBudget(user, { name: "Month household" });
    await signInAs(page, user.email);
    await recordLoader(page);

    // The opening isn't under test here: reduced motion skips its 3.2 s.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/budgets/${budget.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
    await expect(page.getByTestId("loading")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const cycleMs = await page.evaluate(async (moduleUrl) => {
      const m = (await import(/* @vite-ignore */ moduleUrl)) as {
        LACE_CYCLE_MS: number;
      };
      return m.LACE_CYCLE_MS;
    }, "/src/components/lace-timing.ts");
    const opening = await readLog(page);
    expect(
      opening.log.states.at(-1),
      `the page is open, uncovered, with its navigation, before the switch. ${opening.trace}`,
    ).toMatchObject({ cover: "none", nav: fullNav(isMobile) });

    const october = gate();
    await page.route(summaryOf(budget.id, "2026-10"), october.hold);
    const arrow = page.getByRole("link", { name: /^Previous month/ });
    const changesBefore = opening.log.changes.length;
    const statesBefore = opening.log.states.length;
    let shownAt: number;
    let releasedAt: number;
    try {
      await taps.tap(arrow);
      const released = await (
        await page.waitForFunction(
          ({ from, holdMs }) => {
            const shown = window.__pageLoaderLog?.changes[from];
            if (!shown) return false;
            const now = performance.now();
            return now - shown.t >= holdMs
              ? { shownAt: shown.t, releasedAt: now }
              : false;
          },
          { from: changesBefore, holdMs: MONTH_HOLD_MS },
          { timeout: 10_000 },
        )
      ).jsonValue();
      if (released === false) throw new Error("unreachable: waitForFunction");
      ({ shownAt, releasedAt } = released);
      const { log, trace } = await readLog(page);
      expect(
        log.states.at(-1)?.cover,
        `the lace is up while October loads. ${trace}`,
      ).toBe("lace");
      expect(october.held(), "October's summary is still held").toBe(1);
    } finally {
      october.release();
    }

    await page.waitForFunction(
      (from) => window.__pageLoaderLog?.changes[from + 1]?.shown === false,
      changesBefore,
      { timeout: 2 * cycleMs },
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "October" }),
    ).toBeVisible();
    await expect(page.getByTestId("total-remaining")).toBeVisible();
    await expect(
      arrow,
      "the tapped arrow has focus back (not the heading, not <body>)",
    ).toBeFocused();
    await expect(page.getByRole("main")).not.toHaveAttribute("inert");

    const { log, trace } = await readLog(page);
    expect(
      log.changes.slice(changesBefore).map((c) => c.shown),
      `one appearance and one removal of the lace for the switch. ${trace}`,
    ).toEqual([true, false]);
    const removedAt = log.changes[changesBefore + 1]!.t;
    expect(
      removedAt,
      `the cover stayed up until October's summary was released. ${trace}`,
    ).toBeGreaterThan(releasedAt);
    expect(
      removedAt - releasedAt,
      `the cover left soon after the release (${String(removedAt - releasedAt)} ms), not at the end of the lace's cycle. ${trace}`,
    ).toBeLessThan(MONTH_LEAVE_MS);
    expect(
      cycleMs - (removedAt - shownAt),
      `the cover left clearly before the cycle boundary (${String(removedAt - shownAt)} of ${String(cycleMs)} ms on screen). ${trace}`,
    ).toBeGreaterThan(BOUNDARY_TOLERANCE_MS);
    expect(
      log.states.slice(statesBefore).map((s) => s.nav),
      `the navigation was there in every sample of the switch. ${trace}`,
    ).toEqual(log.states.slice(statesBefore).map(() => fullNav(isMobile)));
    expect(
      log.mainNotInert,
      `every rendered <main> was inert whenever a cover was up. ${trace}`,
    ).toEqual([]);
  });
});

test.describe("navigation and the page loader", () => {
  test("a later tab load keeps the navigation on screen and usable the whole time, also while the screen's code loads", async ({
    page,
    isMobile,
    taps,
  }) => {
    const user = await createUser({ prefix: "tab" });
    const budget = await createBudget(user, { name: "Tab household" });
    await signInAs(page, user.email);
    await recordLoader(page);

    // The Categories screen's module, held from the start: the idle preload
    // asks for it too, so the tap finds it still loading and suspends.
    const categories = gate();
    await page.route(
      (url) => url.pathname === "/src/screens/budget/CategoriesScreen.tsx",
      categories.hold,
    );
    await page.goto(`/budgets/${budget.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
    await expect(page.getByTestId("loading")).toHaveCount(0);
    const opened = await readLog(page);
    expect(
      opened.log.states.at(-1),
      `the opening is over, with the navigation there. ${opened.trace}`,
    ).toMatchObject({ cover: "none", nav: fullNav(isMobile) });
    const statesBefore = opened.log.states.length;
    try {
      await taps.tap(
        page
          .getByRole("navigation", { name: "Main" })
          .getByRole("link", { name: "Budgets" }),
      );
      await page.waitForFunction(
        () => window.__pageLoaderLog?.states.at(-1)?.cover === "lace",
        undefined,
        { timeout: 10_000 },
      );
      const covered = await readLog(page);
      expect(
        covered.log.states.at(-1)?.nav,
        `the navigation is there while the screen's code loads. ${covered.trace}`,
      ).toBe(fullNav(isMobile));
      // Above the cover: a click on "+" would reach it (checked, not done).
      await quickAddOpener(page).click({ trial: true, timeout: 5_000 });
      // At least once: the preload and the tap each import it, and WebKit
      // fetches a module again while its first fetch is still pending.
      expect(
        categories.held(),
        "the screen's module is still held",
      ).toBeGreaterThan(0);
    } finally {
      categories.release();
    }
    await expect(page.getByTestId("category-row").first()).toBeVisible();
    await page.waitForFunction(
      () => window.__pageLoaderLog?.states.at(-1)?.cover === "none",
      undefined,
      { timeout: 10_000 },
    );

    const { log, trace } = await readLog(page);
    const during = log.states.slice(statesBefore);
    expect(
      during.map((s) => s.cover),
      `the tab load showed the loader once (reduced motion: until loaded). ${trace}`,
    ).toEqual(["lace", "none"]);
    expect(
      during.map((s) => s.nav),
      `the navigation was there in every sample of the tab load. ${trace}`,
    ).toEqual(during.map(() => fullNav(isMobile)));
    expect(
      log.shellSuspendedSamples,
      `the screen suspended inside the shell (else this proves nothing). ${trace}`,
    ).toBeGreaterThan(0);
    expect(log.hiddenMainSamples, `no <main> was hidden. ${trace}`).toBe(0);
  });

  test("from signing in to the first page there is no navigation; it appears with the page", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "one project, the desktop one: it is the only opening of the rail; the phones' opening is the cold-start test",
    );
    const user = await createUser({ prefix: "opening" });
    const budget = await createBudget(user, { name: "Opening household" });
    const summary = gate();
    await page.route(summaryOf(budget.id), summary.hold);
    await recordLoader(page);

    await page.goto("/signin");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    // The sign-in page's own loader is over: what follows is the opening.
    await expect(page.getByTestId("loading")).toHaveCount(0);
    const signIn = await readLog(page);
    expect(
      signIn.log.states.filter((s) => s.navInDom > 0),
      `signed-out pages have no navigation. ${signIn.trace}`,
    ).toEqual([]);
    const statesBefore = signIn.log.states.length;

    let coveredAt: number | null;
    try {
      await page.getByTestId("sign-in-submit").click();
      await expect
        .poll(() => summary.held(), {
          message: "the first page (Overview) asked for its month summary",
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await page.waitForFunction(
        () => window.__pageLoaderLog?.states.at(-1)?.cover === "lace",
        undefined,
        { timeout: 10_000 },
      );
      // Under the cover the page already sits where it will be revealed: the
      // rail's width is kept for it.
      coveredAt = await page.evaluate(
        () =>
          document.querySelector("main h1")?.getBoundingClientRect().x ?? null,
      );
      expect(coveredAt, "Overview's heading is under the cover").not.toBeNull();
    } finally {
      summary.release();
    }
    await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
    await expect(quickAddOpener(page)).toBeVisible();

    const { log, trace } = await readLog(page);
    expectOpeningWithoutNav(log.states.slice(statesBefore), isMobile, trace);
    expect(
      log.mainNotInert,
      `every rendered <main> was inert whenever a cover was up. ${trace}`,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.querySelector("main h1")?.getBoundingClientRect().x,
      ),
      "the page didn't move sideways when the rail appeared",
    ).toBe(coveredAt);
  });
});

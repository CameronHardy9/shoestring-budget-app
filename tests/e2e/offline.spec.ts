// "Online to save" (ADR-0002, owner ruling round 7) on a real browser that
// really goes offline (`context.setOffline`: navigator.onLine flips and the
// `offline`/`online` events fire, which is what TanStack Query listens to):
//   - quick-add Save while offline fails at once, keeps the entry and offers
//     Retry (never a spinner that waits for the connection);
//   - Retry after reconnecting, and after a lost response, saves exactly once
//     (same Idempotency-Key, ADR-0002);
//   - a screen opened offline with nothing cached settles on its offline
//     message instead of loading forever, and fills in after reconnecting;
//   - /more opened offline still shows Sign out, which then fails honestly
//     (F-51).
//
// Why the whole browser goes offline here and not only `page.route` failures:
// a routed abort leaves navigator.onLine true, so reads would fail and retry
// instead of pausing, and the offline screens would never be reached. Two
// things in the dev-server setup are made deterministic instead:
//   - Vite's live-reload websocket is replaced by a mock that is never closed
//     (`page.routeWebSocket`, the app itself uses no websockets). A closed
//     socket makes Vite's client poll the server and reload the page after a
//     reconnect, which would wipe the sheet mid-test; Playwright 1.65 keeps an
//     open socket alive across setOffline, but nothing promises that.
//     `expectSameDocument` fails loudly if the page reloads anyway.
//   - Every screen is lazy (its own module). Offline, a screen whose module
//     was never fetched cannot load in the dev build (and the screen under
//     test would never render), so the screens' modules are loaded while
//     online through the app's own `preloadAllScreens()`, without rendering
//     them, so none of their data is cached.
// Offline, a document load is impossible without a service worker (journeys
// block it, ADR-0009), so "open a URL" offline is an in-app navigation to it
// (pushState + popstate, which the app's router follows).
import type { BrowserContext, Page, Request } from "@playwright/test";
import { dal } from "../support/dal.ts";
import {
  createBudget,
  createTransaction,
  createUser,
} from "../support/factories.ts";
import type { TestBudget } from "../support/factories.ts";
import { env } from "../support/env.ts";
import { expect, quickAddOpener, signInAs, test } from "./fixtures.ts";

const NETWORK_COPY =
  "You're offline or the connection dropped. Nothing you typed was lost.";
const SIGN_OUT_OFFLINE =
  "Couldn't sign out. Check your connection and try again.";

declare global {
  interface Window {
    /** Set once by the test; a reload would lose it. */
    __offlineSpecDocument?: true;
  }
}

/** Replaces Vite's HMR websocket with a mock that never closes (see header). */
async function muteLiveReload(page: Page): Promise<void> {
  const appHost = new URL(env.baseUrl).host;
  await page.routeWebSocket(
    (url) => url.host === appHost,
    () => undefined, // not connected to the server: stays open, drops messages
  );
}

/** Marks the current document; `expectSameDocument` proves it never reloaded. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__offlineSpecDocument = true;
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => window.__offlineSpecDocument === true),
    "the page was never reloaded (a dev-server live reload would wipe the screen)",
  ).toBe(true);
}

/** Loads every lazy screen's module (no rendering, no data) while online. */
async function preloadScreens(page: Page): Promise<void> {
  await page.evaluate(async (moduleUrl) => {
    const lazy = (await import(/* @vite-ignore */ moduleUrl)) as {
      preloadAllScreens: () => Promise<void>;
    };
    await lazy.preloadAllScreens();
  }, "/src/app/lazy-screen.tsx");
}

async function setOnline(
  context: BrowserContext,
  page: Page,
  online: boolean,
): Promise<void> {
  await context.setOffline(!online);
  await expect
    .poll(() => page.evaluate(() => navigator.onLine), {
      message: `navigator.onLine follows setOffline(${String(!online)})`,
    })
    .toBe(online);
}

/** In-app navigation to an app URL, as a link tap would do (see header). */
async function openInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function storedTransactions(budget: TestBudget) {
  return (
    await dal().transactions.listTransactions(budget.scope, { limit: 100 })
  ).items;
}

/** POSTs of a new transaction the page made, with their Idempotency-Keys. */
function recordCreates(page: Page, budgetId: string): (string | null)[] {
  const keys: (string | null)[] = [];
  const path = `/api/budgets/${budgetId}/transactions`;
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === path)
      keys.push(req.headers()["idempotency-key"] ?? null);
  });
  return keys;
}

/** A budget on its overview, the sheet open (online) with the chips loaded. */
async function overviewWithSheet(page: Page): Promise<TestBudget> {
  const user = await createUser({ prefix: "unplugged" });
  const budget = await createBudget(user, { name: "Offline household" }); // Groceries 500, Dining 200
  await muteLiveReload(page);
  await signInAs(page, user.email);
  await page.goto(`/budgets/${budget.id}`);
  await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
  await markDocument(page);
  await quickAddOpener(page).click();
  const sheet = page.getByTestId("quick-add-sheet");
  await expect(sheet.getByText("Groceries", { exact: true })).toBeVisible();
  return budget;
}

/** Offline: amount, category, Save. Leaves the sheet in its failed state. */
async function saveWhileOffline(
  page: Page,
  context: BrowserContext,
): Promise<{ elapsedMs: number }> {
  const sheet = page.getByTestId("quick-add-sheet");
  await setOnline(context, page, false);
  await page.getByTestId("quick-add-amount").fill("24");
  await sheet.getByText("Groceries", { exact: true }).click();
  const started = performance.now();
  await page.getByTestId("quick-add-save").click();
  await expect(sheet.getByTestId("form-error")).toContainText(NETWORK_COPY, {
    timeout: 1_000,
  });
  return { elapsedMs: performance.now() - started };
}

test.describe("offline: online to save", () => {
  test("quick-add Save while offline fails at once with the offline message, keeps the entry and offers Retry (no spinner)", async ({
    page,
    context,
  }) => {
    const budget = await overviewWithSheet(page);
    const { elapsedMs } = await saveWhileOffline(page, context);
    expect(elapsedMs, "the failure shows within about 1 s").toBeLessThan(1_000);

    const sheet = page.getByTestId("quick-add-sheet");
    const save = page.getByTestId("quick-add-save");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("quick-add-amount")).toHaveValue("24");
    await expect(save).toHaveText("Retry");
    await expect(
      save,
      "not pending: no spinner waiting for a connection",
    ).not.toHaveAttribute("data-pending");
    await expect(save).toBeEnabled();
    await expect(sheet.getByTestId("loading")).toHaveCount(0);
    expect(await storedTransactions(budget), "nothing was saved").toEqual([]);
    await expectSameDocument(page);
  });

  test("back online, Retry saves exactly one transaction with the same Idempotency-Key", async ({
    page,
    context,
  }) => {
    const budget = await overviewWithSheet(page);
    const keys = recordCreates(page, budget.id);
    await saveWhileOffline(page, context);

    await setOnline(context, page, true);
    const sheet = page.getByTestId("quick-add-sheet");
    await page.getByTestId("quick-add-save").click();
    await expect(sheet).toBeHidden();
    await expect(
      page.getByTestId("transaction-row").filter({ hasText: "$24.00" }),
    ).toHaveCount(1);
    await expect(page.getByTestId("transaction-row")).toHaveCount(1);
    await expect(page.getByTestId("total-remaining")).toHaveText("$676.00");

    const stored = await storedTransactions(budget);
    expect(stored, "exactly one transaction on the server").toHaveLength(1);
    expect(stored[0]).toMatchObject({
      amountCents: 2_400,
      direction: "outflow",
    });
    expect(stored[0]!.splits).toMatchObject([
      { categoryId: budget.categories.Groceries, amountCents: 2_400 },
    ]);
    // The offline attempt is a request the browser refused to send; it still
    // shows up as a (failed) request, with its key, on every engine.
    expect(keys, "two attempts: offline, then Retry").toHaveLength(2);
    expect(keys[0], "creates carry an Idempotency-Key").toBeTruthy();
    expect(keys[1], "Retry reuses the offline attempt's key").toBe(keys[0]);
    await expectSameDocument(page);
  });

  test("a Save whose response was lost, then Retry, creates exactly one transaction", async ({
    page,
  }) => {
    const budget = await overviewWithSheet(page);
    const keys = recordCreates(page, budget.id);
    const path = `/api/budgets/${budget.id}/transactions`;
    // The first create reaches the server and is committed; its response
    // never reaches the page (the connection drops on the way back).
    const lost: number[] = [];
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        if (route.request().method() !== "POST" || lost.length > 0)
          return route.fallback();
        const response = await route.fetch();
        lost.push(response.status());
        await route.abort("connectionreset");
      },
    );
    const sheet = page.getByTestId("quick-add-sheet");
    await page.getByTestId("quick-add-amount").fill("24");
    await sheet.getByText("Groceries", { exact: true }).click();
    await page.getByTestId("quick-add-save").click();
    await expect(sheet.getByTestId("form-error")).toContainText(NETWORK_COPY);
    await expect(page.getByTestId("quick-add-save")).toHaveText("Retry");
    expect(lost, "the server answered the first attempt").toEqual([201]);
    expect(
      await storedTransactions(budget),
      "the server already holds it",
    ).toHaveLength(1);

    const replay = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === path && r.request().method() === "POST",
    );
    await page.getByTestId("quick-add-save").click();
    const replayed = await replay;
    expect(replayed.status()).toBe(201);
    expect(
      replayed.headers()["idempotent-replayed"],
      "the retry was answered from the stored result",
    ).toBe("true");
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("transaction-row")).toHaveCount(1);
    await expect(page.getByTestId("total-remaining")).toHaveText("$676.00");
    expect(
      await storedTransactions(budget),
      "still exactly one transaction",
    ).toHaveLength(1);
    expect(keys, "both attempts used one Idempotency-Key").toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await expectSameDocument(page);
  });

  test("screens opened offline with nothing cached show the offline message, not a loader, and fill in after reconnecting", async ({
    page,
    context,
  }) => {
    const user = await createUser({ prefix: "commuter" });
    const budget = await createBudget(user, { name: "Commuter household" });
    // Content each screen shows once it can load:
    await createTransaction(budget.scope, {
      date: "2026-10-12", // October: never loaded before going offline
      categoryId: budget.categories.Groceries!,
      amountCents: 3_000,
      payee: "Autumn market",
    });
    const old = await createBudget(user, { name: "Old cabin fund" });
    await dal().budgets.deleteBudget(old.scope, old.record.version);
    const host = await createUser({ prefix: "host" });
    const theirs = await createBudget(host, { name: "Shared flat" });
    await dal().invitations.createBudgetInvitation(theirs.scope, user.email);

    await muteLiveReload(page);
    await signInAs(page, user.email);
    await page.goto(`/budgets/${budget.id}/transactions`);
    await expect(
      page.getByRole("heading", { name: "Transactions" }),
    ).toBeVisible();
    await expect(page.getByText(/Nothing in November 2026 yet/)).toBeVisible();
    await markDocument(page);
    await preloadScreens(page);

    const screens = [
      {
        path: `/budgets/${budget.id}/transactions?month=2026-10`,
        heading: "Transactions",
        content: page
          .getByTestId("transaction-row")
          .filter({ hasText: "Autumn market" }),
      },
      {
        path: "/settings/sessions",
        heading: "Signed-in devices",
        content: page.getByTestId("session-list"),
      },
      {
        path: "/settings/security",
        heading: "Security",
        content: page.getByTestId("mfa-status"),
      },
      {
        path: "/settings/deleted-budgets",
        heading: "Deleted budgets",
        content: page
          .getByTestId("deleted-budgets")
          .getByText("Old cabin fund"),
      },
      {
        path: "/invitations",
        heading: "Invitations",
        content: page.getByTestId("my-invitations").getByText("Shared flat"),
      },
    ];
    for (const screen of screens) {
      await test.step(screen.path, async () => {
        await setOnline(context, page, false);
        await openInApp(page, screen.path);
        await expect(
          page.getByRole("heading", { level: 1, name: screen.heading }),
        ).toBeVisible();
        await expect(
          page.getByTestId("offline"),
          `${screen.path}: offline message while offline`,
        ).toBeVisible();
        await expect(
          page.getByTestId("loading"),
          `${screen.path}: no loader while offline`,
        ).toHaveCount(0);
        await expect(screen.content).toHaveCount(0);

        await setOnline(context, page, true);
        await expect(
          screen.content,
          `${screen.path}: content after reconnecting`,
        ).toBeVisible();
        await expect(page.getByTestId("offline")).toHaveCount(0);
      });
    }
    await expectSameDocument(page);
  });

  test("/more opened offline shows the offline message and Sign out; Sign out then says it couldn't (F-51)", async ({
    page,
    context,
  }) => {
    const user = await createUser({ prefix: "drifter" });
    await createBudget(user, { name: "Drifter household" });
    await muteLiveReload(page);
    await signInAs(page, user.email);
    // A signed-in screen that doesn't read the budget list, so /more's first
    // load of it happens offline.
    await page.goto("/settings/account");
    await expect(
      page.getByRole("heading", { level: 1, name: "Account" }),
    ).toBeVisible();
    await markDocument(page);
    await preloadScreens(page);

    await setOnline(context, page, false);
    await openInApp(page, "/more");
    await expect(
      page.getByRole("heading", { level: 1, name: "More" }),
    ).toBeVisible();
    await expect(page.getByTestId("offline")).toContainText(
      "Your budgets will appear when you reconnect",
    );
    await expect(page.getByTestId("loading")).toHaveCount(0);
    const signOut = page.getByTestId("sign-out");
    await expect(signOut).toBeVisible();

    await signOut.click();
    await expect(
      page.getByTestId("sign-out-error").getByRole("alert"),
    ).toContainText(SIGN_OUT_OFFLINE);
    await expect(page).toHaveURL(/\/more$/);
    await expect(signOut).toBeEnabled();
    expect(
      (await page.request.get("/api/auth/session")).status(),
      "still signed in on the server",
    ).toBe(200);
    await expectSameDocument(page);
  });
});

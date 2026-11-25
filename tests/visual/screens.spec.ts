// Key screens, light and dark, at two phone sizes (task 6): sign-in, overview,
// quick-add, quick-add split, transactions, categories. Deterministic: the
// server clock is frozen (DEFAULT_NOW), the browser clock is fixed to the same
// instant, data and names are fixed, animations and the caret are off, and
// fonts are self-hosted and awaited.
// Data goes in over HTTP only (test hooks + API, straight to the backend at
// API_URL through the e2e edge), so the suite needs nothing but the stack's
// addresses. The Playwright container has the database packages too, but this
// suite does not load the DAL.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { DEFAULT_NOW, signupInvite } from "../support/hooks.ts";
import { randomPassword } from "../support/passwords.ts";
import { ApiClient } from "../support/http.ts";
import type { CspViolation, CspViolations } from "../e2e/fixtures.ts";
import {
  expect,
  expectNoCspViolations,
  flushCspViolations,
  signInAs,
  test,
} from "../e2e/fixtures.ts";

async function settle(page: Page): Promise<void> {
  // No loader in the shot: neither the viewport-centred one (position: fixed,
  // so it can sit over finished content) nor an inline one (Overview's
  // "Recent", the quick-add sheet's chips), including behind a sheet's scrim.
  await expect(
    page.getByTestId("loading"),
    "a loader is still on screen; wait for the data it stands for before the screenshot",
  ).toHaveCount(0);
  // Nor the opening's plain cover (no navigation yet under it).
  await expect(page.getByTestId("opening-cover")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

/**
 * Where WebKit reports the one <style> Playwright's screenshot helper injects
 * (`inPagePrepareForScreenshots`: `style.textContent = "body {}"`, appended to
 * <head> and removed at once to sync animations; WebKit only). The production
 * CSP rightly blocks it. WebKit sends no `sample` (the policy has no
 * 'report-sample'), so the violation is identified by its position in that
 * evaluated helper: no source file, and the line and column of its
 * `document.head.appendChild(style)` call. Read from the installed Playwright,
 * so an upgrade that moves the helper fails loudly here instead of widening
 * the filter.
 */
function screenshotStyleSite(): { line: number; column: number } {
  const req = createRequire(import.meta.url);
  const playwright = createRequire(req.resolve("@playwright/test/package.json"))
    .resolve("playwright/package.json");
  const core = createRequire(playwright).resolve("playwright-core/package.json");
  const src = readFileSync(join(dirname(core), "lib", "coreBundle.js"), "utf8");
  const start = src.indexOf("function inPagePrepareForScreenshots(");
  const body = src.slice(start);
  const call = "document.head.appendChild(style)";
  const at = body.indexOf(call);
  if (start < 0 || at < 0 || !body.slice(0, at).includes('style.textContent = "body {}"'))
    throw new Error(
      "visual/screens.spec.ts: Playwright's screenshot <style> helper was not found in playwright-core; " +
        "re-check screenshotStyleSite() after the Playwright upgrade",
    );
  const before = body.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    line: before.split("\n").length,
    // 1-based column of the call's "(", which is where WebKit reports it.
    column: at - lineStart + "document.head.appendChild".length + 1,
  };
}
const SITE = screenshotStyleSite();

const isScreenshotStyle = (v: CspViolation): boolean =>
  v.directive.startsWith("style-src") &&
  v.blocked === "inline" &&
  (v.sample === "" || v.sample === "body {}") &&
  v.sourceFile === "" &&
  v.line === SITE.line &&
  v.column === SITE.column;

/**
 * Screenshot with the CSP gate applied: app violations up to that point fail
 * here; after the screenshot, only the violations of Playwright's own
 * screenshot <style> are dropped (isScreenshotStyle). Anything else, including
 * an app violation during the screenshot's stability loop, stays in the list
 * and fails the test at teardown (e2e/fixtures.ts).
 */
async function snap(
  page: Page,
  csp: CspViolations,
  name: string,
): Promise<void> {
  await settle(page);
  await flushCspViolations(page);
  expectNoCspViolations(csp);
  await expect(page).toHaveScreenshot(name);
  await flushCspViolations(page);
  csp.take(isScreenshotStyle);
}

async function household(page: Page): Promise<{ id: string }> {
  const email = "robin.visual@example.test";
  const api = new ApiClient("visual");
  const signup = await api.post("/auth/signup", {
    token: await signupInvite(email),
    displayName: "Robin Visual",
    password: randomPassword(),
  });
  expect(signup.status).toBe(201);
  const created = await api.post<{ id: string }>(
    "/budgets",
    {
      name: "Maple Street",
      timezone: "America/New_York",
      categories: [
        { name: "Groceries", kind: "expense", plannedCents: 60_000 },
        { name: "Dining out", kind: "expense", plannedCents: 15_000 },
        { name: "Transport", kind: "expense", plannedCents: 12_000 },
        { name: "Utilities", kind: "expense", plannedCents: 20_000 },
        { name: "Salary", kind: "income", plannedCents: 420_000 },
      ],
    },
    { idempotencyKey: randomUUID() },
  );
  expect(created.status).toBe(201);
  const id = created.body.id;
  const cats = await api.get<{ items: { id: string; name: string }[] }>(`/budgets/${id}/categories`);
  const cat = (name: string) => cats.body.items.find((c) => c.name === name)!.id;
  const rows: [string, string, number, string, ("outflow" | "inflow")?][] = [
    ["2026-11-02", "Groceries", 8_642, "Corner market"],
    ["2026-11-03", "Dining out", 4_850, "Noodle bar"],
    ["2026-11-05", "Utilities", 9_420, "City power"],
    ["2026-11-08", "Groceries", 12_310, "Corner market"],
    ["2026-11-09", "Groceries", 1_500, "Corner market refund", "inflow"],
    ["2026-11-10", "Transport", 13_500, "Bus pass"],
    ["2026-11-14", "Dining out", 3_275, "Taqueria"],
    ["2026-11-15", "Salary", 420_000, "Payroll", "inflow"],
    ["2026-11-16", "Groceries", 2_799, "Bakery"],
  ];
  for (const [date, name, amountCents, payee, direction] of rows) {
    const r = await api.post(
      `/budgets/${id}/transactions`,
      { date, direction: direction ?? "outflow", amountCents, payee, splits: [{ categoryId: cat(name), amountCents }] },
      { idempotencyKey: randomUUID() },
    );
    expect(r.status).toBe(201);
  }
  await signInAs(page, email);
  return { id };
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date(DEFAULT_NOW));
    });

    test("sign-in", async ({ page, cspViolations }) => {
      await page.goto("/signin");
      await expect(
        page.getByRole("heading", { name: "Sign in" }),
      ).toBeVisible();
      await snap(page, cspViolations, `signin-${scheme}.png`);
    });

    test("overview", async ({ page, cspViolations }) => {
      const b = await household(page);
      await page.goto(`/budgets/${b.id}`);
      await expect(page.getByTestId("total-remaining")).toBeVisible();
      await expect(page.getByText("Bakery")).toBeVisible();
      await snap(page, cspViolations, `overview-${scheme}.png`);
    });

    test("quick-add", async ({ page, cspViolations }) => {
      const b = await household(page);
      await page.goto(`/budgets/${b.id}`);
      // The page behind the sheet's scrim is part of the screenshot: let it
      // finish loading first, or the baseline would catch a loader.
      await expect(page.getByTestId("total-remaining")).toBeVisible();
      await page.getByTestId("quick-add-open").click();
      await page.keyboard.type("12.50");
      await page
        .getByTestId("quick-add-sheet")
        .getByText("Groceries", { exact: true })
        .click();
      await snap(page, cspViolations, `quick-add-${scheme}.png`);
    });

    test("quick-add split", async ({ page, cspViolations }) => {
      const b = await household(page);
      await page.goto(`/budgets/${b.id}`);
      // The page behind the sheet's scrim is part of the screenshot: let it
      // finish loading first, or the baseline would catch a loader.
      await expect(page.getByTestId("total-remaining")).toBeVisible();
      await page.getByTestId("quick-add-open").click();
      const sheet = page.getByTestId("quick-add-sheet");
      await page.keyboard.type("60");
      await sheet.getByText("Groceries", { exact: true }).click();
      await sheet.getByRole("button", { name: "Split" }).click();
      await page
        .getByTestId("split-editor")
        .getByLabel("Amount 1, Groceries")
        .fill("45");
      await page
        .getByTestId("split-editor")
        .getByLabel("Category 2")
        .selectOption({ label: "Utilities" });
      await expect(page.getByTestId("split-left-to-assign")).toContainText(
        "left to assign",
      );
      await snap(page, cspViolations, `quick-add-split-${scheme}.png`);
    });

    test("transactions", async ({ page, cspViolations }) => {
      const b = await household(page);
      await page.goto(`/budgets/${b.id}/transactions`);
      await expect(page.getByTestId("transaction-row")).toHaveCount(9);
      await snap(page, cspViolations, `transactions-${scheme}.png`);
    });

    test("categories", async ({ page, cspViolations }) => {
      const b = await household(page);
      await page.goto(`/budgets/${b.id}/categories`);
      await expect(page.getByTestId("category-row")).toHaveCount(5);
      await snap(page, cspViolations, `categories-${scheme}.png`);
    });
  });
}

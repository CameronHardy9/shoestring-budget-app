// CSP violation gate on the PRODUCTION build (C3.1, F-23). The Vite dev
// server sends no CSP (and must inject inline styles in dev), so the journeys
// cannot prove anything about the policy; these tests load the real bundle with
// the backend's real headers (scripts/prod-server.mjs) and fail on any
// `securitypolicyviolation` (the fixture), while exercising both of React
// Aria's injected <style> blocks:
//   - usePress: any pressable control;
//   - usePreventScroll: an open modal on iOS WebKit (React Aria injects it
//     only on iOS, so the WebKit project reports an iPhone platform).
import { createBudget, createUser } from "../../support/factories.ts";
import type { Page } from "@playwright/test";
import type { CspViolation } from "../fixtures.ts";
import { expect, expectNoCspViolations, test } from "../fixtures.ts";

/** Adds an inline <style> the policy must block; resolves with the violated directive. */
async function injectBlockedStyle(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const seen = new Promise<string>((resolve) => {
      document.addEventListener(
        "securitypolicyviolation",
        (e) => resolve(e.violatedDirective),
        { once: true },
      );
    });
    const s = document.createElement("style");
    s.textContent = "body { outline: 1px solid red }";
    document.head.append(s);
    const directive = await seen;
    s.remove();
    return directive;
  });
}

const injected = (path: string) => (v: CspViolation) =>
  v.page === path && v.directive.startsWith("style-src") && v.blocked === "inline";

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit")
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", {
        get: () => "iPhone",
      });
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
        get: () => 5,
      });
    });
});

test("the production document carries the backend's CSP, and the gate catches a violation", async ({
  page,
  cspViolations,
}) => {
  const res = await page.goto("/signin");
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toMatch(/style-src 'self' 'sha256-[^']+' 'sha256-[^']+'(;|$)/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // Prove the gate is live: an inline style is blocked and recorded.
  expect(await injectBlockedStyle(page)).toMatch(/^style-src/);
  await expect
    .poll(() => cspViolations.list.filter(injected("/signin")).length)
    .toBe(1);
  // Expected here; anything else still fails the test at teardown.
  cspViolations.take(injected("/signin"));
});

test("a violation on an earlier page still fails the test after navigating away (F-55 self-check)", async ({
  page,
  cspViolations,
}) => {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await injectBlockedStyle(page)).toMatch(/^style-src/);
  // A new document, as a mid-test page.goto or location.replace would make.
  await page.goto("/reset-password");
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect
    .poll(() => cspViolations.list.filter(injected("/signin")).length)
    .toBe(1);
  // The teardown check itself fails on it, although the page has moved on.
  expect(() => expectNoCspViolations(cspViolations)).toThrow(
    /\/signin: style-src/,
  );
  // Expected here; anything else still fails the test at teardown.
  cspViolations.take(injected("/signin"));
});

test("sign in, quick-add with a chip and a modal sheet, confirm dialog: zero CSP violations", async ({
  page,
  browserName,
}) => {
  const user = await createUser({ prefix: "csp" });
  const b = await createBudget(user, { name: "CSP household" });
  // A real password sign-in through the production UI.
  await page.goto("/signin");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByTestId("sign-in-submit").click();
  await expect(page).not.toHaveURL(/\/signin$/);
  await page.goto(`/budgets/${b.id}`);
  await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");

  await page.getByTestId("quick-add-open").click();
  const sheet = page.getByTestId("quick-add-sheet");
  await expect(sheet).toBeVisible();
  await page.keyboard.type("8.50");
  await sheet.getByText("Dining", { exact: true }).click();
  const styles = await page.evaluate(() =>
    [...document.querySelectorAll("style")].map((s) => s.textContent),
  );
  expect(
    styles.some((s) => s.includes("data-react-aria-pressable")),
    "usePress injected its style",
  ).toBe(true);
  if (browserName === "webkit")
    expect(
      styles.some((s) => s.includes("overscroll-behavior")),
      "usePreventScroll injected its style (iOS)",
    ).toBe(true);
  await page.getByTestId("quick-add-save").click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("total-remaining")).toHaveText("$691.50");

  await page.goto(`/budgets/${b.id}/transactions`);
  await page.getByTestId("transaction-row").first().click();
  await page.getByTestId("delete-transaction").click();
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("transaction-row")).toHaveCount(0);
});

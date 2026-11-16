// Session hygiene on the device (ARCHITECTURE "No financial data on the device"):
//   C3.5 / F-32: sign-out clears in-memory state with a full location.replace,
//        and Back never shows signed-in data again (sign-out-back.ts; the
//        bfcache path is proven on csp-prod-chromium).
//   C3.4 (storage half): only the theme and the last budget ID are stored,
//        also while a quick-add draft is open and after J2 saves.
//   C3.6 / F-06: an emailed #token= link is out of the URL as soon as the page
//        has loaded.
import { createBudget, createUser } from "../support/factories.ts";
import { lastEmail, testLogin } from "../support/hooks.ts";
import { ApiClient, COOKIE_NAME } from "../support/http.ts";
import type { Page } from "@playwright/test";
import {
  expect,
  expectAccessible,
  quickAddOpener,
  signInAs,
  test,
} from "./fixtures.ts";
import { openMoreSettled, signOutThenBack } from "./sign-out-back.ts";

const ALLOWED_LOCAL_STORAGE = new Set([
  "shoestring.theme",
  "shoestring.lastBudgetId",
]);

/**
 * C3.4: localStorage holds only the two allowed keys, with harmless values
 * (a theme name, the budget's ID); nothing in sessionStorage, IndexedDB or
 * Cache Storage; the session cookie is invisible to script.
 */
async function expectDeviceHoldsNoData(
  page: Page,
  budgetId: string,
  when: string,
): Promise<void> {
  const stored = await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.keys(sessionStorage),
    idb:
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name)
        : [],
    caches: typeof caches === "undefined" ? [] : await caches.keys(),
    cookieVisibleToScript: document.cookie,
  }));
  for (const [k, v] of stored.local) {
    expect(ALLOWED_LOCAL_STORAGE.has(k), `${when}: localStorage key ${k}`).toBe(
      true,
    );
    if (k === "shoestring.theme")
      expect(["system", "light", "dark"], `${when}: theme value`).toContain(v);
    if (k === "shoestring.lastBudgetId")
      expect(v, `${when}: lastBudgetId value`).toBe(budgetId);
  }
  expect(stored.session, `${when}: sessionStorage`).toEqual([]);
  expect(stored.idb, `${when}: IndexedDB`).toEqual([]);
  expect(stored.caches, `${when}: Cache Storage`).toEqual([]);
  expect(
    stored.cookieVisibleToScript,
    `${when}: the session cookie is httpOnly`,
  ).toBe("");
}

test.describe("sign-out and back-forward cache (C3.5, F-32)", () => {
  // The scenario and which browsers can restore from bfcache: sign-out-back.ts.
  // These projects keep Playwright's default (bfcache off), so Back loads the
  // page afresh; the bfcache path itself runs on csp-prod-chromium
  // (e2e/csp-prod/sign-out-back.spec.ts).
  test("after sign-out, Back (a fresh load) shows no budget data and the session is gone", async ({
    page,
  }) => {
    await signOutThenBack(page, false);
    await expectAccessible(page, "sign-in after Back");
  });

  test("a sign-out the server never confirmed says so and keeps you signed in; the retry signs out and kills the session (F-51)", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "unplugged" });
    await signInAs(page, user.email);
    await openMoreSettled(page);
    const cookie = (await page.context().cookies()).find(
      (c) => c.name === COOKIE_NAME,
    );
    expect(cookie, "signed in with a session cookie").toBeDefined();
    const signOut = page.getByTestId("sign-out");
    const failure = page.getByTestId("sign-out-error");

    // Offline: only the logout request fails at the network level. (Taking
    // the whole context offline would also cut Vite's HMR socket, whose
    // reconnect reloads the page.)
    await page.route("**/api/auth/logout", (r) =>
      r.abort("internetdisconnected"),
    );
    await signOut.click();
    await expect(failure.getByRole("alert")).toContainText(
      /check your connection/i,
    );
    await expect(page).toHaveURL(/\/more$/);
    expect((await page.request.get("/api/auth/session")).status()).toBe(200);

    // A server error is not a sign-out either (only 2xx or 401 count).
    await page.unroute("**/api/auth/logout");
    await page.route("**/api/auth/logout", (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "x-request-id": "0190a0a0-0000-7000-8000-00000000f051" },
        body: JSON.stringify({
          code: "UNAVAILABLE",
          message: "Unavailable.",
          requestId: "0190a0a0-0000-7000-8000-00000000f051",
        }),
      }),
    );
    await signOut.click();
    await expect(failure.getByRole("alert")).toContainText(
      /still signed in/i,
    );
    await expect(page).toHaveURL(/\/more$/);
    await expectAccessible(page, "sign-out error");

    // Back online: the same button retries and this time signs out for real.
    await page.unroute("**/api/auth/logout");
    await signOut.click();
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const replay = new ApiClient("old-cookie");
    replay.sessionToken = cookie!.value;
    const res = await replay.get("/auth/session");
    expect(res.status, "the old session cookie is dead on the server").toBe(
      401,
    );
  });

  test("nothing but the theme and the last budget ID is stored on the device (C3.4), through J2 quick-add too", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "storage" });
    const b = await createBudget(user, { name: "Stored household" });
    await signInAs(page, user.email);
    await page.goto(`/budgets/${b.id}`);
    await expect(page.getByTestId("total-remaining")).toBeVisible();

    // J2 with a payee, then a second sheet left open with unsaved input: the
    // draft lives in memory only (F-54, ADR-0002), never on the device.
    const sheet = page.getByTestId("quick-add-sheet");
    await quickAddOpener(page).click();
    await page.keyboard.type("12.34");
    await sheet.getByRole("button", { name: "Note" }).click();
    await sheet.getByLabel("Payee").fill("Corner bakery");
    await sheet.getByText("Groceries", { exact: true }).click();
    await page.getByTestId("quick-add-save").click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("total-remaining")).toHaveText("$687.66");

    await quickAddOpener(page).click();
    await page.keyboard.type("56.78");
    await sheet.getByRole("button", { name: "Note" }).click();
    await sheet.getByLabel("Payee").fill("Unsaved florist");
    await expectDeviceHoldsNoData(page, b.id, "with an unsaved quick-add draft");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await page.goto(`/budgets/${b.id}/transactions`);
    await expect(
      page.getByRole("heading", { name: "Transactions" }),
    ).toBeVisible();
    await expect(page.getByText("Corner bakery")).toBeVisible();
    await expectDeviceHoldsNoData(page, b.id, "after quick-add and the list");
  });
});

test.describe("emailed link tokens leave the URL at once (C3.6, F-06)", () => {
  test("a password-reset link: location.hash is empty and the token still works", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "forgetful" });
    expect(
      (
        await new ApiClient("anon").post("/auth/password-reset/request", {
          email: user.email,
        })
      ).status,
    ).toBe(202);
    const link = (await lastEmail(user.email, "password_reset")).links[0]!;
    await page.goto(link);
    expect(await page.evaluate(() => location.hash)).toBe("");
    await expect(page.getByLabel(/New password/)).toBeVisible();
    await expectAccessible(page, "reset password");
    expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);
    expect(page.url()).not.toContain("token");
  });

  test("an email-change undo link: location.hash is empty", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "mover" });
    const client = await testLogin(user.email);
    await client.post("/me/email-change", {
      newEmail: `moved-${user.userId.slice(0, 8)}@example.test`,
    });
    const link = (await lastEmail(user.email, "email_change_notice")).links[0]!;
    await page.goto(link);
    expect(await page.evaluate(() => location.hash)).toBe("");
    expect(page.url()).not.toContain("token");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

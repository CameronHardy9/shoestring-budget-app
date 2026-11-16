// Session hygiene on the device (ARCHITECTURE "No financial data on the device"):
//   C3.5 / F-32: sign-out clears in-memory state with a full location.replace,
//        and Back never shows signed-in data again (sign-out-back.ts; the
//        bfcache path is proven on csp-prod-chromium).
//   C3.4 (storage half): only the theme and the last budget ID are stored.
//   C3.6 / F-06: an emailed #token= link is out of the URL as soon as the page
//        has loaded.
import { createBudget, createUser } from "../support/factories.ts";
import { lastEmail, testLogin } from "../support/hooks.ts";
import { ApiClient } from "../support/http.ts";
import { expect, expectAccessible, signInAs, test } from "./fixtures.ts";
import { signOutThenBack } from "./sign-out-back.ts";

const ALLOWED_LOCAL_STORAGE = new Set([
  "shoestring.theme",
  "shoestring.lastBudgetId",
]);

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

  test("nothing but the theme and the last budget ID is stored on the device (C3.4)", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "storage" });
    const b = await createBudget(user, { name: "Stored household" });
    await signInAs(page, user.email);
    await page.goto(`/budgets/${b.id}`);
    await expect(page.getByTestId("total-remaining")).toBeVisible();
    await page.goto(`/budgets/${b.id}/transactions`);
    await expect(
      page.getByRole("heading", { name: "Transactions" }),
    ).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      idb:
        typeof indexedDB.databases === "function"
          ? (await indexedDB.databases()).map((d) => d.name)
          : [],
      caches: typeof caches === "undefined" ? [] : await caches.keys(),
      cookieVisibleToScript: document.cookie,
    }));
    for (const k of stored.local)
      expect(ALLOWED_LOCAL_STORAGE.has(k), `localStorage key ${k}`).toBe(true);
    expect(stored.session).toEqual([]);
    expect(stored.idb).toEqual([]);
    expect(stored.caches).toEqual([]);
    expect(stored.cookieVisibleToScript, "the session cookie is httpOnly").toBe(
      "",
    );
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

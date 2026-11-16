// C3.5 / F-32 scenario, shared by e2e/sessions.spec.ts (Vite dev server) and
// e2e/csp-prod/sign-out-back.spec.ts (production build): sign out, press Back
// to the budget document, and nothing signed-in may show again.
//
// Which path Back takes is recorded from `pageshow`, never assumed:
//   - restored from the back/forward cache (`persisted === true`): the page's
//     old JavaScript state comes back, and the app's pageshow handler must
//     clear it and re-check the session (frontend auth.tsx);
//   - a fresh load (`persisted === false`): the app boots signed out.
// Where bfcache is available in this setup:
//   - csp-prod-chromium: yes. That project runs full Chromium (new headless)
//     with Playwright's --disable-back-forward-cache removed. The default
//     headless shell never caches ("BackForwardCacheDisabledForDelegate").
//   - WebKit (iphone-webkit, csp-prod-webkit): never. Playwright's WebKit does
//     not restore pages from its page cache, headed or headless, even for a
//     plain two-page Back (verified 2026-11-16 with Playwright 1.65), so these
//     runs cover the fresh-load path only.
//   - pixel-chromium, desktop-chrome: never; they keep Playwright's default
//     --disable-back-forward-cache.
// The caller states the expected path, so a change in either direction fails
// the test instead of silently testing the other path.
import type { Page } from "@playwright/test";
import {
  createBudget,
  createTransaction,
  createUser,
} from "../support/factories.ts";
import { expect, signInAs } from "./fixtures.ts";

declare global {
  interface Window {
    __pageshow?: (v: { path: string; persisted: boolean }) => Promise<void>;
  }
}

export async function signOutThenBack(
  page: Page,
  expectBfcache: boolean,
): Promise<void> {
  const shows: { path: string; persisted: boolean }[] = [];
  await page.exposeBinding(
    "__pageshow",
    (_source, v: { path: string; persisted: boolean }) => {
      shows.push(v);
    },
  );
  await page.addInitScript(() => {
    addEventListener("pageshow", (e) => {
      window.__pageshow!({
        path: location.pathname,
        persisted: e.persisted,
      }).catch(() => undefined);
    });
  });

  const user = await createUser({ prefix: "leaver" });
  const b = await createBudget(user, { name: "Private household" });
  await createTransaction(b.scope, {
    date: b.record.today,
    categoryId: b.categories.Groceries!,
    amountCents: 4_321,
    payee: "Secret shop",
  });
  await signInAs(page, user.email);
  const budgetPath = `/budgets/${b.id}`;
  await page.goto(budgetPath);
  await expect(page.getByText("Secret shop")).toBeVisible();

  await page.goto("/more");
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // A bfcache restore fires no `load` event, so wait only for the commit.
  const before = shows.length;
  await page.goBack({ waitUntil: "commit" });
  await expect
    .poll(() => shows.slice(before).find((s) => s.path === budgetPath), {
      message: `pageshow for ${budgetPath} after Back`,
    })
    .toBeDefined();
  const restored = shows.slice(before).find((s) => s.path === budgetPath)!;
  expect(
    restored.persisted,
    expectBfcache
      ? "Back must restore the budget page from bfcache (pageshow.persisted), or the F-32 handler is not exercised"
      : "Back was expected to load the page afresh here (no bfcache in this browser setup; see e2e/sign-out-back.ts). " +
          "If bfcache now works, expect it on this project instead",
  ).toBe(expectBfcache);

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Secret shop")).toHaveCount(0);
  await expect(page.getByText("Private household")).toHaveCount(0);
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(401);
}

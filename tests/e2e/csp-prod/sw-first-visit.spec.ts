// Emailed links on a FIRST visit with the service worker running (auth.md §4,
// ADR-0002; the SW first-visit fix in frontend/src/app/sw-register.ts).
//
// The production build registers /sw.js after `load`; on a first visit the
// new worker's clients.claim() takes control of the open page and fires
// `controllerchange`. The app used to reload on every controllerchange, and
// the reload threw away the link token, which lives only in memory once the
// boot script has stripped the fragment: a reset or sign-up link opened from
// the email on a new phone then showed "request a new link" instead of the
// form. Now only an UPDATED worker's takeover reloads.
//
// These tests run the real worker (prod-server.mjs serves tests/.prod-build's
// sw.js with the backend's CSP, worker-src 'self'), in a fresh browser
// context, so the visit is the first one. They prove the takeover happened
// (`controllerchange` fired, the page is controlled) and that the same
// document, never reloaded, then completes the link's flow.
import type { Page } from "@playwright/test";
import { createUser, uniqueEmail } from "../../support/factories.ts";
import { randomPassword } from "../../support/passwords.ts";
import { lastEmail, signupInvite } from "../../support/hooks.ts";
import { ApiClient } from "../../support/http.ts";
import { expect, test } from "../fixtures.ts";

// Every other test blocks service workers (playwright.config.ts).
test.use({ serviceWorkers: "allow" });

interface FirstVisit {
  /** Full document loads of the page so far. */
  loads: () => number;
  timeOrigin: number;
}

/**
 * Opens an emailed link (its path and fragment, on the production build) in
 * this test's fresh context and records the worker's takeover.
 */
async function openLinkFirstVisit(
  page: Page,
  link: string,
): Promise<FirstVisit> {
  await page.addInitScript(() => {
    if (window !== window.top || !("serviceWorker" in navigator)) return;
    if (sessionStorage.getItem("e2e-controlled-at-start") === null)
      sessionStorage.setItem(
        "e2e-controlled-at-start",
        String(navigator.serviceWorker.controller !== null),
      );
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      const n = Number(sessionStorage.getItem("e2e-controllerchange") ?? "0");
      sessionStorage.setItem("e2e-controllerchange", String(n + 1));
    });
  });
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  const { pathname, hash } = new URL(link);
  await page.goto(pathname + hash);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("e2e-controlled-at-start"),
    ),
    "a first visit: no worker controlled the page when it opened",
  ).toBe("false");
  // The worker installs, activates and claims this page.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect
    .poll(
      () => page.evaluate(() => sessionStorage.getItem("e2e-controllerchange")),
      { message: "the new worker took control (controllerchange)" },
    )
    .toBe("1");
  return { loads: () => loads, timeOrigin };
}

/** The takeover did not reload: still the first and only document. */
async function expectSameDocument(
  page: Page,
  visit: FirstVisit,
): Promise<void> {
  expect(
    await page.evaluate(() => performance.timeOrigin),
    "the page was not reloaded after the takeover",
  ).toBe(visit.timeOrigin);
  expect(visit.loads(), "exactly one document load").toBe(1);
  expect(await page.evaluate(() => location.hash)).toBe("");
}

test("a password-reset link opened on a first visit still works after the service worker takes control", async ({
  page,
}) => {
  const user = await createUser({ prefix: "firstvisit" });
  expect(
    (
      await new ApiClient("anon").post("/auth/password-reset/request", {
        email: user.email,
      })
    ).status,
  ).toBe(202);
  const link = (await lastEmail(user.email, "password_reset")).links[0]!;

  const visit = await openLinkFirstVisit(page, link);
  await expectSameDocument(page, visit);
  // The token survived in memory: the form, not "request a new link".
  const newPassword = randomPassword();
  await page.getByLabel(/New password/).fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(
    page.getByRole("heading", { name: "Password changed" }),
  ).toBeVisible();
  await expectSameDocument(page, visit);

  const login = await new ApiClient("check").post("/auth/login", {
    email: user.email,
    password: newPassword,
  });
  expect(login.status, "the new password works").toBe(200);
});

test("a sign-up invite link opened on a first visit still works after the service worker takes control", async ({
  page,
}) => {
  const address = uniqueEmail("firstvisit");
  await signupInvite(address);
  const link = (await lastEmail(address, "signup_invite")).links[0]!;

  const visit = await openLinkFirstVisit(page, link);
  await expectSameDocument(page, visit);
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByText(address)).toBeVisible();
  await page.getByLabel("Your name").fill("Robin Firstvisit");
  await page.getByLabel("Password", { exact: true }).fill(randomPassword());
  await page.getByTestId("sign-up-submit").click();
  await expect(
    page.getByRole("heading", { name: "Set up your budget" }),
  ).toBeVisible();
  await expectSameDocument(page, visit);
});

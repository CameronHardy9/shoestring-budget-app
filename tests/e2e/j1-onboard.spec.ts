// J1 Onboard on a phone (ARCHITECTURE "Critical user journeys"): open the
// emailed sign-up invite → set name and password → create the first budget
// from starter categories with monthly amounts → land on the month overview.
// Acceptance: one POST /budgets creates budget, categories and this month's
// plan; works at 320 px; the budget timezone defaults to the device's; the
// invite token is removed from the URL before anything else runs (C3.6).
import type { Page } from "@playwright/test";
import { uniqueEmail } from "../support/factories.ts";
import { randomPassword } from "../support/passwords.ts";
import { lastEmail, signupInvite } from "../support/hooks.ts";
import { expect, expectAccessible, test } from "./fixtures.ts";

async function onboard(
  page: Page,
): Promise<{ address: string; budgetId: string }> {
  const address = uniqueEmail("newcomer");
  await signupInvite(address);
  const link = (await lastEmail(address, "signup_invite")).links[0]!;
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByText(address)).toBeVisible();
  // C3.6: the fragment token is out of the URL (memory only).
  expect(await page.evaluate(() => location.hash)).toBe("");
  await expectAccessible(page, "sign-up");

  await page.getByLabel("Your name").fill("Robin Newcomer");
  await page.getByLabel("Password", { exact: true }).fill(randomPassword());
  await page.getByTestId("sign-up-submit").click();

  await expect(
    page.getByRole("heading", { name: "Set up your budget" }),
  ).toBeVisible();
  await expectAccessible(page, "create budget");
  await page.getByLabel("Budget name").fill("Our home");
  await page.getByLabel("Monthly limit for Groceries").fill("400");
  await page.getByLabel("Monthly limit for Dining out").fill("150.50");
  await page.getByLabel("Monthly expected for Salary").fill("3000");
  await page.getByTestId("create-budget").click();

  await expect(page).toHaveURL(/\/budgets\/[0-9a-f-]{36}$/);
  const budgetId = /\/budgets\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId("total-remaining")).toHaveText("$550.50");
  await expectAccessible(page, "overview after onboarding");
  return { address, budgetId };
}

test.describe("J1 onboard", () => {
  test("invite link → account → first budget with limits → overview", async ({
    page,
  }) => {
    const { budgetId } = await onboard(page);
    // One atomic create: the categories and this month's plan exist.
    const budget = await page.request.get(`/api/budgets/${budgetId}`);
    const b = (await budget.json()) as {
      timezone: string;
      currentMonth: string;
      name: string;
    };
    expect(b).toMatchObject({ name: "Our home", timezone: "America/New_York" });
    const plan = (await (
      await page.request.get(
        `/api/budgets/${budgetId}/months/${b.currentMonth}/plan`,
      )
    ).json()) as { items: unknown[] };
    expect(plan.items).toHaveLength(3);
  });

  test.describe("on a 320 px wide phone, in another timezone", () => {
    // A phone-width check: run it on the iPhone project only (desktop and
    // Pixel would just repeat it at the same forced viewport).
    test.skip(({ browserName }) => browserName !== "webkit", "phone-width check runs on the iPhone project");
    test.use({
      viewport: { width: 320, height: 640 },
      timezoneId: "America/Los_Angeles",
    });

    test("fits without horizontal scrolling, and the budget takes the device's timezone", async ({
      page,
    }) => {
      const { budgetId } = await onboard(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(320);
      const b = (await (
        await page.request.get(`/api/budgets/${budgetId}`)
      ).json()) as { timezone: string };
      expect(b.timezone).toBe("America/Los_Angeles");
    });
  });
});

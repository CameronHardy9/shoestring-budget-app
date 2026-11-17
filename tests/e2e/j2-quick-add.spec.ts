// J2 Quick-add (ARCHITECTURE "Great": 3 taps, under 10 s, one-handed):
// "+" → type the amount (keypad already up) → tap a category → Save.
// Acceptance: the amount field opens the numeric keypad; the date defaults to
// today in the budget timezone; splits must sum, with "left to assign".
import type { Page } from "@playwright/test";
import { createBudget, createUser } from "../support/factories.ts";
import type { TestBudget } from "../support/factories.ts";
import {
  expect,
  expectAccessible,
  quickAddOpener,
  signInAs,
  test,
} from "./fixtures.ts";

interface Tx {
  date: string;
  amountCents: number;
  direction: string;
  splits: { categoryId: string; amountCents: number }[];
}

async function openBudget(page: Page): Promise<TestBudget> {
  const user = await createUser({ prefix: "quick" });
  const budget = await createBudget(user, { name: "Quick household" }); // Groceries 500, Dining 200, Salary 4000
  await signInAs(page, user.email);
  await page.goto(`/budgets/${budget.id}`);
  await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
  return budget;
}

async function transactions(page: Page, budgetId: string): Promise<Tx[]> {
  return (
    (await (
      await page.request.get(`/api/budgets/${budgetId}/transactions`)
    ).json()) as { items: Tx[] }
  ).items;
}

test.describe("J2 quick-add", () => {
  test("adds a transaction in 3 taps and under 10 seconds; totals update", async ({
    page,
    taps,
  }) => {
    const budget = await openBudget(page);
    const started = performance.now();

    await taps.tap(quickAddOpener(page)); // tap 1
    const sheet = page.getByTestId("quick-add-sheet");
    await expect(sheet).toBeVisible();
    const amount = page.getByTestId("quick-add-amount");
    await expect(
      amount,
      "the amount field is focused, so the keypad is already up",
    ).toBeFocused();
    await expect(amount).toHaveAttribute("inputmode", "decimal");
    await page.keyboard.type("12.34");
    await taps.tap(sheet.getByText("Groceries", { exact: true })); // tap 2
    await taps.tap(page.getByTestId("quick-add-save")); // tap 3

    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("total-remaining")).toHaveText("$687.66");
    expect(taps.count).toBe(3);
    expect(performance.now() - started).toBeLessThan(10_000);

    const [tx] = await transactions(page, budget.id);
    expect(tx).toMatchObject({
      date: budget.record.today,
      amountCents: 1_234,
      direction: "outflow",
    });
    expect(tx!.splits).toEqual([
      { categoryId: budget.categories.Groceries, amountCents: 1_234 },
    ]);
  });

  test("the sheet passes axe, and Save without a category keeps the input and says what is missing", async ({
    page,
  }) => {
    await openBudget(page);
    await quickAddOpener(page).click();
    await page.keyboard.type("5");
    await expectAccessible(page, "quick-add sheet");
    await page.getByTestId("quick-add-save").click();
    await expect(page.getByTestId("quick-add-sheet")).toBeVisible();
    await expect(page.getByTestId("quick-add-amount")).toHaveValue("5");
    expect(
      await transactions(
        page,
        (/budgets\/([0-9a-f-]{36})/.exec(page.url()) ?? [])[1]!,
      ),
    ).toEqual([]);
  });

  test("a split shows what is left to assign and saves only when it adds up", async ({
    page,
  }) => {
    const budget = await openBudget(page);
    await quickAddOpener(page).click();
    const sheet = page.getByTestId("quick-add-sheet");
    await page.keyboard.type("30");
    await sheet.getByText("Groceries", { exact: true }).click();
    await sheet.getByRole("button", { name: "Split" }).click();
    const editor = page.getByTestId("split-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Amount 1, Groceries").fill("20");
    await editor.getByLabel("Category 2").selectOption({ label: "Dining" });
    await expect(page.getByTestId("split-left-to-assign")).toContainText(
      "$10.00 left to assign",
    );
    await expectAccessible(page, "split editor");
    await editor
      .getByRole("button", { name: "Put the rest on Dining" })
      .click();
    await expect(page.getByTestId("split-left-to-assign")).toContainText(
      "Fully assigned",
    );
    await page.getByTestId("quick-add-save").click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("total-remaining")).toHaveText("$670.00");
    const [tx] = await transactions(page, budget.id);
    expect(tx!.splits).toEqual([
      { categoryId: budget.categories.Groceries, amountCents: 2_000 },
      { categoryId: budget.categories.Dining, amountCents: 1_000 },
    ]);
  });

  test("+ tapped while the budget is still loading opens the sheet at once: the amount takes typing, the categories follow", async ({
    page,
    taps,
  }) => {
    const user = await createUser({ prefix: "eager" });
    const budget = await createBudget(user, { name: "Eager household" }); // Groceries 500, Dining 200
    await signInAs(page, user.email);

    // Hold GET /api/budgets/{id} (only that resource, not its sub-resources)
    // until the test releases it, so the tap lands while the budget loads.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(
      (url) => url.pathname === `/api/budgets/${budget.id}`,
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        held += 1;
        await gate;
        await route.fallback();
      },
    );
    const sheet = page.getByTestId("quick-add-sheet");
    const loadingCategories = sheet
      .getByRole("status")
      .filter({ hasText: "Loading categories…" });
    try {
      await page.goto(`/budgets/${budget.id}`);
      await taps.tap(quickAddOpener(page)); // tap 1, right after navigation
      await expect(sheet).toBeVisible();
      const amount = page.getByTestId("quick-add-amount");
      await expect(amount, "the amount is focused at once").toBeFocused();
      await page.keyboard.type("9.50");
      await expect(amount).toHaveValue("9.50");
      await expect(loadingCategories).toBeVisible();
      await expect(sheet.getByText("Groceries", { exact: true })).toHaveCount(
        0,
      );
      expect(held, "the budget request was still held during all this").toBe(
        1,
      );
      await expect(page.getByTestId("total-remaining")).toHaveCount(0);
    } finally {
      release();
    }

    const groceries = sheet.getByText("Groceries", { exact: true });
    await expect(groceries).toBeVisible();
    await expect(loadingCategories).toHaveCount(0);
    await expect(page.getByTestId("quick-add-amount")).toHaveValue("9.50");
    await taps.tap(groceries); // tap 2
    await taps.tap(page.getByTestId("quick-add-save")); // tap 3
    await expect(sheet).toBeHidden();
    expect(taps.count).toBe(3);

    await expect(page.getByTestId("total-remaining")).toHaveText("$690.50");
    const [tx] = await transactions(page, budget.id);
    expect(tx).toMatchObject({
      date: budget.record.today,
      amountCents: 950,
      direction: "outflow",
    });
    expect(tx!.splits).toEqual([
      { categoryId: budget.categories.Groceries, amountCents: 950 },
    ]);
  });
});

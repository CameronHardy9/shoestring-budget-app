// J3 "How am I doing this month?" and J5 "Copy last month's plan".
// J3 acceptance: numbers come only from GET …/summary; a refund reduces spent;
// overspending is visible without relying on colour; months follow the
// budget's calendar dates. J5: copy-previous fills only empty categories;
// archived categories are skipped.
import {
  archiveCategory,
  createBudget,
  createTransaction,
  createUser,
} from "../support/factories.ts";
import { expect, expectAccessible, signInAs, test } from "./fixtures.ts";

test.describe("J3 month status", () => {
  test("planned, spent and remaining per category and in total; refunds reduce spent; overspending is said in words", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "status" });
    const b = await createBudget(user, { name: "Status household" }); // Groceries 500, Dining 200, Salary 4000 (income)
    const c = b.categories;
    await createTransaction(b.scope, {
      date: "2026-11-02",
      categoryId: c.Groceries!,
      amountCents: 30_000,
      payee: "Market",
    });
    await createTransaction(b.scope, {
      date: "2026-11-03",
      categoryId: c.Groceries!,
      amountCents: 4_500,
      direction: "inflow",
      payee: "Market refund",
    });
    await createTransaction(b.scope, {
      date: "2026-11-04",
      categoryId: c.Dining!,
      amountCents: 25_000,
      payee: "Bistro",
    });
    await createTransaction(b.scope, {
      date: "2026-10-31",
      categoryId: c.Groceries!,
      amountCents: 99_900,
      payee: "Last month",
    });
    await signInAs(page, user.email);
    await page.goto(`/budgets/${b.id}`);

    // 700.00 planned − (300.00 − 45.00 + 250.00) spent = 195.00 left.
    await expect(page.getByTestId("total-remaining")).toHaveText("$195.00");
    await expect(
      page.getByText("$505.00 spent of $700.00 planned"),
    ).toBeVisible();
    await expect(page.getByText("1 category over")).toBeVisible();
    const chart = page.getByTestId("category-chart");
    await expect(chart.getByText("Over by $50.00")).toBeVisible();
    await expect(chart.getByText("$245.00 left")).toBeVisible();
    await expectAccessible(page, "overview (chart)");

    await page.getByText("Table", { exact: true }).click();
    const table = page.getByTestId("category-table");
    await expect(table.getByRole("row", { name: /Dining/ })).toContainText(
      "(over)",
    );
    await expect(table.getByRole("row", { name: /Groceries/ })).toContainText(
      "$255.00",
    );
    await expectAccessible(page, "overview (table)");

    // October is its own month: only the Oct 31 transaction.
    await page.getByRole("link", { name: /^Previous month/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("October");
    await expect(
      page.getByText("$999.00 spent of $0.00 planned"),
    ).toBeVisible();
  });
});

test.describe("J5 copy last month", () => {
  test("next month starts empty; copying fills the limits but skips archived categories", async ({
    page,
  }) => {
    const user = await createUser({ prefix: "copier" });
    const b = await createBudget(user, { name: "Copy household" });
    await archiveCategory(b.scope, b.categories.Dining!);
    await signInAs(page, user.email);
    await page.goto(`/budgets/${b.id}/categories?month=2026-12`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const groceries = page
      .getByTestId("category-row")
      .filter({ hasText: "Groceries" });
    await expect(groceries).toContainText("No limit");
    await expectAccessible(page, "categories and limits");

    await page.getByTestId("copy-previous").click();
    await expect(groceries).toContainText("$500.00");
    await expect(
      page.getByTestId("category-row").filter({ hasText: "Salary" }),
    ).toContainText("$4,000.00");
    // Archived Dining was not copied (and is not in the active list).
    await expect(
      page.getByTestId("category-row").filter({ hasText: "Dining" }),
    ).toHaveCount(0);

    // Adjust one limit for December only.
    await groceries.click();
    const sheet = page.getByTestId("category-sheet");
    await sheet.getByTestId("category-limit").fill("450");
    await sheet.getByTestId("category-save").click();
    await expect(groceries).toContainText("$450.00");
    const dec = (await (
      await page.request.get(`/api/budgets/${b.id}/months/2026-12/plan`)
    ).json()) as { items: { categoryId: string; amountCents: number }[] };
    expect(
      dec.items.find((i) => i.categoryId === b.categories.Groceries)
        ?.amountCents,
    ).toBe(45_000);
    const nov = (await (
      await page.request.get(`/api/budgets/${b.id}/months/2026-11/plan`)
    ).json()) as { items: { categoryId: string; amountCents: number }[] };
    expect(
      nov.items.find((i) => i.categoryId === b.categories.Groceries)
        ?.amountCents,
    ).toBe(50_000);
  });
});

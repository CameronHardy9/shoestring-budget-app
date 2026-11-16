// J4 Review and fix: the month's transactions grouped by day, filter by
// category, edit (including splits) and delete. Acceptance: cursor paging;
// an edit conflict shows VERSION_CONFLICT and never overwrites silently;
// deletes update the totals at once.
import {
  createBudget,
  createTransaction,
  createUser,
} from "../support/factories.ts";
import type { TestBudget } from "../support/factories.ts";
import { dal } from "../support/dal.ts";
import { expect, expectAccessible, signInAs, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function seeded(page: Page, n: number): Promise<TestBudget> {
  const user = await createUser({ prefix: "reviewer" });
  const b = await createBudget(user, { name: "Review household" });
  for (let i = 0; i < n; i++)
    await createTransaction(b.scope, {
      date: `2026-11-${String(1 + (i % 15)).padStart(2, "0")}`,
      categoryId: i % 3 === 0 ? b.categories.Dining! : b.categories.Groceries!,
      amountCents: 100 * (i + 1),
      payee: `Shop ${String(i + 1).padStart(2, "0")}`,
    });
  await signInAs(page, user.email);
  return b;
}

test.describe("J4 review and fix", () => {
  test("grouped by day, paged with Load more, filtered by category", async ({
    page,
  }) => {
    const b = await seeded(page, 60);
    await page.goto(`/budgets/${b.id}/transactions`);
    const rows = page.getByTestId("transaction-row");
    await expect(rows).toHaveCount(50);
    await expect(page.getByRole("heading", { name: /Nov 15/ })).toBeVisible();
    await expectAccessible(page, "transactions");
    await page.getByTestId("load-more").click();
    await expect(rows).toHaveCount(60);
    await expect(page.getByText("60 transactions")).toBeVisible();

    await page.getByTestId("category-filter").selectOption({ label: "Dining" });
    await expect(rows).toHaveCount(20);
    await expect(page).toHaveURL(/category=/);
  });

  test("edit a transaction into a split, then delete it; the overview follows", async ({
    page,
  }) => {
    const b = await seeded(page, 1); // Shop 01: Dining 1.00
    await page.goto(`/budgets/${b.id}/transactions`);
    await page.getByTestId("transaction-row").first().click();
    const sheet = page.getByTestId("quick-add-sheet");
    await expect(
      sheet.getByRole("heading", { name: "Edit transaction" }),
    ).toBeVisible();
    await page.getByTestId("quick-add-amount").fill("40");
    await sheet.getByRole("button", { name: "Split" }).click();
    const editor = page.getByTestId("split-editor");
    await editor.getByLabel("Amount 1, Dining").fill("25");
    await editor.getByLabel("Category 2").selectOption({ label: "Groceries" });
    await editor
      .getByRole("button", { name: "Put the rest on Groceries" })
      .click();
    await page.getByTestId("quick-add-save").click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("transaction-row").first()).toContainText(
      "$40.00",
    );

    await page.goto(`/budgets/${b.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveText("$660.00");

    await page.goto(`/budgets/${b.id}/transactions`);
    await page.getByTestId("transaction-row").first().click();
    await page.getByTestId("delete-transaction").click();
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("transaction-row")).toHaveCount(0);
    await page.goto(`/budgets/${b.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");
  });

  test("an edit that raced another member's edit shows the conflict and does not overwrite it", async ({
    page,
  }) => {
    const b = await seeded(page, 1);
    await page.goto(`/budgets/${b.id}/transactions`);
    await page.getByTestId("transaction-row").first().click();
    await expect(page.getByTestId("quick-add-sheet")).toBeVisible();

    // Meanwhile someone else changes it (version 1 → 2).
    const [tx] = (
      await dal().transactions.listTransactions(b.scope, { limit: 1 })
    ).items;
    await dal().transactions.replaceTransaction(b.scope, tx!.id, {
      date: tx!.date,
      direction: "outflow",
      amountCents: 7_700,
      payee: "Their edit",
      memo: null,
      splits: [{ categoryId: b.categories.Dining!, amountCents: 7_700 }],
      version: tx!.version,
    });

    await page.getByTestId("quick-add-amount").fill("9");
    await page.getByTestId("quick-add-save").click();
    await expect(page.getByTestId("conflict")).toBeVisible();
    await expectAccessible(page, "edit conflict");
    const after = await dal().transactions.getTransaction(b.scope, tx!.id);
    expect(after).toMatchObject({
      amountCents: 7_700,
      payee: "Their edit",
      version: 2,
    });
  });
});

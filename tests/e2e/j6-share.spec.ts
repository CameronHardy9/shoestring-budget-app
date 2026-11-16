// J6 Invite a partner: the owner invites by email (re-auth) → the partner,
// who signed up through an owner-created sign-up invite, sees and accepts it →
// both see the same budget and each other's transactions. Also: the owner
// transfers ownership, deletes the budget and undoes the deletion; members are
// emailed on deletion and restore.
import { randomUUID } from "node:crypto";
import type { Browser, Page, TestInfo } from "@playwright/test";
import {
  addMember,
  createBudget,
  createUser,
  uniqueEmail,
} from "../support/factories.ts";
import type { TestBudget } from "../support/factories.ts";
import {
  advanceClock,
  emails,
  lastEmail,
  MINUTE,
  signupInvite,
} from "../support/hooks.ts";
import {
  expect,
  expectAccessible,
  quickAddOpener,
  signInAs,
  test,
} from "./fixtures.ts";

/** A second person on their own device, with this project's device settings. */
async function secondDevice(
  browser: Browser,
  testInfo: TestInfo,
): Promise<Page> {
  // Device and locale options of this project; not a context option itself.
  const options = { ...(testInfo.project.use as Record<string, unknown>) };
  delete options.defaultBrowserType;
  const context = await browser.newContext(options);
  return context.newPage();
}

async function quickAdd(
  page: Page,
  amount: string,
  category: string,
): Promise<void> {
  await quickAddOpener(page).click();
  const sheet = page.getByTestId("quick-add-sheet");
  await expect(sheet).toBeVisible();
  await page.keyboard.type(amount);
  await sheet.getByText(category, { exact: true }).click();
  await page.getByTestId("quick-add-save").click();
  await expect(sheet).toBeHidden();
}

test.describe("J6 share a budget", () => {
  test("invite (with re-auth) → partner signs up and accepts → both see each other's transactions", async ({
    page,
    browser,
  }, testInfo) => {
    const owner = await createUser({
      prefix: "owner",
      displayName: "Alex Owner",
    });
    const budget: TestBudget = await createBudget(owner, { name: "Our flat" });
    await signInAs(page, owner.email);
    // The sign-in's re-auth window has closed, so inviting asks to confirm.
    await advanceClock(11 * MINUTE);

    const partnerEmail = uniqueEmail("partner");
    await page.goto(`/budgets/${budget.id}/members`);
    await expect(
      page.getByRole("heading", { name: "Members & settings" }),
    ).toBeVisible();
    await expectAccessible(page, "members (owner)");
    await page.getByLabel("Invite by email").fill(partnerEmail);
    await page.getByTestId("send-invitation").click();
    const reauth = page.getByTestId("reauth-dialog");
    await expect(reauth).toBeVisible();
    await expectAccessible(page, "re-auth dialog");
    await reauth.getByLabel("Password").fill(owner.password);
    await reauth.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Invitation sent");
    await expect(page.getByText(partnerEmail)).toBeVisible();

    // The partner gets a sign-up invite from the app's owner, signs up, finds the invitation.
    const partner = await secondDevice(browser, testInfo);
    await signupInvite(partnerEmail);
    await partner.goto(
      (await lastEmail(partnerEmail, "signup_invite")).links[0]!,
    );
    await partner.getByLabel("Your name").fill("Sam Partner");
    await partner
      .getByLabel("Password", { exact: true })
      .fill(`pw-${randomUUID()}`);
    await partner.getByTestId("sign-up-submit").click();
    await expect(
      partner.getByRole("heading", { name: "Set up your budget" }),
    ).toBeVisible();
    await partner.goto("/invitations");
    const mine = partner.getByTestId("my-invitations");
    await expect(mine).toContainText("Our flat");
    await expectAccessible(partner, "my invitations");
    await partner
      .getByRole("button", { name: "Accept invitation to Our flat" })
      .click();
    await expect(partner).toHaveURL(new RegExp(`/budgets/${budget.id}$`));
    expect((await emails(owner.email)).map((e) => e.kind)).toContain(
      "invitation_accepted",
    );

    // Each adds a transaction; each sees the other's.
    await page.goto(`/budgets/${budget.id}`);
    await quickAdd(page, "20", "Groceries");
    await quickAdd(partner, "5", "Dining");
    for (const p of [page, partner]) {
      await p.goto(`/budgets/${budget.id}/transactions`);
      await expect(p.getByTestId("transaction-row")).toHaveCount(2);
      await p.goto(`/budgets/${budget.id}`);
      await expect(p.getByTestId("total-remaining")).toHaveText("$675.00");
    }
    await partner.context().close();
  });

  test("the owner transfers ownership; the new owner deletes the budget and restores it", async ({
    page,
    browser,
  }, testInfo) => {
    const owner = await createUser({
      prefix: "owner",
      displayName: "Alex Owner",
    });
    const member = await createUser({
      prefix: "member",
      displayName: "Sam Member",
    });
    const budget = await createBudget(owner, { name: "Our flat" });
    await addMember(budget, member);

    await signInAs(page, owner.email);
    await page.goto(`/budgets/${budget.id}/members`);
    const list = page.getByTestId("member-list");
    await expect(list).toContainText("Sam Member");
    await list.getByRole("button", { name: "Make owner" }).click();
    await page.getByTestId("confirm-action").click();
    await expect(page.getByTestId("toasts")).toContainText(
      "Sam Member is now the owner",
    );
    await expect(page.getByTestId("leave-budget")).toBeVisible();
    expect((await emails(member.email)).map((e) => e.kind)).toContain(
      "ownership_transferred",
    );

    const newOwner = await secondDevice(browser, testInfo);
    await signInAs(newOwner, member.email);
    await newOwner.goto(`/budgets/${budget.id}/members`);
    await newOwner.getByTestId("delete-budget").click();
    await expect(newOwner.getByTestId("confirm-dialog")).toBeVisible();
    await expectAccessible(newOwner, "delete confirmation");
    await newOwner.getByTestId("confirm-action").click();
    await expect(newOwner.getByTestId("toasts")).toContainText(
      "Our flat deleted",
    );
    expect((await emails(owner.email)).map((e) => e.kind)).toContain(
      "budget_deleted",
    );

    // The former owner (now a member) has lost access at once.
    await page.goto(`/budgets/${budget.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveCount(0);

    await newOwner.goto("/settings/deleted-budgets");
    await expect(newOwner.getByTestId("deleted-budgets")).toContainText(
      "Our flat",
    );
    await newOwner.getByRole("button", { name: "Restore Our flat" }).click();
    await expect(newOwner).toHaveURL(new RegExp(`/budgets/${budget.id}$`));
    expect((await emails(owner.email)).map((e) => e.kind)).toContain(
      "budget_restored",
    );
    await page.goto(`/budgets/${budget.id}`);
    await expect(page.getByTestId("total-remaining")).toBeVisible();
    await newOwner.context().close();
  });
});

// No phone screen scrolls sideways, whatever the person typed. Names and
// payees are at the contract's limits (api.openapi.yaml), unbroken where the
// API allows it, and the amounts at its maximum. In Chromium a page that is too
// wide also grows the layout viewport (innerWidth), which pushes the tab bar
// below the visible screen so a tap on + misses (found 2026-11-25).
//
// One data set and one test. Measurements are soft assertions: one red run lists
// every screen and width that is wrong, each with the element that sticks out
// furthest.
//
// Known, accepted, and NOT asserted here (fix/long-category-names, 2026-11-25):
//   - an unbroken 40-character word in the quick-add chips, and in "Put the
//     rest on <name>", scrolls inside the sheet (not the page);
//   - "Automatic" in the theme switch (More) spills 2 px out of its segment at
//     320 px (inside the card);
//   - large text (150-200 %).
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { uniqueEmail } from "../support/factories.ts";
import { signupInvite } from "../support/hooks.ts";
import { ApiClient } from "../support/http.ts";
import type { ApiResponse } from "../support/http.ts";
import { randomPassword } from "../support/passwords.ts";
import { enrollPasskey } from "../support/webauthn.ts";
import { expect, quickAddOpener, signInAs, test } from "./fixtures.ts";

const SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 430, height: 932 },
];

// Contract limits (api.openapi.yaml): category 40, budget 60, display name 50,
// payee 100, passkey 40, email 254, amount 100,000,000 cents.
const LONG = "Home repairs, garden and maintenance"; // ordinary words, 36
const EMPTY = "W".repeat(40); // one word, no transactions
const OVER = "M".repeat(40); // one word, over by the largest amount
const BUDGET = "B".repeat(60);
const OWNER = "D".repeat(50);
const MEMBER = "Maximiliana Wilhelmina Featherstonehaugh-Worthing!"; // 50
const PAYEE = "P".repeat(100);
const PASSKEY = "K".repeat(40);
const MAX_CENTS = 100_000_000;
/** 254 characters, on the reserved example.test domain. */
const longEmail = (letter: string): string =>
  `${letter.repeat(64)}@${[63, 63, 48].map((n) => letter.repeat(n)).join(".")}.example.test`;

function ok<T>(res: ApiResponse<T>, status: number): T {
  expect(res.status, res.describe).toBe(status);
  return res.body;
}

async function signUp(email: string, displayName: string): Promise<ApiClient> {
  const api = new ApiClient(displayName.slice(0, 8));
  ok(
    await api.post("/auth/signup", {
      token: await signupInvite(email),
      displayName,
      password: randomPassword(),
    }),
    201,
  );
  return api;
}

async function newBudget(api: ApiClient, body: object): Promise<string> {
  return ok(
    await api.post<{ id: string }>(
      "/budgets",
      { timezone: "America/New_York", ...body },
      { idempotencyKey: randomUUID() },
    ),
    201,
  ).id;
}

/** The whole data set, through the API only. Returns the budget and its IDs. */
async function household(
  page: Page,
): Promise<{ id: string; category: (name: string) => string }> {
  const email = longEmail("o");
  const memberEmail = uniqueEmail("partner");
  const [owner, member] = await Promise.all([
    signUp(email, OWNER),
    signUp(memberEmail, MEMBER),
  ]);
  const id = await newBudget(owner, {
    name: BUDGET,
    categories: [
      { name: LONG, kind: "expense", plannedCents: 60_000 },
      { name: EMPTY, kind: "expense", plannedCents: MAX_CENTS },
      { name: OVER, kind: "expense", plannedCents: 0 },
      { name: "Groceries", kind: "expense", plannedCents: 50_000 },
      { name: "Dining out", kind: "expense", plannedCents: 20_000 },
      { name: "Transport", kind: "expense", plannedCents: 12_000 },
      { name: "Salary", kind: "income", plannedCents: MAX_CENTS },
    ],
  });
  const { items } = ok(
    await owner.get<{ items: { id: string; name: string }[] }>(
      `/budgets/${id}/categories`,
    ),
    200,
  );
  const category = (name: string): string =>
    items.find((c) => c.name === name)!.id;
  const add = async (
    date: string,
    direction: "outflow" | "inflow",
    payee: string | null,
    splits: Record<string, number>,
  ): Promise<void> => {
    ok(
      await owner.post(
        `/budgets/${id}/transactions`,
        {
          date,
          direction,
          payee,
          amountCents: Object.values(splits).reduce((a, b) => a + b, 0),
          splits: Object.entries(splits).map(([name, amountCents]) => ({
            categoryId: category(name),
            amountCents,
          })),
        },
        { idempotencyKey: randomUUID() },
      ),
      201,
    );
  };
  await add("2026-11-16", "outflow", "Corner market", {
    Groceries: 4_500,
    "Dining out": 2_500,
    Transport: 1_250,
  });
  await add("2026-11-15", "inflow", `${"Refund ".repeat(14)}!!`, {
    [LONG]: 2_000,
  });
  await add("2026-11-14", "outflow", PAYEE, { [LONG]: 12_345 });
  await add("2026-11-13", "outflow", null, { [OVER]: MAX_CENTS });

  // A member, a pending invitation to the longest address, and one invitation
  // per width for the owner, to three other budgets (createBudgetInvitation
  // answers after a fixed second, so all at once).
  const invite = async (
    from: ApiClient,
    budgetId: string,
    to: string,
  ): Promise<string> =>
    ok(
      await from.post<{ id: string }>(`/budgets/${budgetId}/invitations`, {
        email: to,
      }),
      201,
    ).id;
  const shared: string[] = [];
  for (const letter of ["X", "Y", "Z"])
    shared.push(await newBudget(member, { name: letter.repeat(60) }));
  const [joined] = await Promise.all([
    invite(owner, id, memberEmail),
    invite(owner, id, longEmail("i")),
    ...shared.map((b) => invite(member, b, email)),
  ]);
  ok(await member.post(`/me/invitations/${joined}/accept`), 200);
  await enrollPasskey(owner, PASSKEY);
  await signInAs(page, email);
  return { id, category };
}

const OWNER_OF_FAILURE = "(owner: frontend-engineer)";

/** Measures the page exactly as it is now. Soft: the test goes on. */
async function measure(
  page: Page,
  screen: string,
  width: number,
): Promise<void> {
  // A resize reaches the page asynchronously. A page that is too wide never
  // gets there in Chromium (its layout viewport stays wider): reported below.
  await page
    .waitForFunction((w) => window.innerWidth === w, width, { timeout: 2_000 })
    .catch(() => undefined);
  const m = await page.evaluate((w) => {
    const root = document.documentElement;
    // Content inside a box that scrolls or clips doesn't widen the page, and
    // fixed elements are as wide as the viewport: an effect, not the cause.
    const harmless = (el: Element): boolean => {
      if (getComputedStyle(el).position === "fixed") return true;
      for (
        let e = el.parentElement;
        e && e !== document.body;
        e = e.parentElement
      ) {
        const style = getComputedStyle(e);
        if (style.overflowX !== "visible" || style.position === "fixed")
          return true;
      }
      return false;
    };
    let worst: { el: Element; right: number } | null = null;
    for (const el of document.body.querySelectorAll("*")) {
      const right = el.getBoundingClientRect().right + window.scrollX;
      // >=: of equally wide ones the innermost, which comes last.
      if (right <= w + 0.5 || right < (worst?.right ?? 0)) continue;
      if (el.checkVisibility() && !harmless(el)) worst = { el, right };
    }
    return {
      inner: window.innerWidth,
      scroll: root.scrollWidth,
      client: root.clientWidth,
      worst: worst
        ? `<${worst.el.tagName.toLowerCase()}> "${worst.el.textContent.slice(0, 60)}" ends at ${Math.round(worst.right)} px`
        : "nothing found",
    };
  }, width);
  const wrong = [
    m.scroll > m.client
      ? `scrolls sideways (scrollWidth ${m.scroll} > clientWidth ${m.client})`
      : null,
    m.inner === width ? null : `innerWidth is ${m.inner}, not ${width}`,
  ].filter((x) => x !== null);
  expect
    .soft(
      wrong.length === 0,
      `${screen} at ${width} px: ${wrong.join(", ")}; furthest out: ${m.worst} ${OWNER_OF_FAILURE}`,
    )
    .toBe(true);
}

/** Measures the page once it has nothing left to load. */
async function check(page: Page, screen: string, width: number): Promise<void> {
  await expect(page.getByTestId("loading")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await measure(page, screen, width);
}

/** A real tap on + opens the sheet (soft), and the page stays as wide as the screen. */
async function expectAddOpens(
  page: Page,
  screen: string,
  width: number,
): Promise<void> {
  const sheet = page.getByTestId("quick-add-sheet");
  const opened = await quickAddOpener(page)
    .tap({ timeout: 5_000 })
    .then(() => expect(sheet).toBeVisible({ timeout: 5_000 }))
    .then(() => true)
    .catch(() => false);
  expect
    .soft(
      opened,
      `${screen} at ${width} px: a tap on + opens the quick-add sheet ${OWNER_OF_FAILURE}`,
    )
    .toBe(true);
  if (!opened) return;
  await check(page, `quick-add sheet over ${screen}`, width);
  await sheet.getByRole("button", { name: "Close" }).tap();
  await expect(sheet).toBeHidden();
}

/** The screen on show, at every width. */
async function checkAll(page: Page, screen: string): Promise<void> {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await check(page, screen, size.width);
  }
}

test.describe("long names and large amounts", () => {
  test("no phone screen scrolls sideways at 320, 375 or 430 px, and + on Overview opens the sheet", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "the phone layouts and their touch viewport");
    test.setTimeout(120_000);
    const b = await household(page);
    const base = `/budgets/${b.id}`;
    const heading = (name: string) =>
      expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    for (const size of SIZES) {
      const { width } = size;
      await page.setViewportSize(size);

      // Loaded at this width, so that the first layout decides the viewport.
      await page.goto(base);
      await expect(page.getByTestId("total-remaining")).toBeVisible();
      await expect(page.getByTestId("transaction-row")).toHaveCount(4);
      await expect(page.getByTestId("category-chart")).toContainText(
        "Over by $1,000,000.00",
      );
      await check(page, "Overview chart", width);

      await expectAddOpens(page, "Overview chart", width);

      await page.goto("/invitations");
      const invitations = page
        .getByTestId("my-invitations")
        .getByRole("listitem");
      await expect(invitations.first()).toBeVisible();
      await check(page, "Invitations", width);
      await invitations
        .first()
        .getByRole("button", { name: /^Accept/ })
        .tap();
      const toast = page
        .getByTestId("toasts")
        .getByText(/^You joined [XYZ]{60}$/);
      await expect(toast).toBeVisible();
      await measure(page, "toast", width); // at once: it leaves after 4 s
      // Still there: otherwise the measurement missed it.
      await expect(toast).toBeVisible({ timeout: 1 });
      // Let the joined budget's Overview load before leaving it: WebKit rejects
      // a lazy screen's import cut off by a navigation, an uncaught page error.
      await expect(page).toHaveURL(/\/budgets\//);
      await expect(page.getByTestId("total-remaining")).toBeVisible();
      await expect(page.getByTestId("loading")).toHaveCount(0);
    }

    await page.goto(base);
    await page.getByText("Table", { exact: true }).tap({ timeout: 5_000 });
    await expect(page.getByTestId("category-table")).toContainText(EMPTY);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await check(page, "Overview table", size.width);
      await expectAddOpens(page, "Overview table", size.width);
    }

    await page.goto(`${base}/transactions`);
    await expect(page.getByTestId("transaction-row")).toHaveCount(4);
    await checkAll(page, "Transactions");
    await page.goto(`${base}/transactions?category=${b.category(EMPTY)}`);
    await expect(
      page.getByRole("heading", { name: `No ${EMPTY} transactions` }),
    ).toBeVisible();
    await checkAll(page, "Transactions, filter with nothing in it");

    await page.goto(`${base}/categories`);
    await expect(page.getByTestId("category-row")).toHaveCount(7);
    await checkAll(page, "Categories");
    await page.getByTestId("category-row").filter({ hasText: EMPTY }).tap();
    await expect(
      page.getByTestId("category-sheet").getByRole("heading", { name: EMPTY }),
    ).toBeVisible();
    await checkAll(page, "category sheet");

    await page.goto(`${base}/members`);
    await expect(page.getByTestId("member-list")).toContainText(MEMBER);
    await expect(page.getByText(longEmail("i"))).toBeVisible();
    await checkAll(page, "Members");

    await page.goto("/more");
    await expect(page.getByText(BUDGET, { exact: true })).toBeVisible();
    await expect(page.getByText(`Signed in as ${OWNER}`)).toBeVisible();
    await checkAll(page, "More");

    await page.goto("/settings/account");
    await heading("Account");
    await expect(page.getByText(longEmail("o")).first()).toBeVisible();
    await checkAll(page, "Account");

    await page.goto("/settings/security");
    await expect(page.getByTestId("passkey-list")).toContainText(PASSKEY);
    await checkAll(page, "Security");
  });
});

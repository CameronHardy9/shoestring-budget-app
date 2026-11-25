// J2 Quick-add (ARCHITECTURE "Great": 3 taps, under 10 s, one-handed):
// "+" → type the amount (keypad already up) → tap a category → Save.
// Acceptance: the amount field opens the numeric keypad; the date defaults to
// today in the budget timezone; splits must sum, with "left to assign".
// Focus continuity (touch projects): no tap in the sheet takes focus out of
// the text field, so the phone keyboard stays up.
import type { Locator, Page, Request } from "@playwright/test";
import { createBudget, createUser } from "../support/factories.ts";
import type { TestBudget } from "../support/factories.ts";
import {
  expect,
  expectAccessible,
  expectNoCspViolations,
  flushCspViolations,
  quickAddOpener,
  signInAs,
  Taps,
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

/**
 * Holds GET /api/budgets/{id} (only that resource, not its sub-resources)
 * until release(), and counts the requests held.
 */
async function holdBudget(
  page: Page,
  budgetId: string,
): Promise<{ release: () => void; held: () => number }> {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  await page.route(
    (url) => url.pathname === `/api/budgets/${budgetId}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      held += 1;
      await gate;
      await route.fallback();
    },
  );
  return {
    release: () => {
      open();
    },
    held: () => held,
  };
}

/** The $9.50 Groceries spend of the two "+ while loading" tests was saved. */
async function expectEagerSpend(page: Page, budget: TestBudget): Promise<void> {
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
}

declare global {
  interface Window {
    /** focusin/focusout trail of the focus-continuity journey (init script). */
    __focusTrail?: string[];
  }
}

/**
 * Records every focusin/focusout in the page, with relatedTarget, so a focus
 * assertion that fails shows where focus went (and so whether the phone
 * keyboard would have closed). Elements are named by test ID, aria-label,
 * <label> text or tag.
 */
async function recordFocusTrail(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trail: string[] = [];
    window.__focusTrail = trail;
    const name = (t: EventTarget | null): string => {
      if (!(t instanceof Element)) return "nothing";
      const input = t instanceof HTMLInputElement ? t : null;
      const label =
        t.getAttribute("data-testid") ??
        t.getAttribute("aria-label") ??
        input?.labels?.[0]?.textContent.trim() ??
        t.textContent.trim().slice(0, 30);
      const kind = input ? `input[${input.type}]` : t.tagName.toLowerCase();
      return `${kind} "${label}"`;
    };
    document.addEventListener(
      "focusin",
      (e) =>
        trail.push(`in  ${name(e.target)} (from ${name(e.relatedTarget)})`),
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => trail.push(`out ${name(e.target)} (to ${name(e.relatedTarget)})`),
      true,
    );
  });
}

/**
 * Focus checks for one journey: `mark()` starts a step, `expect()` asserts
 * where focus is now and, on failure, appends the step's focus trail to the
 * error. `expectNeverLeft()` is stricter: no focusout at all since mark()
 * (the keepFocus buttons cancel mousedown, so focus must not even blink).
 */
class FocusSteps {
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async mark(): Promise<void> {
    await this.page.evaluate(() => window.__focusTrail?.splice(0));
  }
  private async trail(): Promise<string> {
    const t = await this.page.evaluate(() => [...(window.__focusTrail ?? [])]);
    return t.length
      ? t.map((s) => `    ${s}`).join("\n")
      : "    (no focus events)";
  }
  async expect(target: Locator, step: string): Promise<void> {
    try {
      await expect(target, step).toBeFocused();
    } catch (error) {
      if (error instanceof Error)
        error.message += `\n\nFocus events since the last mark() (WebKit sends no focusout when the focused element is removed; see activeElement):\n${await this.trail()}\nactiveElement: ${await this.page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? "none")}`;
      throw error;
    }
  }
  async expectNeverLeft(target: Locator, step: string): Promise<void> {
    await this.expect(target, step);
    const t = await this.page.evaluate(() => [...(window.__focusTrail ?? [])]);
    expect(
      t.filter((s) => s.startsWith("out")),
      `${step}: focus never left the field (a keepFocus tap cancels mousedown)\n${await this.trail()}`,
    ).toEqual([]);
  }
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

  // "+" is never ignored, and never there before it works. During the opening
  // (a cold start) there is no navigation at all (owner ruling 2026-11-25,
  // mvp-planning/10 "iPhone check of the UI fixes"), so nothing can be tapped
  // early; the first tap that is possible must open the sheet. After the
  // opening "+" stays above the page loader and works at once.
  test("on a cold start + is absent until the page is revealed, and the first tap on it then opens the sheet", async ({
    page,
    taps,
  }) => {
    const user = await createUser({ prefix: "eager" });
    const budget = await createBudget(user, { name: "Eager household" }); // Groceries 500, Dining 200
    await signInAs(page, user.email);
    const hold = await holdBudget(page, budget.id);
    const plus = page
      .getByTestId("quick-add-open")
      .or(page.getByTestId("quick-add-open-rail"));
    const loadingBudget = page
      .getByTestId("loading-slot")
      .and(page.locator('[data-label="Loading your budget…"]'));
    try {
      await page.goto(`/budgets/${budget.id}`);
      await expect(
        loadingBudget,
        "the budget's shell is rendered, waiting for the budget",
      ).toBeAttached();
      await expect(page.getByTestId("loading")).toBeVisible();
      await expect(plus, "no + in the page at all").toHaveCount(0);
      expect(hold.held(), "the budget request is still held").toBe(1);
    } finally {
      hold.release();
    }

    // Nothing else is awaited first: the tap lands as soon as + exists.
    await taps.tap(quickAddOpener(page)); // tap 1
    const sheet = page.getByTestId("quick-add-sheet");
    await expect(sheet, "the first tap opens the sheet").toBeVisible();
    const amount = page.getByTestId("quick-add-amount");
    await expect(amount, "the amount is focused at once").toBeFocused();
    await page.keyboard.type("9.50");
    await expect(amount).toHaveValue("9.50");
    await taps.tap(sheet.getByText("Groceries", { exact: true })); // tap 2
    await taps.tap(page.getByTestId("quick-add-save")); // tap 3
    await expect(sheet).toBeHidden();
    expect(taps.count).toBe(3);
    await expectEagerSpend(page, budget);
  });

  test("+ tapped while another budget is still loading opens the sheet at once: the amount takes typing, the categories follow", async ({
    page,
    hasTouch,
    taps,
  }) => {
    const user = await createUser({ prefix: "eager" });
    const first = await createBudget(user, { name: "First household" });
    const budget = await createBudget(user, { name: "Eager household" }); // Groceries 500, Dining 200
    await signInAs(page, user.email);
    await page.goto(`/budgets/${first.id}`);
    await expect(page.getByTestId("total-remaining")).toHaveText("$700.00");

    // The opening is over. Open the second budget in the app, its GET held,
    // so the tap lands while that budget loads.
    const hold = await holdBudget(page, budget.id);
    const sheet = page.getByTestId("quick-add-sheet");
    const loadingCategories = sheet
      .getByRole("status")
      .filter({ hasText: "Loading categories…" });
    try {
      const way = new Taps(hasTouch); // not part of the 3-tap bar
      await way.tap(
        page
          .getByRole("navigation", { name: "Main" })
          .getByRole("link", { name: "More" }),
      );
      await way.tap(page.getByRole("link", { name: /^Eager household/ }));
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
      expect(
        hold.held(),
        "the budget request was still held during all this",
      ).toBe(1);
      await expect(page.getByTestId("total-remaining")).toHaveCount(0);
    } finally {
      hold.release();
    }

    const groceries = sheet.getByText("Groceries", { exact: true });
    await expect(groceries).toBeVisible();
    await expect(loadingCategories).toHaveCount(0);
    await expect(page.getByTestId("quick-add-amount")).toHaveValue("9.50");
    await taps.tap(groceries); // tap 2
    await taps.tap(page.getByTestId("quick-add-save")); // tap 3
    await expect(sheet).toBeHidden();
    expect(taps.count).toBe(3);
    await expectEagerSpend(page, budget);
    expect(
      await transactions(page, first.id),
      "nothing was written to the other budget",
    ).toEqual([]);
  });

  // The owner's iPhone bug: tapping a chip or button in the sheet moved focus
  // off the text field, so iOS closed the keyboard. Playwright's WebKit shows
  // no keyboard, so the test proves the cause instead: after every tap, focus
  // is still in (or handed straight to) a text field. A real-device check is
  // still on RELEASE-CHECKLIST.md (frontend/CLAUDE.md).
  test("the keyboard stays up: chips, buttons and removed fields keep focus in a text field on touch", async ({
    page,
    hasTouch,
    cspViolations,
  }) => {
    test.skip(
      !hasTouch,
      "touch-only: the bug is the phone keyboard closing on a tap; a desktop mouse click has no on-screen keyboard, and locator.tap() needs a touch device",
    );
    await recordFocusTrail(page);
    const posts: Request[] = [];
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        new URL(r.url()).pathname.endsWith("/transactions")
      )
        posts.push(r);
    });
    const budget = await openBudget(page);
    const focus = new FocusSteps(page);

    // 1. Open: the amount has focus. A category chip selects and hands
    //    focus straight back to the amount.
    await quickAddOpener(page).tap();
    const sheet = page.getByTestId("quick-add-sheet");
    const amount = page.getByTestId("quick-add-amount");
    await focus.expect(amount, "the amount is focused when the sheet opens");
    await page.keyboard.type("12.34");
    const categories = sheet.getByRole("radiogroup", { name: "Category" });
    const chip = (name: string) => categories.getByText(name, { exact: true });
    const chipRadio = (name: string) =>
      categories.getByRole("radio", { name, exact: true });
    await focus.mark();
    await chip("Groceries").tap();
    await expect(chipRadio("Groceries")).toBeChecked();
    await focus.expect(amount, "tapping a chip keeps the amount focused");

    // 2. Spent / Received (keepFocus segmented control).
    const type = sheet.getByRole("radiogroup", { name: "Type" });
    await focus.mark();
    await type.getByRole("radio", { name: "Received" }).tap();
    await expect(type.getByRole("radio", { name: "Received" })).toBeChecked();
    await focus.expectNeverLeft(amount, "tapping Received keeps the amount");
    await focus.mark();
    await type.getByRole("radio", { name: "Spent" }).tap();
    await expect(type.getByRole("radio", { name: "Spent" })).toBeChecked();
    await focus.expectNeverLeft(amount, "tapping Spent keeps the amount");

    // 3. Note: opening it keeps the amount; Payee's Return goes to Memo and
    //    does not save; a chip tapped from Memo keeps Memo; hiding Note while
    //    in Memo hands focus to the amount.
    const note = sheet.getByRole("button", { name: "Note" });
    await focus.mark();
    await note.tap();
    const payee = sheet.getByLabel("Payee", { exact: true });
    const memo = sheet.getByLabel("Memo", { exact: true });
    await expect(payee).toBeVisible();
    await focus.expectNeverLeft(amount, "tapping Note keeps the amount");
    await payee.tap();
    await focus.expect(payee, "tapping Payee focuses it");
    await page.keyboard.type("Corner shop");
    await page.keyboard.press("Enter");
    await focus.expect(memo, "Return in Payee moves to Memo");
    await expect(sheet, "Return in Payee did not save").toBeVisible();
    await expect(page.getByTestId("sheet-status")).toHaveText("");
    expect(posts, "Return in Payee sent no POST").toHaveLength(0);
    await page.keyboard.type("Weekly shop");
    await focus.mark();
    await chip("Dining").tap();
    await expect(chipRadio("Dining")).toBeChecked();
    await focus.expect(memo, "tapping a chip from Memo keeps Memo focused");
    await focus.mark();
    await note.tap();
    await expect(memo).toHaveCount(0);
    await focus.expect(amount, "hiding Note while in Memo focuses the amount");

    // 4. Save & new: saved, and the amount is ready for the next one.
    await focus.mark();
    await page.getByTestId("quick-add-save-new").tap();
    await expect(page.getByTestId("sheet-status")).toHaveText(
      "Saved $12.34 to Dining",
    );
    await expect(amount).toHaveValue("");
    await focus.expect(amount, "after Save & new the amount is focused");
    expect(posts, "exactly one create so far").toHaveLength(1);

    // 5. Split: removing the row being typed in hands focus to the next row,
    //    else the previous one; "Put the rest" keeps it; Split off → amount.
    await page.keyboard.type("30");
    await chip("Groceries").tap();
    await focus.expect(amount, "chip before Split keeps the amount");
    await focus.mark();
    await sheet.getByRole("button", { name: "Split", exact: true }).tap();
    const editor = page.getByTestId("split-editor");
    await expect(editor).toBeVisible();
    await focus.expectNeverLeft(amount, "turning Split on keeps the amount");
    const addRow = editor.getByRole("button", { name: "Add category" });
    const bins = editor.getByRole("button", { name: /^Remove / });
    const row = (label: string) => editor.getByLabel(label, { exact: true });
    await focus.mark();
    await addRow.tap();
    await expect(bins).toHaveCount(3);
    await focus.expectNeverLeft(amount, "Add category keeps the amount");
    await row("Amount 1, Groceries").fill("20");
    await row("Amount 3").tap();
    await page.keyboard.type("3");
    await row("Amount 2").tap();
    await focus.expect(row("Amount 2"), "tapping the middle row's amount");
    await page.keyboard.type("7");
    await focus.mark();
    await editor.getByRole("button", { name: "Remove line 2" }).tap();
    await expect(bins).toHaveCount(2);
    // The old third row (3) is now the second.
    await expect(row("Amount 2")).toHaveValue("3");
    await focus.expect(
      row("Amount 2"),
      "removing the middle row while typing in it focuses the next row",
    );
    await addRow.tap();
    await expect(bins).toHaveCount(3);
    await row("Amount 3").tap();
    await page.keyboard.type("1");
    await focus.mark();
    await editor.getByRole("button", { name: "Remove line 3" }).tap();
    await expect(bins, "two rows are left").toHaveCount(2);
    await expect(row("Amount 2")).toHaveValue("3");
    await focus.expect(
      row("Amount 2"),
      "removing the last row while typing in it focuses the previous row",
    );
    await editor.getByLabel("Category 2").selectOption({ label: "Dining" });
    const rowDining = row("Amount 2, Dining");
    await rowDining.tap();
    await expect(page.getByTestId("split-left-to-assign")).toContainText(
      "$7.00 left to assign",
    );
    await focus.mark();
    await editor.getByRole("button", { name: "Put the rest on Dining" }).tap();
    await expect(rowDining).toHaveValue("10.00");
    await expect(page.getByTestId("split-left-to-assign")).toContainText(
      "Fully assigned",
    );
    await focus.expectNeverLeft(rowDining, '"Put the rest" keeps the row');
    await focus.mark();
    await sheet.getByRole("button", { name: "Split, on" }).tap();
    await expect(editor).toHaveCount(0);
    await focus.expect(
      amount,
      "turning Split off while in a row focuses the amount",
    );

    // 6. The keyboard path is unchanged: Tab reaches the chips' radio group,
    //    an arrow key selects the next chip.
    await expect(
      chipRadio("Groceries"),
      "Split off keeps row 1's category",
    ).toBeChecked();
    await page.keyboard.press("Tab");
    await focus.expect(
      categories.getByRole("radio", { checked: true }),
      "Tab from the amount focuses the selected chip's radio",
    );
    const radios = categories.getByRole("radio");
    const count = await radios.count();
    const at = await radios.evaluateAll((els) =>
      els.findIndex((el) => (el as HTMLInputElement).checked),
    );
    await page.keyboard.press("ArrowRight");
    const next = radios.nth((at + 1) % count);
    await expect(next, "ArrowRight selects the next chip").toBeChecked();
    await focus.expect(next, "and focuses it");

    // 7. A ~300 px keyboard (visualViewport shrinks, as on iOS): the sheet
    //    lifts above it, its top stays on screen, its content scrolls.
    await amount.tap();
    await note.tap();
    await expect(payee).toBeVisible();
    const lift = 300;
    const innerHeight = await page.evaluate((px) => {
      const vv = window.visualViewport;
      if (!vv) throw new Error("no visualViewport");
      const height = window.innerHeight - px;
      Object.defineProperty(vv, "height", {
        configurable: true,
        get: () => height,
      });
      vv.dispatchEvent(new Event("resize"));
      return window.innerHeight;
    }, lift);
    await expect
      .poll(
        async () => {
          const b = await sheet.boundingBox();
          return b ? Math.round(b.y + b.height) : Number.POSITIVE_INFINITY;
        },
        {
          message:
            "the sheet's bottom sits on the simulated keyboard (useKeyboardInset saw it)",
        },
      )
      .toBeLessThanOrEqual(innerHeight - lift + 1);
    const box = await sheet.boundingBox();
    expect(box, "the sheet is on screen").not.toBeNull();
    expect(
      box!.y,
      "the sheet's top (title, amount) stays on screen above the keyboard",
    ).toBeGreaterThanOrEqual(0);
    const scrolled = await sheet.evaluate((dialog) => {
      const scroller = [dialog, ...dialog.querySelectorAll("*")].find(
        (el) =>
          ["auto", "scroll"].includes(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight,
      );
      if (!scroller) return null;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop;
    });
    expect(
      scrolled,
      "the sheet's content scrolls inside it (a scroller with overflow exists and moves)",
    ).toBeGreaterThan(0);

    // 8. No CSP violations (meaningful on the production build; the dev
    //    server sends no CSP, so here it guards the CSSOM-only maxHeight).
    await flushCspViolations(page);
    expectNoCspViolations(cspViolations);

    const saved = await transactions(page, budget.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      amountCents: 1_234,
      direction: "outflow",
    });
    expect(saved[0]!.splits).toEqual([
      { categoryId: budget.categories.Dining, amountCents: 1_234 },
    ]);
  });
});

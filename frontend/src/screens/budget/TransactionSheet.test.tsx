import { onlineManager } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { apiError, json, mockApi } from "../../test/api-mock.ts";
import { expectNoAxeViolations } from "../../test/axe.ts";
import {
  budget,
  BUDGET_ID,
  categories,
  category,
  transaction,
  uuid,
} from "../../test/fixtures.ts";
import { deferred, tappableAfter } from "../../test/layout.ts";
import { renderWithApp } from "../../test/render.tsx";
import { keys } from "../../app/data.ts";
import { SLOW_PRESS_WAIT_MS } from "../../components/useSlowPress.ts";
import { TransactionSheet, type SheetMode } from "./TransactionSheet.tsx";

const TX = `/budgets/${BUDGET_ID}/transactions`;
const base = {
  [`GET /budgets/${BUDGET_ID}/categories`]: json(200, { items: categories }),
  [`GET ${TX}`]: json(200, { items: [], nextCursor: null }),
};

function open(mode: SheetMode = { kind: "create" }) {
  let closed = 0;
  const view = renderWithApp(
    <TransactionSheet
      budgetId={BUDGET_ID}
      budget={budget}
      mode={mode}
      onClose={() => (closed += 1)}
    />,
  );
  return { ...view, closed: () => closed };
}

afterEach(() => {
  onlineManager.setOnline(true);
});

const sheet = () => screen.getByTestId("quick-add-sheet");

/**
 * Return in a field submits the form. Twice before React re-renders (so the
 * Save button can't show "pending" yet): the race keepFocus makes possible.
 */
function returnTwiceInOneTick(field: HTMLElement) {
  const form = field.closest("form");
  if (!form) throw new Error("no form");
  act(() => {
    form.requestSubmit();
    form.requestSubmit();
  });
}
const chip = (name: string) => within(sheet()).getByText(name, { exact: true });

describe("quick-add", () => {
  it("saves in three steps with an Idempotency-Key and the budget's today", async () => {
    const api = mockApi({ ...base, [`POST ${TX}`]: json(201, transaction(1)) });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    expect(amount).toHaveFocus();
    await userEvent.type(amount, "42.50");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const [post] = api.find("POST", TX);
    expect(post?.body).toEqual({
      date: "2026-11-14",
      direction: "outflow",
      amountCents: 4250,
      payee: null,
      memo: null,
      splits: [{ categoryId: uuid(1), amountCents: 4250 }],
    });
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers.get("X-CSRF-Token")).toBe("c".repeat(43));
    expect(
      await screen.findByText("Saved $42.50 to Groceries"),
    ).toBeInTheDocument();
  });

  it("holds the chips until recent use has ordered them, so none moves under a tap", async () => {
    const recent = deferred<ReturnType<typeof json>>();
    mockApi({
      ...base,
      [`GET ${TX}`]: () => recent.promise,
    });
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    expect(amount).toHaveFocus();
    const loading = await within(sheet()).findByTestId("loading");
    expect(tappableAfter(loading, sheet())).toEqual([]);
    expect(within(sheet()).queryByText("Groceries")).toBeNull();
    // Transport was used most recently, so it comes first once known.
    recent.resolve(
      json(200, {
        items: [
          transaction(1, {
            splits: [{ categoryId: uuid(3), amountCents: 1250 }],
          }),
        ],
        nextCursor: null,
      }),
    );
    const group = await within(sheet()).findByRole("radiogroup", {
      name: "Category",
    });
    const chips = within(group).getAllByRole("radio");
    expect(chips[0]).toHaveAccessibleName("Transport");
  });

  it("puts a category added while the sheet is open last, moving no chip", async () => {
    mockApi(base);
    const view = open();
    const group = await within(sheet()).findByRole("radiogroup", {
      name: "Category",
    });
    const names = () =>
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent);
    const before = names();
    // Another member adds "Pets", which would sort first on its own.
    view.client.setQueryData(keys.categories(BUDGET_ID), {
      items: [{ ...category(9, "Pets"), sortOrder: 0 }, ...categories],
    });
    await waitFor(() => {
      expect(names()).toEqual([...before, "Pets"]);
    });
  });

  describe("a selected chip beyond the first six", () => {
    const eight = [
      ...categories.filter((c) => c.kind === "expense" && !c.archived),
      ...["Pets", "Gifts", "Books", "Travel", "Health", "Music"].map(
        (n, i) => ({
          ...category(20 + i, n),
          sortOrder: 100 + i,
        }),
      ),
    ];
    const last = eight.at(-1);
    const names = () =>
      within(within(sheet()).getByRole("radiogroup", { name: "Category" }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    const toggle = (name: RegExp) =>
      userEvent.click(within(sheet()).getByRole("button", { name }));

    async function openWith(mode?: SheetMode) {
      mockApi({
        ...base,
        [`GET /budgets/${BUDGET_ID}/categories`]: json(200, { items: eight }),
      });
      open(mode);
      await within(sheet()).findByRole("radiogroup", { name: "Category" });
    }

    it("stays in place when another chip is tapped (editing)", async () => {
      if (!last) throw new Error("no category");
      await openWith({
        kind: "edit",
        transaction: transaction(1, {
          splits: [{ categoryId: last.id, amountCents: 1250 }],
        }),
      });
      const before = names();
      expect(before).toHaveLength(7);
      expect(before.at(-1)).toBe("Music");
      await userEvent.click(chip(before[0] ?? ""));
      expect(names()).toEqual(before);
      await userEvent.click(chip("Music"));
      expect(names()).toEqual(before);
    });

    it("stays after Fewer categories, in the order chosen, until the sheet closes", async () => {
      await openWith();
      const six = names();
      expect(six).toHaveLength(6);
      await toggle(/^All categories/);
      expect(names()).toHaveLength(eight.length);
      await userEvent.click(chip("Music"));
      await toggle(/^Fewer categories/);
      expect(names()).toEqual([...six, "Music"]);
      await userEvent.click(chip(six[0] ?? ""));
      expect(names()).toEqual([...six, "Music"]);
      // Choosing another one adds it after, moving nothing.
      await toggle(/^All categories/);
      await userEvent.click(chip("Travel"));
      await toggle(/^Fewer categories/);
      expect(names()).toEqual([...six, "Music", "Travel"]);
      // One only looked at, never kept, is gone again.
      await toggle(/^All categories/);
      await userEvent.click(chip("Health"));
      await userEvent.click(chip(six[1] ?? ""));
      await toggle(/^Fewer categories/);
      expect(names()).toEqual([...six, "Music", "Travel"]);
    });
  });

  it("keeps everything on a network failure and retries with the same key", async () => {
    let attempt = 0;
    const api = mockApi({
      ...base,
      [`POST ${TX}`]: () =>
        ++attempt === 1
          ? new TypeError("Failed to fetch")
          : json(201, transaction(1)),
    });
    const view = open();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Amount" }),
      "9.99",
    );
    await userEvent.click(chip("Transport"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("9.99");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const keys = api
      .find("POST", TX)
      .map((c) => c.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("fails at once when the phone knows it's offline, keeping the entry", async () => {
    // Offline, the browser's fetch rejects straight away ("Failed to fetch").
    const api = mockApi({
      ...base,
      [`POST ${TX}`]: new TypeError("Failed to fetch"),
    });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await within(sheet()).findByRole("radiogroup", { name: "Category" });
    onlineManager.setOnline(false);
    await userEvent.type(amount, "12.34");
    await userEvent.click(chip("Dining out"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    // Not paused behind a spinner until the connection returns: the write
    // was attempted and failed, and the sheet says so with the entry intact.
    expect(await within(sheet()).findByTestId("form-error")).toHaveTextContent(
      "You're offline or the connection dropped. Nothing you typed was lost.",
    );
    expect(api.find("POST", TX)).toHaveLength(1);
    expect(view.closed()).toBe(0);
    expect(amount).toHaveValue("12.34");
    expect(
      within(sheet()).getByRole("radio", { name: "Dining out" }),
    ).toBeChecked();
    const save = screen.getByTestId("quick-add-save");
    expect(save).toHaveTextContent("Retry");
    expect(save).not.toHaveAttribute("data-pending");
    expect(screen.getByTestId("quick-add-save-new")).not.toHaveAttribute(
      "data-pending",
    );
  });

  it("creates exactly one transaction when retried after reconnecting", async () => {
    // A server that honours Idempotency-Key: a repeated key replays the
    // first result instead of creating another transaction.
    const created = new Map<string, ReturnType<typeof transaction>>();
    let attempt = 0;
    const api = mockApi({
      ...base,
      [`POST ${TX}`]: (req) => {
        attempt += 1;
        // 1: offline, never reaches the server.
        if (attempt === 1) return new TypeError("Failed to fetch");
        const key = req.headers.get("Idempotency-Key") ?? "";
        if (!created.has(key)) created.set(key, transaction(created.size + 1));
        // 2: back online, saved, but the response is lost on the way back.
        if (attempt === 2) return new TypeError("Failed to fetch");
        return json(201, created.get(key));
      },
    });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await within(sheet()).findByRole("radiogroup", { name: "Category" });
    onlineManager.setOnline(false);
    await userEvent.type(amount, "5");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();

    onlineManager.setOnline(true);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(api.find("POST", TX)).toHaveLength(2);
    });
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    expect(amount).toHaveValue("5");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const sent = api
      .find("POST", TX)
      .map((c) => c.headers.get("Idempotency-Key"));
    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(1);
    expect(created.size).toBe(1);
  });

  it("fails an offline edit and an offline delete at once too", async () => {
    const existing = transaction(7, { version: 3 });
    const ONE = `${TX}/${existing.id}`;
    const api = mockApi({
      ...base,
      [`PUT ${ONE}`]: new TypeError("Failed to fetch"),
      [`DELETE ${ONE}`]: new TypeError("Failed to fetch"),
    });
    const view = open({ kind: "edit", transaction: existing });
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    onlineManager.setOnline(false);
    await userEvent.clear(amount);
    await userEvent.type(amount, "8");
    await userEvent.click(screen.getByTestId("quick-add-save"));
    expect(await within(sheet()).findByTestId("form-error")).toHaveTextContent(
      "You're offline",
    );
    expect(amount).toHaveValue("8");
    expect(api.find("PUT", ONE)).toHaveLength(1);

    await userEvent.click(screen.getByTestId("delete-transaction"));
    await userEvent.click(screen.getByTestId("confirm-delete"));
    await waitFor(() => {
      expect(api.find("DELETE", ONE)).toHaveLength(1);
    });
    expect(within(sheet()).getByTestId("form-error")).toHaveTextContent(
      "You're offline",
    );
    expect(screen.getByTestId("confirm-delete")).not.toHaveAttribute(
      "data-pending",
    );
    expect(view.closed()).toBe(0);
  });

  it("Save & new keeps the sheet open with a fresh key", async () => {
    const api = mockApi({ ...base, [`POST ${TX}`]: json(201, transaction(1)) });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "1");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByTestId("quick-add-save-new"));
    await waitFor(() => {
      expect(amount).toHaveValue("");
    });
    expect(screen.getByTestId("sheet-status")).toHaveTextContent(
      "Saved $1.00 to Groceries",
    );
    await userEvent.type(amount, "2");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByTestId("quick-add-save-new"));
    await waitFor(() => {
      expect(api.find("POST", TX)).toHaveLength(2);
    });
    const [a, b] = api
      .find("POST", TX)
      .map((c) => c.headers.get("Idempotency-Key"));
    expect(a).not.toBe(b);
    expect(view.closed()).toBe(0);
  });

  it("keeps focus in the text fields while chips and buttons are tapped (iOS keyboard stays up)", async () => {
    const api = mockApi({ ...base, [`POST ${TX}`]: json(201, transaction(1)) });
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "3");
    await userEvent.click(chip("Groceries"));
    expect(
      within(sheet()).getByRole("radio", { name: "Groceries" }),
    ).toBeChecked();
    expect(amount).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    expect(amount).toHaveFocus();
    const payee = screen.getByRole("textbox", { name: "Payee" });
    await userEvent.click(payee);
    await userEvent.click(chip("Groceries"));
    expect(payee).toHaveFocus();
    // Save & new leaves the field, then hands focus back to the amount.
    await userEvent.click(screen.getByTestId("quick-add-save-new"));
    await waitFor(() => {
      expect(api.find("POST", TX)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(amount).toHaveFocus();
    });
  });

  it("moves focus to Amount when Note is hidden while typing in Payee or Memo", async () => {
    mockApi(base);
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    const note = await screen.findByRole("button", { name: "Note" });
    await userEvent.click(note);
    await userEvent.click(screen.getByRole("textbox", { name: "Memo" }));
    await userEvent.click(note);
    expect(screen.queryByRole("textbox", { name: "Memo" })).toBeNull();
    expect(amount).toHaveFocus();
    await userEvent.click(note);
    await userEvent.click(screen.getByRole("textbox", { name: "Payee" }));
    await userEvent.click(note);
    expect(amount).toHaveFocus();
    // Focus somewhere else: hiding Note leaves it there.
    await userEvent.click(note);
    const spent = screen.getByRole("radio", { name: "Spent" });
    spent.focus();
    await userEvent.click(note);
    expect(screen.queryByRole("textbox", { name: "Payee" })).toBeNull();
    expect(spent).toHaveFocus();
  });

  it("moves focus to the main Amount when Split is turned off from a row", async () => {
    mockApi(base);
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "10");
    await userEvent.click(chip("Groceries"));
    const split = screen.getByRole("button", { name: "Split" });
    await userEvent.click(split);
    await userEvent.click(
      within(screen.getByTestId("split-editor")).getByRole("textbox", {
        name: /Amount 2/,
      }),
    );
    // Focus must move inside the tap, before the row goes: React Aria's
    // FocusScope would also rescue it, but later, which on iOS is after the
    // keyboard has closed.
    let movedBeforeRemoval: boolean | null = null;
    amount.addEventListener(
      "focus",
      () => {
        movedBeforeRemoval = screen.queryByTestId("split-editor") !== null;
      },
      { once: true },
    );
    await userEvent.click(screen.getByRole("button", { name: "Split, on" }));
    expect(screen.queryByTestId("split-editor")).toBeNull();
    expect(amount).toHaveFocus();
    expect(movedBeforeRemoval).toBe(true);
  });

  it("moves focus to the neighbouring row when the row being typed in is removed", async () => {
    mockApi(base);
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "10");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    const editor = screen.getByTestId("split-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const rowAmounts = () => within(editor).getAllByRole("textbox");
    const removes = () =>
      within(editor).getAllByRole("button", { name: /^Remove/ });
    expect(rowAmounts()).toHaveLength(4);
    const [first, second, , fourth] = rowAmounts();

    // Not the focused row: focus stays.
    await userEvent.click(second!);
    await userEvent.click(removes()[3]!);
    expect(rowAmounts()).toHaveLength(3);
    expect(second).toHaveFocus();
    expect(fourth).not.toBeInTheDocument();

    // The focused row: the next one takes focus.
    await userEvent.click(first!);
    await userEvent.click(removes()[0]!);
    expect(rowAmounts()).toHaveLength(2);
    expect(second).toHaveFocus();

    // Two rows left: removing one ends the split, so the main amount takes
    // focus.
    const [, last] = rowAmounts();
    await userEvent.click(last!);
    await userEvent.click(removes()[1]!);
    expect(screen.queryByTestId("split-editor")).toBeNull();
    expect(amount).toHaveFocus();
  });

  it("moves focus to the previous row when the last of several rows is removed", async () => {
    mockApi(base);
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "10");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    const editor = screen.getByTestId("split-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const [, second, third] = within(editor).getAllByRole("textbox");
    await userEvent.click(third!);
    const removes = within(editor).getAllByRole("button", { name: /^Remove/ });
    await userEvent.click(removes[2]!);
    expect(third).not.toBeInTheDocument();
    expect(second).toHaveFocus();
  });

  it("keeps focus in Amount when Spent/Received is tapped", async () => {
    mockApi(base);
    open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.click(screen.getByRole("radio", { name: "Received" }));
    expect(screen.getByRole("radio", { name: "Received" })).toBeChecked();
    expect(amount).toHaveFocus();
  });

  it("creates once when Return is pressed twice quickly", async () => {
    const reply = deferred<ReturnType<typeof json>>();
    const api = mockApi({ ...base, [`POST ${TX}`]: () => reply.promise });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "5");
    await userEvent.click(chip("Groceries"));
    expect(amount).toHaveFocus();
    returnTwiceInOneTick(amount);
    await userEvent.keyboard("{Enter}");
    expect(api.find("POST", TX)).toHaveLength(1);
    reply.resolve(json(201, transaction(1)));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    expect(api.find("POST", TX)).toHaveLength(1);
  });

  it("goes from Payee to Memo on Return (Next) and saves on Return in Memo", async () => {
    const api = mockApi({ ...base, [`POST ${TX}`]: json(201, transaction(1)) });
    const view = open();
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "4");
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const payee = screen.getByRole("textbox", { name: "Payee" });
    const memo = screen.getByRole("textbox", { name: "Memo" });
    expect(payee).toHaveAttribute("enterkeyhint", "next");
    await userEvent.click(payee);
    await userEvent.keyboard("Corner shop{Enter}");
    expect(memo).toHaveFocus();
    expect(api.find("POST", TX)).toHaveLength(0);
    await userEvent.keyboard("Milk{Enter}");
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const [post] = api.find("POST", TX);
    expect(post?.body).toMatchObject({ payee: "Corner shop", memo: "Milk" });
  });

  it("still closes on Escape from Payee", async () => {
    mockApi(base);
    const view = open();
    await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.click(await screen.findByRole("button", { name: "Note" }));
    await userEvent.click(screen.getByRole("textbox", { name: "Payee" }));
    await userEvent.keyboard("{Escape}");
    expect(view.closed()).toBe(1);
  });

  it("validates before sending and maps server field errors", async () => {
    const api = mockApi({
      ...base,
      [`POST ${TX}`]: apiError(422, "CATEGORY_ARCHIVED", [
        {
          in: "body",
          field: "splits.0.categoryId",
          issue: "archived",
          message: "x",
        },
      ]),
    });
    open();
    await userEvent.click(await screen.findByTestId("quick-add-save"));
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    expect(screen.getByText("Choose a category.")).toBeInTheDocument();
    expect(api.find("POST", TX)).toHaveLength(0);
    await userEvent.type(screen.getByRole("textbox", { name: "Amount" }), "5");
    await userEvent.click(chip("Dining out"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    expect(
      await screen.findByText("This category is archived."),
    ).toBeInTheDocument();
  });

  it("explains a reused key and can save the changed entry as new", async () => {
    let attempt = 0;
    const api = mockApi({
      ...base,
      [`POST ${TX}`]: () =>
        ++attempt === 1
          ? apiError(422, "IDEMPOTENCY_KEY_REUSED", [
              {
                in: "header",
                field: "Idempotency-Key",
                issue: "invalid_value",
                message: "x",
              },
            ])
          : json(201, transaction(1)),
    });
    const view = open();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Amount" }),
      "3",
    );
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByTestId("quick-add-save"));
    expect(
      await screen.findByText(/first save went through/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Save this as a new transaction" }),
    );
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const [a, b] = api
      .find("POST", TX)
      .map((c) => c.headers.get("Idempotency-Key"));
    expect(a).not.toBe(b);
  });

  it("splits with a live left-to-assign and has no axe violations", async () => {
    const api = mockApi({ ...base, [`POST ${TX}`]: json(201, transaction(1)) });
    const view = open();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Amount" }),
      "86.40",
    );
    await userEvent.click(chip("Groceries"));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    const editor = screen.getByTestId("split-editor");
    await userEvent.selectOptions(
      within(editor).getAllByRole("combobox")[1]!,
      "Household",
    );
    await userEvent.clear(
      within(editor).getByRole("textbox", { name: /Amount 1/ }),
    );
    await userEvent.type(
      within(editor).getByRole("textbox", { name: /Amount 1/ }),
      "60",
    );
    await userEvent.type(
      within(editor).getByRole("textbox", { name: /Amount 2/ }),
      "20",
    );
    expect(screen.getByTestId("split-left-to-assign")).toHaveTextContent(
      "$6.40 left to assign",
    );
    await expectNoAxeViolations(view.baseElement);
    // Split-row buttons leave the keyboard where it was (Amount 2).
    const amount2 = within(editor).getByRole("textbox", { name: /Amount 2/ });
    expect(amount2).toHaveFocus();
    await userEvent.click(
      screen.getByRole("button", { name: "Put the rest on Household" }),
    );
    expect(screen.getByTestId("split-left-to-assign")).toHaveTextContent(
      "Fully assigned",
    );
    expect(amount2).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    expect(within(editor).getAllByRole("combobox")).toHaveLength(3);
    expect(amount2).toHaveFocus();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove line 3" }),
    );
    expect(within(editor).getAllByRole("combobox")).toHaveLength(2);
    expect(amount2).toHaveFocus();
    await userEvent.click(screen.getByTestId("quick-add-save"));
    await waitFor(() => {
      expect(api.find("POST", TX)[0]?.body).toMatchObject({
        amountCents: 8640,
        splits: [
          { categoryId: uuid(1), amountCents: 6000 },
          { categoryId: uuid(4), amountCents: 2640 },
        ],
      });
    });
  });
});

describe("edit and delete", () => {
  const existing = transaction(7, {
    amountCents: 23000,
    version: 3,
    splits: [{ categoryId: uuid(2), amountCents: 23000 }],
  });
  const ONE = `${TX}/${existing.id}`;

  it("sends one save when Return is pressed twice quickly", async () => {
    const reply = deferred<ReturnType<typeof json>>();
    const api = mockApi({ ...base, [`PUT ${ONE}`]: () => reply.promise });
    const view = open({ kind: "edit", transaction: existing });
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "23.10");
    returnTwiceInOneTick(amount);
    await userEvent.keyboard("{Enter}");
    reply.resolve(json(200, { ...existing, amountCents: 2310, version: 4 }));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    expect(api.find("PUT", ONE)).toHaveLength(1);
  });

  it("sends the version and shows both versions on a conflict", async () => {
    const theirs = {
      ...existing,
      amountCents: 2400,
      version: 4,
      splits: [{ categoryId: uuid(2), amountCents: 2400 }],
    };
    let attempt = 0;
    const api = mockApi({
      ...base,
      [`PUT ${ONE}`]: () =>
        ++attempt === 1 ? apiError(409, "VERSION_CONFLICT") : json(200, theirs),
      [`GET ${ONE}`]: json(200, theirs),
    });
    const view = open({ kind: "edit", transaction: existing });
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "23.10");
    await userEvent.click(screen.getByTestId("quick-add-save"));
    const conflict = await screen.findByTestId("conflict");
    expect(conflict).toHaveTextContent("$24.00");
    await userEvent.click(
      within(conflict).getByRole("button", { name: "Save mine instead" }),
    );
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    const puts = api.find("PUT", ONE);
    expect(puts.map((p) => (p.body as { version: number }).version)).toEqual([
      3, 4,
    ]);
    expect(puts[1]?.body).toMatchObject({
      amountCents: 2310,
      payee: null,
      memo: null,
    });
  });

  it("deletes with the version after confirming", async () => {
    const api = mockApi({ ...base, [`DELETE ${ONE}`]: json(204) });
    const view = open({ kind: "edit", transaction: existing });
    await userEvent.click(await screen.findByTestId("delete-transaction"));
    const group = screen.getByRole("group", { name: "Confirm delete" });
    await waitFor(() => {
      expect(group).toHaveFocus();
    });
    await userEvent.click(screen.getByTestId("confirm-delete"));
    await waitFor(() => {
      expect(view.closed()).toBe(1);
    });
    expect(api.find("DELETE", ONE)[0]?.search.get("version")).toBe("3");
  });

  it("tells the person when the transaction is gone", async () => {
    mockApi({ ...base, [`PUT ${ONE}`]: apiError(404, "NOT_FOUND") });
    open({ kind: "edit", transaction: existing });
    await userEvent.click(await screen.findByTestId("quick-add-save"));
    expect(await screen.findByText(/was deleted/)).toBeInTheDocument();
  });
});

// A slow touch press (no native click in time) makes the app click the button
// itself; a late native click may still follow. Saving must not happen twice.
describe("a slow press on Save, then a late native click", () => {
  const ONE = `${TX}/${uuid(101)}`;
  const existing = transaction(1, { version: 3 });
  type Reply = ReturnType<typeof json>;

  /** The sheet as the app mounts it: closing it unmounts it. */
  function App({ mode }: { mode: SheetMode }) {
    const [isOpen, setOpen] = useState(true);
    return isOpen ? (
      <TransactionSheet
        budgetId={BUDGET_ID}
        budget={budget}
        mode={mode}
        onClose={() => {
          setOpen(false);
        }}
      />
    ) : null;
  }

  const finger = {
    pointerType: "touch",
    isPrimary: true,
    pointerId: 3,
    width: 20,
    height: 20,
  };
  const pastTheWait = () =>
    new Promise((resolve) => setTimeout(resolve, SLOW_PRESS_WAIT_MS + 60));
  async function slowPress(el: HTMLElement) {
    fireEvent.pointerDown(el, finger);
    fireEvent.pointerUp(el, finger);
    await act(pastTheWait);
  }
  function lateClick(el: HTMLElement) {
    fireEvent.mouseDown(el);
    fireEvent.mouseUp(el);
    fireEvent.click(el, { detail: 1 });
  }
  /** Long enough for any second request to have been made. */
  const settle = () => act(pastTheWait);

  const amount = () => screen.getByRole("textbox", { name: "Amount" });
  const save = () => screen.getByTestId("quick-add-save");
  const saveNew = () => screen.getByTestId("quick-add-save-new");
  const sheetOpen = () => screen.queryByTestId("quick-add-sheet") !== null;
  const fill = async (text: string, category: string) => {
    await userEvent.type(amount(), text);
    await userEvent.click(chip(category));
  };
  const keysOf = (calls: { headers: Headers }[]) =>
    calls.map((c) => c.headers.get("Idempotency-Key"));

  async function startCreate(reply: () => Reply | Error | Promise<Reply>) {
    const api = mockApi({ ...base, [`POST ${TX}`]: reply });
    renderWithApp(<App mode={{ kind: "create" }} />);
    await within(sheet()).findByRole("radiogroup", { name: "Category" });
    await fill("42.50", "Groceries");
    return { posts: () => api.find("POST", TX) };
  }
  async function startEdit(reply: () => Reply | Error | Promise<Reply>) {
    const api = mockApi({ ...base, [`PUT ${ONE}`]: reply });
    renderWithApp(<App mode={{ kind: "edit", transaction: existing }} />);
    await within(sheet()).findByRole("radiogroup", { name: "Category" });
    await userEvent.clear(amount());
    await userEvent.type(amount(), "23.10");
    return { puts: () => api.find("PUT", ONE) };
  }

  it("Save & new, late click while saving: one POST, and the entry stays until it is saved", async () => {
    const reply = deferred<Reply>();
    const { posts } = await startCreate(() => reply.promise);
    await slowPress(saveNew());
    lateClick(saveNew());
    await settle();
    expect(posts()).toHaveLength(1);
    expect(amount()).toHaveValue("42.50");
    reply.resolve(json(201, transaction(1)));
    await waitFor(() => {
      expect(amount()).toHaveValue("");
    });
    await settle();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      amountCents: 4250,
      splits: [{ categoryId: uuid(1), amountCents: 4250 }],
    });
  });

  it("Save & new, late click after the form reset: one POST, a clean form, and the next entry is its own", async () => {
    const { posts } = await startCreate(() => json(201, transaction(1)));
    const button = saveNew();
    await slowPress(button);
    await waitFor(() => {
      expect(amount()).toHaveValue("");
    });
    lateClick(button);
    await settle();
    expect(posts()).toHaveLength(1);
    expect(amount()).toHaveValue("");
    expect(amount()).toHaveFocus();
    expect(amount()).toBeValid();
    expect(
      within(sheet()).queryByRole("radio", { name: "Groceries" }),
    ).not.toBeChecked();
    expect(screen.getByTestId("sheet-status")).toHaveTextContent(
      "Saved $42.50 to Groceries",
    );

    await fill("7", "Transport");
    await slowPress(saveNew());
    lateClick(saveNew());
    await settle();
    expect(posts().map((p) => p.body)).toMatchObject([
      { amountCents: 4250, splits: [{ categoryId: uuid(1) }] },
      { amountCents: 700, splits: [{ categoryId: uuid(3) }] },
    ]);
    const [first, second] = keysOf(posts());
    expect(second).not.toBe(first);
  });

  it("Save & new fails, then the late click: no duplicate, and the one retry has the same key", async () => {
    let attempt = 0;
    const { posts } = await startCreate(() =>
      ++attempt === 1
        ? new TypeError("Failed to fetch")
        : json(201, transaction(1)),
    );
    await slowPress(saveNew());
    await screen.findByText(/You're offline/);
    lateClick(saveNew());
    await settle();
    expect(posts().length).toBeLessThanOrEqual(2);
    // Now ask for the retry if the late click wasn't one.
    if (posts().length === 1) await slowPress(saveNew());
    await waitFor(() => {
      expect(amount()).toHaveValue("");
    });
    await settle();
    expect(posts()).toHaveLength(2);
    const [first, second] = keysOf(posts());
    expect(second).toBe(first);
    expect(posts()[1]?.body).toEqual(posts()[0]?.body);
  });

  it("Save, late click while saving: one POST", async () => {
    const reply = deferred<Reply>();
    const { posts } = await startCreate(() => reply.promise);
    await slowPress(save());
    lateClick(save());
    await settle();
    expect(posts()).toHaveLength(1);
    reply.resolve(json(201, transaction(1)));
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    await settle();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({ amountCents: 4250 });
  });

  it("Save, late click before the button can show it is saving: one POST", async () => {
    const reply = deferred<Reply>();
    const { posts } = await startCreate(() => reply.promise);
    const button = save();
    fireEvent.pointerDown(button, finger);
    fireEvent.pointerUp(button, finger);
    await act(async () => {
      const pressed = new Promise((resolve) => {
        button.addEventListener("click", resolve, { once: true });
      });
      await pressed;
      // Nothing has re-rendered inside this act.
      expect(button).toHaveAttribute("type", "submit");
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    await settle();
    expect(posts()).toHaveLength(1);
    reply.resolve(json(201, transaction(1)));
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    expect(posts()).toHaveLength(1);
  });

  it("Save, late click after it saved and closed: one POST", async () => {
    const { posts } = await startCreate(() => json(201, transaction(1)));
    const button = save();
    await slowPress(button);
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    lateClick(button);
    await settle();
    expect(posts()).toHaveLength(1);
  });

  it("Save fails, then the late click: at most one retry, with the same key", async () => {
    let attempt = 0;
    const { posts } = await startCreate(() =>
      ++attempt === 1
        ? new TypeError("Failed to fetch")
        : json(201, transaction(1)),
    );
    await slowPress(save());
    await screen.findByText(/You're offline/);
    expect(posts()).toHaveLength(1);
    const button = save();
    lateClick(button);
    lateClick(button);
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    await settle();
    expect(posts()).toHaveLength(2);
    const [first, second] = keysOf(posts());
    expect(second).toBe(first);
    expect(posts()[1]?.body).toEqual(posts()[0]?.body);
  });

  it("editing, late click while saving: one PUT", async () => {
    const reply = deferred<Reply>();
    const { puts } = await startEdit(() => reply.promise);
    await slowPress(save());
    lateClick(save());
    await settle();
    expect(puts()).toHaveLength(1);
    reply.resolve(json(200, { ...existing, amountCents: 2310, version: 4 }));
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    await settle();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toMatchObject({ amountCents: 2310, version: 3 });
  });

  it("editing, late click after it saved and closed: one PUT", async () => {
    const { puts } = await startEdit(() =>
      json(200, { ...existing, amountCents: 2310, version: 4 }),
    );
    const button = save();
    await slowPress(button);
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    lateClick(button);
    await settle();
    expect(puts()).toHaveLength(1);
  });

  it("editing fails, then the late click: at most one retry, of the same version", async () => {
    let attempt = 0;
    const { puts } = await startEdit(() =>
      ++attempt === 1
        ? new TypeError("Failed to fetch")
        : json(200, { ...existing, amountCents: 2310, version: 4 }),
    );
    await slowPress(save());
    await screen.findByText(/You're offline/);
    const button = save();
    lateClick(button);
    lateClick(button);
    await waitFor(() => {
      expect(sheetOpen()).toBe(false);
    });
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.body).toEqual(puts()[0]?.body);
    expect(puts()[0]?.body).toMatchObject({ version: 3 });
  });
});

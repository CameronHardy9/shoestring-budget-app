import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

const sheet = () => screen.getByTestId("quick-add-sheet");
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
        .map((r) => r.closest("label")?.textContent ?? "");
    const before = names();
    // Another member adds "Pets", which would sort first on its own.
    view.client.setQueryData(keys.categories(BUDGET_ID), {
      items: [{ ...category(9, "Pets"), sortOrder: 0 }, ...categories],
    });
    await waitFor(() => {
      expect(names()).toEqual([...before, "Pets"]);
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
    await userEvent.click(
      screen.getByRole("button", { name: "Put the rest on Household" }),
    );
    expect(screen.getByTestId("split-left-to-assign")).toHaveTextContent(
      "Fully assigned",
    );
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

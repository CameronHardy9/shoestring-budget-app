// Phase 2b screens: behaviour against the contract, plus axe on each screen.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi } from "../test/api-mock.ts";
import { expectNoAxeViolations } from "../test/axe.ts";
import {
  budget,
  BUDGET_ID,
  categories,
  me,
  members,
  plan,
  session,
  summary,
  uuid,
} from "../test/fixtures.ts";
import { renderWithApp } from "../test/render.tsx";
import { BudgetLayout } from "./budget/BudgetLayout.tsx";
import CategoriesScreen from "./budget/CategoriesScreen.tsx";
import MembersScreen from "./budget/MembersScreen.tsx";
import InvitationsScreen from "./InvitationsScreen.tsx";
import MoreScreen from "./MoreScreen.tsx";
import AccountScreen from "./settings/AccountScreen.tsx";
import DeletedBudgetsScreen from "./settings/DeletedBudgetsScreen.tsx";
import SecurityScreen from "./settings/SecurityScreen.tsx";
import SessionsScreen from "./settings/SessionsScreen.tsx";

const B = `/budgets/${BUDGET_ID}`;
const budgetBase = {
  [`GET ${B}`]: json(200, budget),
  [`GET ${B}/categories`]: json(200, { items: categories }),
  [`GET ${B}/months/:month/plan`]: json(200, plan()),
  [`GET ${B}/months/:month/summary`]: json(200, summary),
  [`GET ${B}/transactions`]: json(200, { items: [], nextCursor: null }),
  "GET /budgets": json(200, { items: [budget] }),
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("categories and limits", () => {
  it("lists limits, adds a category with a limit, and copies last month", async () => {
    const api = mockApi({
      ...budgetBase,
      [`POST ${B}/categories`]: json(201, {
        ...categories[0]!,
        id: uuid(50),
        name: "Pets",
        version: 1,
      }),
      [`PUT ${B}/months/2026-11/plan/:categoryId`]: json(201, plan().items[0]),
      [`POST ${B}/months/2026-11/plan/copy-previous`]: json(200, {
        budgetId: BUDGET_ID,
        month: "2026-11",
        sourceMonth: "2026-10",
        copiedCount: 3,
        skippedCount: 1,
        items: [],
      }),
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="budgets">
        <CategoriesScreen />
      </BudgetLayout>,
      { path: `${B}/categories` },
    );
    expect(
      await screen.findByRole("heading", { name: "Categories & limits" }),
    ).toBeInTheDocument();
    const groceries = (await screen.findAllByTestId("category-row"))[0]!;
    expect(groceries).toHaveTextContent("Groceries$600.00");
    expect(screen.queryByText("Old stuff")).toBeNull();
    await expectNoAxeViolations(view.container);

    await userEvent.click(screen.getByTestId("add-category"));
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Pets",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /Limit for November 2026/ }),
      "45",
    );
    await userEvent.click(screen.getByTestId("category-save"));
    await waitFor(() => {
      expect(
        api.find("PUT", `${B}/months/2026-11/plan/${uuid(50)}`)[0]?.body,
      ).toEqual({ amountCents: 4500, version: null });
    });
    expect(api.find("POST", `${B}/categories`)[0]?.body).toEqual({
      name: "Pets",
      kind: "expense",
    });
    expect(await screen.findByText("Added Pets")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("copy-previous"));
    expect(
      await screen.findByText("Copied 3 limits from October"),
    ).toBeInTheDocument();
    expect(
      api.find("POST", `${B}/months/2026-11/plan/copy-previous`)[0]?.body,
    ).toEqual({ overwrite: false });
  });

  it("updates a limit with its version and offers archive when a category is in use", async () => {
    const api = mockApi({
      ...budgetBase,
      [`PUT ${B}/months/2026-11/plan/:categoryId`]: json(200, plan().items[0]),
      [`DELETE ${B}/categories/:categoryId`]: apiError(409, "CATEGORY_IN_USE"),
      [`PATCH ${B}/categories/:categoryId`]: json(200, {
        ...categories[0]!,
        archived: true,
        version: 2,
      }),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="budgets">
        <CategoriesScreen />
      </BudgetLayout>,
      { path: `${B}/categories` },
    );
    await userEvent.click((await screen.findAllByTestId("category-row"))[0]!);
    const limit = await screen.findByRole("textbox", { name: /Limit for/ });
    expect(limit).toHaveValue("600.00");
    await userEvent.clear(limit);
    await userEvent.type(limit, "650");
    await userEvent.click(screen.getByTestId("category-save"));
    await waitFor(() => {
      expect(
        api.find("PUT", `${B}/months/2026-11/plan/${uuid(1)}`)[0]?.body,
      ).toEqual({ amountCents: 65000, version: 2 });
    });
    await userEvent.click((await screen.findAllByTestId("category-row"))[0]!);
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete category" }),
    );
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    expect(
      await screen.findByText(/can't be deleted. Archive it/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Archive instead" }),
    );
    await waitFor(() => {
      expect(api.find("PATCH", `${B}/categories/${uuid(1)}`)[0]?.body).toEqual({
        archived: true,
        version: 1,
      });
    });
  });
});

describe("members", () => {
  // Three tests rather than one long journey: each step (axe, typing, the
  // re-auth dialog) is CPU-bound, and together they outgrew the 5 s test
  // budget when make check runs every package's tests at once.
  function renderOwnerMembers(routes: Parameters<typeof mockApi>[0] = {}) {
    const api = mockApi({
      ...budgetBase,
      [`GET ${B}/members`]: json(200, { items: members }),
      [`GET ${B}/invitations`]: json(200, { items: [] }),
      ...routes,
    });
    const view = renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="budgets">
        <MembersScreen />
      </BudgetLayout>,
      { path: `${B}/members` },
    );
    return { api, view };
  }

  it("shows the owner the members, with no axe violations", async () => {
    const { view } = renderOwnerMembers();
    expect(await screen.findByText("Alex (you)")).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });

  it("lets the owner invite, re-authenticating first", async () => {
    let calls = 0;
    const { api } = renderOwnerMembers({
      [`POST ${B}/invitations`]: () =>
        ++calls === 1
          ? apiError(403, "REAUTH_REQUIRED")
          : json(201, {
              id: uuid(70),
              budgetId: BUDGET_ID,
              email: "pat@example.com",
              status: "pending",
              invitedByDisplayName: "Alex",
              createdAt: "2026-11-14T00:00:00.000Z",
              expiresAt: "2026-11-28T00:00:00.000Z",
              respondedAt: null,
            }),
      "POST /auth/reauth": json(200, {
        reauthenticatedUntil: "2026-11-14T15:14:05.000Z",
      }),
    });
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Invite by email" }),
      "pat@example.com",
    );
    await userEvent.click(screen.getByTestId("send-invitation"));
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Invitation sent")).toBeInTheDocument();
    expect(api.find("POST", `${B}/invitations`)[1]?.body).toEqual({
      email: "pat@example.com",
    });
  });

  it("lets the owner transfer ownership after confirming", async () => {
    const { api } = renderOwnerMembers({
      [`POST ${B}/transfer-ownership`]: json(200, {
        ...budget,
        myRole: "member",
      }),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Make owner" }),
    );
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    await waitFor(() => {
      expect(api.find("POST", `${B}/transfer-ownership`)[0]?.body).toEqual({
        userId: uuid(902),
      });
    });
  });

  it("shows a member only the list and Leave", async () => {
    const api = mockApi({
      ...budgetBase,
      [`GET ${B}`]: json(200, { ...budget, myRole: "member" }),
      [`GET ${B}/members`]: json(200, { items: members }),
      [`DELETE ${B}/members/:userId`]: json(204),
    });
    renderWithApp(
      <BudgetLayout budgetId={BUDGET_ID} active="budgets">
        <MembersScreen />
      </BudgetLayout>,
      { path: `${B}/members` },
    );
    await userEvent.click(await screen.findByTestId("leave-budget"));
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByTestId("send-invitation")).toBeNull();
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    await waitFor(() => {
      expect(api.find("DELETE", `${B}/members/${me.id}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });
});

describe("account-level screens", () => {
  it("accepts and declines invitations", async () => {
    const inv = {
      id: uuid(80),
      budgetId: uuid(81),
      budgetName: "Beach house",
      invitedByDisplayName: "Jo",
      expiresAt: "2026-11-28T00:00:00.000Z",
    };
    const api = mockApi({
      "GET /me/invitations": json(200, { items: [inv] }),
      "POST /me/invitations/:id/decline": json(204),
      "POST /me/invitations/:id/accept": json(200, {
        ...budget,
        id: uuid(81),
        name: "Beach house",
      }),
    });
    const view = renderWithApp(<InvitationsScreen />, { path: "/invitations" });
    await screen.findByText("Beach house");
    await expectNoAxeViolations(view.container);
    await userEvent.click(
      screen.getByRole("button", { name: "Decline invitation to Beach house" }),
    );
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    await waitFor(() => {
      expect(
        api.find("POST", `/me/invitations/${uuid(80)}/decline`),
      ).toHaveLength(1);
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Accept invitation to Beach house" }),
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/budgets/${uuid(81)}`);
    });
  });

  it("lists devices and signs out the others", async () => {
    const api = mockApi({
      "GET /me/sessions": json(200, {
        items: [
          {
            id: uuid(901),
            current: true,
            browser: "safari",
            os: "ios",
            createdAt: "2026-11-01T00:00:00.000Z",
            lastSeenAt: "2026-11-14T00:00:00.000Z",
            expiresAt: "2026-12-14T00:00:00.000Z",
          },
          {
            id: uuid(903),
            current: false,
            browser: "chrome",
            os: "windows",
            createdAt: "2026-11-02T00:00:00.000Z",
            lastSeenAt: "2026-11-03T00:00:00.000Z",
            expiresAt: "2026-12-03T00:00:00.000Z",
          },
        ],
      }),
      "POST /me/sessions/revoke-others": json(204),
    });
    const view = renderWithApp(<SessionsScreen />, {
      path: "/settings/sessions",
    });
    expect(await screen.findByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getByText("· This device")).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await userEvent.click(screen.getByTestId("revoke-others"));
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    await waitFor(() => {
      expect(api.find("POST", "/me/sessions/revoke-others")).toHaveLength(1);
    });
  });

  it("changes email and password, exports CSV and explains a blocked deletion", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }),
    );
    const api = mockApi({
      "POST /me/email-change": json(202),
      "POST /me/password": json(204),
      "POST /me/export": {
        status: 200,
        body: "date,amount\n",
        headers: { "Content-Type": "text/csv" },
      },
      "POST /me/deletion": apiError(409, "OWNS_SHARED_BUDGET"),
    });
    const view = renderWithApp(<AccountScreen />, {
      path: "/settings/account",
    });
    await expectNoAxeViolations(view.container);
    await userEvent.type(
      screen.getByRole("textbox", { name: "New email" }),
      "new@example.com",
    );
    await userEvent.click(screen.getByTestId("change-email"));
    expect(
      await screen.findByText(/Check new@example.com/),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("New password"),
      "a brand new password",
    );
    await userEvent.type(
      screen.getByLabelText("New password again"),
      "a different one",
    );
    await userEvent.click(screen.getByTestId("change-password"));
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(api.find("POST", "/me/password")).toHaveLength(0);
    await userEvent.click(screen.getByTestId("export-transactions"));
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
    });
    const exp = api.find("POST", "/me/export")[0];
    expect(exp?.body).toEqual({ kind: "transactions" });
    expect(exp?.headers.get("Accept")).toBe("text/csv");
    await userEvent.click(screen.getByTestId("delete-account"));
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    expect(
      await screen.findByText(/You own a budget other people use/),
    ).toBeInTheDocument();
  });

  it("removes a factor and regenerates recovery codes", async () => {
    const codes = Array.from(
      { length: 10 },
      (_, i) => `abcd${String(i)}-12345`,
    );
    const api = mockApi({
      "GET /me/mfa": json(200, {
        enabled: true,
        totp: { enabled: true, confirmedAt: "2026-11-01T00:00:00.000Z" },
        passkeys: [
          {
            id: uuid(60),
            name: "iPhone",
            createdAt: "2026-11-01T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
        recoveryCodesRemaining: 2,
      }),
      "DELETE /me/mfa/totp": json(204),
      "POST /me/mfa/recovery-codes": json(200, { recoveryCodes: codes }),
      "GET /auth/session": json(200, {
        state: "authenticated",
        user: me,
        session,
        csrfToken: "c".repeat(43),
      }),
    });
    const view = renderWithApp(<SecurityScreen />, {
      path: "/settings/security",
    });
    expect(await screen.findByText(/2 of 10 left/)).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await userEvent.click(screen.getByTestId("remove-totp"));
    expect(
      screen.getByText("You'll still have your other second step."),
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByTestId(
        "confirm-action",
      ),
    );
    await waitFor(() => {
      expect(api.find("DELETE", "/me/mfa/totp")).toHaveLength(1);
    });
    await userEvent.click(screen.getByTestId("regenerate-codes"));
    expect(await screen.findByTestId("recovery-codes")).toHaveTextContent(
      "abcd0-12345",
    );
  });

  it("restores a deleted budget", async () => {
    const api = mockApi({
      "GET /me/deleted-budgets": json(200, {
        items: [
          {
            id: BUDGET_ID,
            name: "Home",
            deletedAt: "2026-11-10T00:00:00.000Z",
            restorableUntil: "2026-12-10T00:00:00.000Z",
            memberCount: 2,
          },
        ],
      }),
      [`POST /me/deleted-budgets/${BUDGET_ID}/restore`]: json(200, budget),
    });
    const view = renderWithApp(<DeletedBudgetsScreen />, {
      path: "/settings/deleted-budgets",
    });
    await screen.findByText("Home");
    await expectNoAxeViolations(view.container);
    await userEvent.click(screen.getByRole("button", { name: "Restore Home" }));
    await waitFor(() => {
      expect(
        api.find("POST", `/me/deleted-budgets/${BUDGET_ID}/restore`),
      ).toHaveLength(1);
    });
  });

  it("switches the theme from More", async () => {
    mockApi({ "GET /budgets": json(200, { items: [budget] }) });
    const view = renderWithApp(<MoreScreen />, { path: "/more" });
    await screen.findByText("Home");
    await expectNoAxeViolations(view.container);
    await userEvent.click(screen.getByText("Dark", { exact: true }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("shoestring.theme")).toBe("dark");
    await userEvent.click(screen.getByText("Automatic", { exact: true }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

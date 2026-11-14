// The auth guard, return-after-sign-in, MFA at sign-in, pending deletion and
// sign-up from an emailed link, through the real App with a mocked API.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { getCsrfToken } from "./api/session.ts";
import { App } from "./App.tsx";
import { queryClient } from "./app/query.ts";
import { captureLinkToken } from "./lib/link-token.ts";
import { apiError, json, mockApi } from "./test/api-mock.ts";
import {
  authenticated,
  budget,
  BUDGET_ID,
  categories,
  CSRF,
  me,
  summary,
} from "./test/fixtures.ts";

const budgetRoutes = {
  [`GET /budgets/${BUDGET_ID}`]: json(200, budget),
  [`GET /budgets/${BUDGET_ID}/categories`]: json(200, { items: categories }),
  [`GET /budgets/${BUDGET_ID}/months/:month/summary`]: json(200, summary),
  [`GET /budgets/${BUDGET_ID}/transactions`]: json(200, {
    items: [],
    nextCursor: null,
  }),
  "GET /budgets": json(200, { items: [budget] }),
};

afterEach(() => {
  queryClient.clear();
  localStorage.clear();
});

function start(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

describe("auth guard", () => {
  it("sends a signed-out visitor to sign-in and back to where they were", async () => {
    let signedIn = false;
    const api = mockApi({
      ...budgetRoutes,
      "GET /auth/session": () =>
        signedIn ? json(200, authenticated) : apiError(401, "UNAUTHENTICATED"),
      "POST /auth/login": () => {
        signedIn = true;
        return json(200, authenticated);
      },
    });
    start(`/budgets/${BUDGET_ID}/transactions?month=2026-10`);
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/signin");
    expect(window.location.search).toBe("");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Email" }),
      "alex@example.com",
    );
    await userEvent.type(screen.getByLabelText("Password"), "a long password!");
    await userEvent.click(screen.getByTestId("sign-in-submit"));
    expect(
      await screen.findByRole("heading", { name: "Transactions" }),
    ).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(
      `/budgets/${BUDGET_ID}/transactions?month=2026-10`,
    );
    expect(api.find("POST", "/auth/login")[0]?.body).toEqual({
      email: "alex@example.com",
      password: "a long password!",
    });
    expect(getCsrfToken()).toBe(CSRF);
  });

  it("shows the copy for wrong credentials", async () => {
    mockApi({
      "GET /auth/session": apiError(401, "UNAUTHENTICATED"),
      "POST /auth/login": apiError(401, "INVALID_CREDENTIALS"),
    });
    start("/signin");
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "a@example.com",
    );
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByTestId("sign-in-submit"));
    expect(
      await screen.findByText(
        "That email and password don't match. Try again.",
      ),
    ).toBeInTheDocument();
  });

  it("asks for the second factor, then signs in", async () => {
    const api = mockApi({
      ...budgetRoutes,
      "GET /auth/session": apiError(401, "UNAUTHENTICATED"),
      "POST /auth/login": json(200, {
        state: "mfa_required",
        mfaMethods: ["totp", "recovery_code"],
        expiresAt: "2026-11-14T15:14:05.000Z",
        csrfToken: "p".repeat(43),
      }),
      "POST /auth/mfa/verify": json(200, authenticated),
    });
    start("/signin");
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "a@example.com",
    );
    await userEvent.type(screen.getByLabelText("Password"), "a long password!");
    await userEvent.click(screen.getByTestId("sign-in-submit"));
    const code = await screen.findByRole("textbox", { name: /6-digit code/ });
    await userEvent.type(code, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/budgets/${BUDGET_ID}`);
    });
    const verify = api.find("POST", "/auth/mfa/verify")[0];
    expect(verify?.body).toEqual({ method: "totp", code: "123456" });
    expect(verify?.headers.get("X-CSRF-Token")).toBe("p".repeat(43));
  });

  it("sends an account pending deletion to the deletion screen", async () => {
    mockApi({
      "GET /auth/session": json(200, {
        ...authenticated,
        user: {
          ...me,
          deletion: {
            requestedAt: "2026-11-10T00:00:00.000Z",
            purgeAfter: "2026-12-10T00:00:00.000Z",
          },
        },
      }),
      "DELETE /me/deletion": json(200, me),
      ...budgetRoutes,
    });
    start(`/budgets/${BUDGET_ID}`);
    expect(
      await screen.findByRole("heading", {
        name: "Account scheduled for deletion",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Keep my account" }),
    );
    expect(await screen.findByTestId("total-remaining")).toHaveTextContent(
      "$164.45",
    );
  });

  it("shows one not-found screen for a budget the API hides", async () => {
    mockApi({
      "GET /auth/session": json(200, authenticated),
      [`GET /budgets/${BUDGET_ID}`]: apiError(404, "NOT_FOUND"),
    });
    start(`/budgets/${BUDGET_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Budget not found" }),
    ).toBeInTheDocument();
  });

  it("sends a new account without budgets to onboarding", async () => {
    let created = false;
    const api = mockApi({
      ...budgetRoutes,
      "GET /auth/session": json(200, authenticated),
      "GET /budgets": () => json(200, { items: created ? [budget] : [] }),
      "POST /budgets": () => {
        created = true;
        return json(201, budget);
      },
    });
    start("/");
    expect(
      await screen.findByRole("heading", { name: "Set up your budget" }),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Monthly limit for Groceries" }),
      "600",
    );
    await userEvent.click(screen.getByTestId("create-budget"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/budgets/${BUDGET_ID}`);
    });
    const post = api.find("POST", "/budgets")[0];
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    const body = post?.body as { name: string; categories: unknown[] };
    expect(body.name).toBe("Home");
    expect(body.categories).toContainEqual({
      name: "Groceries",
      kind: "expense",
      plannedCents: 60000,
    });
  });
});

describe("emailed links", () => {
  it("signs up from an invite without the token ever staying in the URL", async () => {
    const token = "T".repeat(43);
    const api = mockApi({
      "GET /auth/session": apiError(401, "UNAUTHENTICATED"),
      "POST /auth/signup/preview": json(200, {
        email: "new@example.com",
        expiresAt: "2026-11-21T00:00:00.000Z",
      }),
      "POST /auth/signup": json(201, authenticated),
      "GET /budgets": json(200, { items: [] }),
    });
    window.history.replaceState(null, "", `/signup#token=${token}`);
    captureLinkToken(window.location, window.history);
    expect(window.location.hash).toBe("");
    render(<App />);
    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "Sam",
    );
    await userEvent.type(
      screen.getByLabelText("Password", { selector: "input" }),
      "twelve chars ok",
    );
    await userEvent.click(screen.getByTestId("sign-up-submit"));
    expect(
      await screen.findByRole("heading", { name: "Set up your budget" }),
    ).toBeInTheDocument();
    expect(api.find("POST", "/auth/signup")[0]?.body).toEqual({
      token,
      displayName: "Sam",
      password: "twelve chars ok",
    });
  });

  it("explains an invalid invitation", async () => {
    mockApi({
      "GET /auth/session": apiError(401, "UNAUTHENTICATED"),
      "POST /auth/signup/preview": apiError(400, "INVITATION_INVALID"),
    });
    window.history.replaceState(null, "", `/signup#token=${"U".repeat(43)}`);
    captureLinkToken(window.location, window.history);
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Invitation not valid" }),
    ).toBeInTheDocument();
  });
});

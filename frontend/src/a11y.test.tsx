// Accessibility sweep: every route renders through the real App and guard,
// with one <h1>, a main landmark, and no serious/critical axe violations.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { queryClient } from "./app/query.ts";
import { apiError, json, mockApi } from "./test/api-mock.ts";
import { expectNoAxeViolations } from "./test/axe.ts";
import {
  authenticated,
  budget,
  BUDGET_ID,
  categories,
  members,
  plan,
  summary,
  transaction,
} from "./test/fixtures.ts";

const B = `/budgets/${BUDGET_ID}`;
const signedInApi = {
  "GET /auth/session": json(200, authenticated),
  "GET /budgets": json(200, { items: [budget] }),
  [`GET ${B}`]: json(200, budget),
  [`GET ${B}/categories`]: json(200, { items: categories }),
  [`GET ${B}/months/:month/plan`]: json(200, plan()),
  [`GET ${B}/months/:month/summary`]: json(200, summary),
  [`GET ${B}/transactions`]: json(200, {
    items: [transaction(1, { payee: "Shop" })],
    nextCursor: null,
  }),
  [`GET ${B}/members`]: json(200, { items: members }),
  [`GET ${B}/invitations`]: json(200, { items: [] }),
  "GET /me/invitations": json(200, { items: [] }),
  "GET /me/sessions": json(200, { items: [] }),
  "GET /me/deleted-budgets": json(200, { items: [] }),
  "GET /me/mfa": json(200, {
    enabled: false,
    totp: { enabled: false, confirmedAt: null },
    passkeys: [],
    recoveryCodesRemaining: 0,
  }),
};

afterEach(() => {
  queryClient.clear();
});

async function check(path: string, heading: RegExp | string) {
  window.history.replaceState(null, "", path);
  const view = render(<App />);
  expect(
    await screen.findByRole(
      "heading",
      { level: 1, name: heading },
      { timeout: 3000 },
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(view.container.querySelector("main")).not.toBeNull();
  await expectNoAxeViolations(view.container);
}

describe("signed-out screens", () => {
  it.each([
    ["/signin", "Sign in"],
    ["/reset-password", "Reset your password"],
    ["/signup", "Invitation not valid"],
    ["/cancel-email-change", "Link not valid"],
    ["/nowhere", "Page not found"],
  ])("%s", async (path, heading) => {
    mockApi({ "GET /auth/session": apiError(401, "UNAUTHENTICATED") });
    await check(path, heading);
  });
});

describe("signed-in screens", () => {
  it.each([
    [B, "November"],
    [`${B}/transactions`, "Transactions"],
    [`${B}/categories`, "Categories & limits"],
    [`${B}/members`, "Members & settings"],
    ["/budgets/new", "Set up your budget"],
    ["/more", "More"],
    ["/invitations", "Invitations"],
    ["/settings/account", "Account"],
    ["/settings/security", "Security"],
    ["/settings/sessions", "Signed-in devices"],
    ["/settings/deleted-budgets", "Deleted budgets"],
    ["/confirm-email", "Link not valid"],
  ])("%s", async (path, heading) => {
    mockApi(signedInApi);
    await check(path, heading);
  });
});

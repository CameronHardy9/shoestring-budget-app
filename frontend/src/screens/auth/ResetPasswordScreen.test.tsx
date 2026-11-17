// Password reset from an emailed link (auth.md §8): the second factor is
// asked for even when MFA was turned on after the link was checked.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { captureLinkToken } from "../../lib/link-token.ts";
import { apiError, json, mockApi } from "../../test/api-mock.ts";
import { renderWithApp } from "../../test/render.tsx";
import ResetPasswordScreen from "./ResetPasswordScreen.tsx";

const TOKEN = "R".repeat(43);

function openLink() {
  window.history.replaceState(null, "", `/reset-password#token=${TOKEN}`);
  captureLinkToken(window.location, window.history);
  return renderWithApp(<ResetPasswordScreen />, {
    auth: { kind: "signedOut" },
    path: "/reset-password",
  });
}

describe("reset password", () => {
  it("moves to the MFA step on MFA_REQUIRED, with methods from a fresh link check", async () => {
    let checks = 0;
    const api = mockApi({
      "POST /auth/password-reset/verify": () =>
        ++checks === 1
          ? json(200, { mfaRequired: false, mfaMethods: [] })
          : json(200, { mfaRequired: true, mfaMethods: ["totp"] }),
      "POST /auth/password-reset/complete": (req) =>
        (req.body as { mfa?: unknown }).mfa
          ? json(204)
          : apiError(401, "MFA_REQUIRED"),
    });
    openLink();
    await userEvent.type(
      await screen.findByLabelText("New password", { selector: "input" }),
      "a brand new password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    const code = await screen.findByRole("textbox", { name: /6-digit code/ });
    expect(screen.queryByTestId("form-error")).not.toBeInTheDocument();
    expect(checks).toBe(2);
    await userEvent.type(code, "123456");
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Password changed" }),
    ).toBeInTheDocument();
    expect(
      api.find("POST", "/auth/password-reset/complete").map((r) => r.body),
    ).toEqual([
      { token: TOKEN, newPassword: "a brand new password" },
      {
        token: TOKEN,
        newPassword: "a brand new password",
        mfa: { method: "totp", code: "123456" },
      },
    ]);
  });

  it("never copies the link token into the query cache (F-50)", async () => {
    mockApi({
      "POST /auth/password-reset/verify": json(200, {
        mfaRequired: false,
        mfaMethods: [],
      }),
    });
    const { client } = openLink();
    await screen.findByLabelText("New password", { selector: "input" });
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys).toEqual([["reset-verify"]]);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(TOKEN);
  });

  it("shows the error when the fresh check still lists no second factor", async () => {
    mockApi({
      "POST /auth/password-reset/verify": json(200, {
        mfaRequired: false,
        mfaMethods: [],
      }),
      "POST /auth/password-reset/complete": apiError(401, "MFA_REQUIRED"),
    });
    openLink();
    await userEvent.type(
      await screen.findByLabelText("New password", { selector: "input" }),
      "a brand new password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    expect(await screen.findByTestId("form-error")).toHaveTextContent(
      "Confirm it's you with your second factor to continue.",
    );
    expect(
      screen.queryByRole("textbox", { name: /6-digit code/ }),
    ).not.toBeInTheDocument();
  });
});

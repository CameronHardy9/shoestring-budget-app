import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { api, unwrap } from "../api/client.ts";
import { apiError, json, mockApi } from "../test/api-mock.ts";
import { me, session } from "../test/fixtures.ts";
import { renderWithApp } from "../test/render.tsx";
import { ReauthCancelled, useReauth } from "./reauth.tsx";

function Sensitive() {
  const reauth = useReauth();
  const [result, setResult] = useState("idle");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          reauth(() => unwrap(api.POST("/me/mfa/totp")))
            .then(() => {
              setResult("done");
            })
            .catch((e: unknown) => {
              setResult(e instanceof ReauthCancelled ? "cancelled" : "failed");
            });
        }}
      >
        Do it
      </button>
      <p>{result}</p>
    </>
  );
}

const setup = {
  secret: "JBSWY3DPEHPK3PXP",
  otpauthUri: "otpauth://totp/x",
  expiresAt: "2026-11-14T15:14:05.000Z",
};

describe("re-authentication", () => {
  it("asks for the password on REAUTH_REQUIRED and retries once", async () => {
    let calls = 0;
    const mock = mockApi({
      "POST /me/mfa/totp": () =>
        ++calls === 1 ? apiError(403, "REAUTH_REQUIRED") : json(200, setup),
      "POST /auth/reauth": json(200, {
        reauthenticatedUntil: "2026-11-14T15:14:05.000Z",
      }),
    });
    renderWithApp(<Sensitive />);
    await userEvent.click(screen.getByRole("button", { name: "Do it" }));
    const dialog = await screen.findByTestId("reauth-dialog");
    expect(dialog).toHaveTextContent("Confirm it's you");
    await userEvent.type(screen.getByLabelText("Password"), "my password");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(mock.find("POST", "/auth/reauth")[0]?.body).toEqual({
      password: "my password",
    });
    expect(calls).toBe(2);
  });

  it("collects the second factor when the account has MFA", async () => {
    let calls = 0;
    const mock = mockApi({
      "POST /me/mfa/totp": () =>
        ++calls === 1 ? apiError(403, "REAUTH_REQUIRED") : json(200, setup),
      "POST /auth/reauth": json(200, {
        reauthenticatedUntil: "2026-11-14T15:14:05.000Z",
      }),
    });
    renderWithApp(<Sensitive />, {
      auth: {
        kind: "signedIn",
        session,
        me: {
          ...me,
          mfa: {
            enabled: true,
            totp: true,
            passkeyCount: 0,
            recoveryCodesRemaining: 9,
          },
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Do it" }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(
      await screen.findByRole("textbox", { name: /6-digit code/ }),
      "654321",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(mock.find("POST", "/auth/reauth")[0]?.body).toEqual({
      password: "pw",
      mfa: { method: "totp", code: "654321" },
    });
  });

  it("shows wrong passwords and can be cancelled", async () => {
    mockApi({
      "POST /me/mfa/totp": apiError(403, "REAUTH_REQUIRED"),
      "POST /auth/reauth": apiError(401, "INVALID_CREDENTIALS"),
    });
    renderWithApp(<Sensitive />);
    await userEvent.click(screen.getByRole("button", { name: "Do it" }));
    await userEvent.type(await screen.findByLabelText("Password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/don't match/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.getByText("cancelled")).toBeInTheDocument();
    });
  });
});

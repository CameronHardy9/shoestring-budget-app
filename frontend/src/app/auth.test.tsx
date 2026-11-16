// Sign-out is only "done" when the server confirmed it (F-51).
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { getCsrfToken } from "../api/session.ts";
import {
  SIGN_OUT_FAILED,
  SIGN_OUT_OFFLINE,
  SignOutButton,
} from "../components/SignOutButton.tsx";
import { apiError, json, mockApi } from "../test/api-mock.ts";
import { CSRF } from "../test/fixtures.ts";
import { renderWithApp } from "../test/render.tsx";
import { hardNavigation, SignOutError, useAuth } from "./auth.tsx";

function Screen() {
  const { status } = useAuth();
  return (
    <>
      <p data-testid="auth-kind">{status.kind}</p>
      <SignOutButton />
    </>
  );
}

function setup(reply: Parameters<typeof mockApi>[0][string]) {
  const replace = vi
    .spyOn(hardNavigation, "replace")
    .mockImplementation(() => undefined);
  const api = mockApi({ "POST /auth/logout": reply });
  renderWithApp(<Screen />, { path: "/more" });
  return { replace, api };
}

const signOut = () =>
  userEvent.click(screen.getByRole("button", { name: "Sign out" }));

describe("sign-out (F-51)", () => {
  it("leaves for /signin when the server signs the session out (204)", async () => {
    const { replace, api } = setup(json(204));
    await signOut();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/signin");
    });
    expect(getCsrfToken()).toBeNull();
    expect(
      api.find("POST", "/auth/logout")[0]?.headers.get("X-CSRF-Token"),
    ).toBe(CSRF);
  });

  it("treats 401 UNAUTHENTICATED as already signed out", async () => {
    const { replace } = setup(apiError(401, "UNAUTHENTICATED"));
    await signOut();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/signin");
    });
    expect(getCsrfToken()).toBeNull();
  });

  it("stays signed in and says so when offline, then retries", async () => {
    let attempt = 0;
    const { replace } = setup(() =>
      ++attempt === 1 ? new TypeError("Failed to fetch") : json(204),
    );
    await signOut();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      SIGN_OUT_OFFLINE,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-kind")).toHaveTextContent("signedIn");
    expect(getCsrfToken()).toBe(CSRF);
    expect(window.location.pathname).toBe("/more");

    await signOut();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/signin");
    });
    expect(screen.queryByTestId("sign-out-error")).not.toBeInTheDocument();
  });

  it.each([
    ["503 UNAVAILABLE", apiError(503, "UNAVAILABLE")],
    ["500 INTERNAL", apiError(500, "INTERNAL")],
    ["403 CSRF_FAILED", apiError(403, "CSRF_FAILED")],
  ])("stays signed in on %s and shows the request ID", async (_, reply) => {
    const { replace } = setup(reply);
    await signOut();
    const error = await screen.findByTestId("sign-out-error");
    expect(error).toHaveTextContent(SIGN_OUT_FAILED);
    expect(error).toHaveTextContent("test-req-0001");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-kind")).toHaveTextContent("signedIn");
    expect(getCsrfToken()).toBe(CSRF);
  });

  it("stays signed in on a non-contract answer (a proxy's 502 page)", async () => {
    const { replace } = setup(json(502, "Bad gateway"));
    await signOut();
    expect(await screen.findByTestId("sign-out-error")).toHaveTextContent(
      SIGN_OUT_FAILED,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-kind")).toHaveTextContent("signedIn");
  });
});

describe("signOut({ revoked: true })", () => {
  function Revoked() {
    const { signOut } = useAuth();
    const [result, setResult] = useState("idle");
    return (
      <button
        type="button"
        onClick={() => {
          signOut({ revoked: true }).then(
            () => {
              setResult("left");
            },
            (e: unknown) => {
              setResult(e instanceof SignOutError ? "failed" : "other");
            },
          );
        }}
      >
        {result}
      </button>
    );
  }

  it("leaves even if the logout call fails, because the session is already revoked", async () => {
    const replace = vi
      .spyOn(hardNavigation, "replace")
      .mockImplementation(() => undefined);
    mockApi({ "POST /auth/logout": new TypeError("Failed to fetch") });
    renderWithApp(<Revoked />);
    await userEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(await screen.findByRole("button", { name: "left" })).toBeVisible();
    expect(replace).toHaveBeenCalledWith("/signin");
  });

  it("without it, rejects with SignOutError and keeps the cause", async () => {
    mockApi({ "POST /auth/logout": apiError(503, "UNAVAILABLE") });
    let caught: unknown = null;
    function Plain() {
      const { signOut } = useAuth();
      return (
        <button
          type="button"
          onClick={() => {
            signOut().catch((e: unknown) => {
              caught = e;
            });
          }}
        >
          go
        </button>
      );
    }
    renderWithApp(<Plain />);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => {
      expect(caught).toBeInstanceOf(SignOutError);
    });
    expect((caught as SignOutError).cause).toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});

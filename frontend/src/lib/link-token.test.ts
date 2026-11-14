import { describe, expect, it, vi } from "vitest";
import { captureLinkToken, takeLinkToken } from "./link-token.ts";

const TOKEN = "A".repeat(43);

function fakeHistory() {
  return { state: { k: 1 }, replaceState: vi.fn() };
}

describe("captureLinkToken", () => {
  it("moves the token into memory and strips the fragment", () => {
    const history = fakeHistory();
    const result = captureLinkToken(
      { hash: `#token=${TOKEN}`, pathname: "/signup", search: "" },
      history,
    );
    expect(result).toEqual({ path: "/signup", token: TOKEN });
    expect(history.replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/signup");
    expect(takeLinkToken("/reset-password")).toBeNull();
    expect(takeLinkToken("/signup")).toBe(TOKEN);
    expect(takeLinkToken("/signup")).toBeNull();
  });

  it("does nothing without a fragment", () => {
    const history = fakeHistory();
    expect(
      captureLinkToken({ hash: "", pathname: "/", search: "" }, history),
    ).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("strips fragments that hold no valid token, keeping the query", () => {
    const history = fakeHistory();
    expect(
      captureLinkToken(
        { hash: "#token=short", pathname: "/x", search: "?a=1" },
        history,
      ),
    ).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/x?a=1");
    expect(
      captureLinkToken({ hash: "#other", pathname: "/x", search: "" }, history),
    ).toBeNull();
  });
});

describe("peekLinkToken", () => {
  it("reads without consuming until cleared", async () => {
    const { peekLinkToken, clearLinkToken } = await import("./link-token.ts");
    captureLinkToken(
      { hash: `#token=${TOKEN}`, pathname: "/confirm-email", search: "" },
      fakeHistory(),
    );
    expect(peekLinkToken("/confirm-email")).toBe(TOKEN);
    expect(peekLinkToken("/confirm-email")).toBe(TOKEN);
    expect(peekLinkToken("/signup")).toBeNull();
    clearLinkToken();
    expect(peekLinkToken("/confirm-email")).toBeNull();
  });
});

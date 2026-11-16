import { describe, expect, it } from "vitest";
import {
  forgetReturnPathUnlessFor,
  rememberReturnPath,
  safeReturnPath,
  takeReturnPath,
} from "./return-path.ts";

describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/settings/sessions", "/settings/sessions"],
    [
      "/budgets/0194f5c2-0000-7000-8000-000000000001",
      "/budgets/0194f5c2-0000-7000-8000-000000000001",
    ],
    ["/transactions?month=2026-11", "/transactions?month=2026-11"],
    ["/reset-password#token=abc", "/reset-password"],
  ])("accepts %j", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it.each([
    "//evil.example/x",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "settings",
    "",
    "/ space",
    "/tab\there",
    "/new\nline",
    `/${"a".repeat(2050)}`,
    42,
    null,
    undefined,
  ])("rejects %j", (input) => {
    expect(safeReturnPath(input)).toBeNull();
  });
});

describe("remembered return path", () => {
  const A = "user-a";
  const B = "user-b";

  it("is taken once", () => {
    rememberReturnPath("/invitations", A);
    expect(takeReturnPath(A)).toBe("/invitations");
    expect(takeReturnPath(A)).toBeNull();
  });

  it("drops unsafe values", () => {
    rememberReturnPath("//evil.example", A);
    expect(takeReturnPath(A)).toBeNull();
  });

  it("is only for the user who left it (F-54), and is gone after another user's try", () => {
    rememberReturnPath("/budgets/x", A);
    expect(takeReturnPath(B)).toBeNull();
    expect(takeReturnPath(A)).toBeNull();
  });

  it("is for anyone when nobody had signed in in this tab (a deep link)", () => {
    rememberReturnPath("/budgets/x", null);
    expect(takeReturnPath(B)).toBe("/budgets/x");
  });

  it("is forgotten when a different user signs in", () => {
    rememberReturnPath("/budgets/x", A);
    forgetReturnPathUnlessFor(A);
    expect(takeReturnPath(A)).toBe("/budgets/x");

    rememberReturnPath("/budgets/x", A);
    forgetReturnPathUnlessFor(B);
    expect(takeReturnPath(A)).toBeNull();

    rememberReturnPath("/budgets/y", null);
    forgetReturnPathUnlessFor(B);
    expect(takeReturnPath(B)).toBe("/budgets/y");
  });
});

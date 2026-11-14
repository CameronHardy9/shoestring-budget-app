import { describe, expect, it } from "vitest";
import {
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
  it("is taken once", () => {
    rememberReturnPath("/invitations");
    expect(takeReturnPath()).toBe("/invitations");
    expect(takeReturnPath()).toBeNull();
  });
  it("drops unsafe values", () => {
    rememberReturnPath("//evil.example");
    expect(takeReturnPath()).toBeNull();
  });
});

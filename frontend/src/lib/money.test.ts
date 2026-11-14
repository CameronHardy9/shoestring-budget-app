import { describe, expect, it } from "vitest";
import {
  centsToDecimalString,
  centsToInputString,
  formatCents,
  MAX_CENTS,
  parseMoneyInput,
} from "./money.ts";

describe("parseMoneyInput", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    ["12.", 1200],
    [".99", 99],
    ["0.01", 1],
    ["$1,234.56", 123456],
    [" $ 7.05 ", 705],
    ["1,000,000", MAX_CENTS],
    ["0001.10", 110],
    ["999999.99", 99999999],
  ])("parses %j to %i cents", (input, cents) => {
    expect(parseMoneyInput(input)).toEqual({ ok: true, cents });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["$", "empty"],
    [".", "invalid"],
    ["$.", "invalid"],
    ["abc", "invalid"],
    ["-5", "invalid"],
    ["1e5", "invalid"],
    ["1,23", "invalid"],
    ["12,34.5", "invalid"],
    ["1.2.3", "invalid"],
    ["١٢", "invalid"],
    ["1.234", "too_many_decimals"],
    ["0", "too_small"],
    ["0.00", "too_small"],
    ["1,000,000.01", "too_big"],
    ["99999999999999999999", "too_big"],
  ])("rejects %j as %s", (input, error) => {
    expect(parseMoneyInput(input)).toEqual({ ok: false, error });
  });

  it("honours min and max (plan entries allow zero)", () => {
    expect(parseMoneyInput("0", { min: 0 })).toEqual({ ok: true, cents: 0 });
    expect(parseMoneyInput("5.01", { max: 500 })).toEqual({
      ok: false,
      error: "too_big",
    });
  });

  it("never loses a cent to floating point", () => {
    // 0.1 + 0.2 style inputs that break naive parseFloat(x) * 100.
    expect(parseMoneyInput("0.29")).toEqual({ ok: true, cents: 29 });
    expect(parseMoneyInput("1.15")).toEqual({ ok: true, cents: 115 });
    expect(parseMoneyInput("4.35")).toEqual({ ok: true, cents: 435 });
    expect(parseMoneyInput("1005.99")).toEqual({ ok: true, cents: 100599 });
  });
});

describe("centsToDecimalString", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [1250, "12.50"],
    [-500, "-5.00"],
    [-1, "-0.01"],
    [MAX_CENTS, "1000000.00"],
  ])("%i → %s", (cents, text) => {
    expect(centsToDecimalString(cents)).toBe(text);
  });

  it("rejects non-integers and unsafe integers", () => {
    expect(() => centsToDecimalString(1.5)).toThrow(RangeError);
    expect(() => centsToDecimalString(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      RangeError,
    );
    expect(() => centsToDecimalString(Number.NaN)).toThrow(RangeError);
  });

  it("centsToInputString gives an editable value", () => {
    expect(centsToInputString(8640)).toBe("86.40");
  });
});

describe("formatCents", () => {
  it("formats en-US USD", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-2310)).toBe("-$23.10");
  });

  it("shows a sign on request, but never on zero", () => {
    expect(formatCents(4000, "always")).toBe("+$40.00");
    expect(formatCents(-4000, "always")).toBe("-$40.00");
    expect(formatCents(0, "always")).toBe("$0.00");
    expect(formatCents(-4000, "never")).toBe("$40.00");
  });

  it("is exact at the extremes", () => {
    expect(formatCents(MAX_CENTS)).toBe("$1,000,000.00");
    expect(formatCents(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
  });
});

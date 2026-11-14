// Money is integer USD cents end to end (ADR-0005). This module never does
// floating-point arithmetic on amounts: typed input is parsed digit by digit
// into cents, and display goes through Intl with an exact decimal string.

/** $1,000,000.00, the contract maximum for a transaction, split or plan entry. */
export const MAX_CENTS = 100_000_000;

export type MoneyParseError =
  "empty" | "invalid" | "too_many_decimals" | "too_small" | "too_big";

export type MoneyParseResult =
  { ok: true; cents: number } | { ok: false; error: MoneyParseError };

export interface MoneyParseOptions {
  /** Smallest allowed value in cents (default 1: transactions and splits). */
  min?: number;
  /** Largest allowed value in cents (default MAX_CENTS). */
  max?: number;
}

// Optional "$", then digits with optional US thousands separators, then an
// optional "." and up to two (checked separately) decimal digits. ASCII only.
const MONEY_PATTERN = /^\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/;

/**
 * Parses what a person typed ("12", "12.5", "$1,234.56", ".99") to integer cents.
 * Negative numbers are not accepted: direction (outflow/inflow) carries the sign.
 */
export function parseMoneyInput(
  input: string,
  options: MoneyParseOptions = {},
): MoneyParseResult {
  const { min = 1, max = MAX_CENTS } = options;
  const text = input.trim().replace(/\s+/g, "");
  if (text === "" || text === "$") return { ok: false, error: "empty" };

  if (!MONEY_PATTERN.test(text)) return { ok: false, error: "invalid" };
  const unsigned = text.startsWith("$") ? text.slice(1) : text;
  const dot = unsigned.indexOf(".");
  const whole = (dot === -1 ? unsigned : unsigned.slice(0, dot)).replace(
    /,/g,
    "",
  );
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
  if (whole === "" && fraction === "") return { ok: false, error: "invalid" };
  if (fraction.length > 2) return { ok: false, error: "too_many_decimals" };

  const significant = whole.replace(/^0+/, "");
  // Longer than any allowed amount; reject before converting, so the integer
  // conversion below always stays far inside the safe range.
  if (significant.length > 9) return { ok: false, error: "too_big" };

  const cents =
    Number(significant || "0") * 100 + Number(fraction.padEnd(2, "0"));
  if (cents < min) return { ok: false, error: "too_small" };
  if (cents > max) return { ok: false, error: "too_big" };
  return { ok: true, cents };
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError("Money amounts must be integer cents.");
  }
}

/** Exact decimal string for integer cents: -123456 → "-1234.56". */
export function centsToDecimalString(cents: number): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const rest = abs % 100;
  const dollars = (abs - rest) / 100;
  const sign = cents < 0 ? "-" : "";
  return `${sign}${dollars}.${String(rest).padStart(2, "0")}`;
}

/** Value for an editable amount field: 8640 → "86.40". */
export function centsToInputString(cents: number): string {
  return centsToDecimalString(cents);
}

export type SignDisplay = "auto" | "always" | "never";

const formatters = new Map<SignDisplay, Intl.NumberFormat>();

function formatterFor(sign: SignDisplay): Intl.NumberFormat {
  let formatter = formatters.get(sign);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      signDisplay: sign === "always" ? "exceptZero" : sign,
    });
    formatters.set(sign, formatter);
  }
  return formatter;
}

/**
 * Display text for integer cents, en-US and USD only (ADR-0005):
 * 123456 → "$1,234.56"; -500 → "-$5.00"; with sign "always", 4000 → "+$40.00".
 */
export function formatCents(cents: number, sign: SignDisplay = "auto"): string {
  // Intl formats a decimal string exactly (no binary floating point involved).
  return formatterFor(sign).format(
    centsToDecimalString(cents) as Intl.StringNumericLiteral,
  );
}

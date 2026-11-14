// Month and date rules (ADR-0004, ADR-0005). Pure functions.
// - A transaction's month is the YYYY-MM of its calendar date: no zone math.
// - "Today" is the app clock's instant in the budget's IANA timezone.
// - Allowed transaction dates: 2000-01-01 to one year after today (budget tz).
import { budgetCalendar, isCalendarDate } from "@shoestring/db";
import type { FieldIssue } from "../errors.ts";

export const MIN_TRANSACTION_DATE = "2000-01-01";

/** Same month and day one year later; Feb 29 maps to Feb 28. */
export function oneYearAfter(date: string): string {
  const y = Number(date.slice(0, 4)) + 1;
  const md = date.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${String(y).padStart(4, "0")}-${md === "02-29" && !leap ? "02-28" : md}`;
}

/** The latest date a transaction may have, given the budget's timezone. */
export function maxTransactionDate(now: Date, timezone: string): string {
  return oneYearAfter(budgetCalendar(now, timezone).today);
}

/** null when allowed; otherwise the FieldError issue for `date`. */
export function transactionDateIssue(
  date: string,
  now: Date,
  timezone: string,
): FieldIssue | null {
  if (!isCalendarDate(date)) return "invalid_format";
  if (date < MIN_TRANSACTION_DATE) return "too_small";
  if (date > maxTransactionDate(now, timezone)) return "too_big";
  return null;
}

/** Month containing a calendar date (no timezone conversion). */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

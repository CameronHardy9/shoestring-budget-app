// Calendar helpers (ADR-0005). Transaction dates and months are calendar
// values with no time zone; only "today" depends on the budget's IANA zone.
import { invalid } from "./errors.ts";

/** 'YYYY-MM' as used by the API. */
export type Month = string;
/** 'YYYY-MM-DD' calendar date. */
export type CalendarDate = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isMonth(value: string): boolean {
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= 2000 && year <= 2099;
}

export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

/** Validates an API month and returns the first-of-month DATE string. */
export function monthStart(month: Month, field = "month"): CalendarDate {
  if (!isMonth(month))
    throw invalid({ in: "path", field, issue: "invalid_format" });
  return `${month}-01`;
}

export function monthOfDate(date: CalendarDate): Month {
  return date.slice(0, 7);
}

/** month + n months (n may be negative). */
export function addMonths(month: Month, n: number): Month {
  const m = MONTH_RE.exec(month);
  if (!m)
    throw invalid({ in: "path", field: "month", issue: "invalid_format" });
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/** Half-open range [first day of month, first day of next month). */
export function monthRange(month: Month): {
  from: CalendarDate;
  to: CalendarDate;
} {
  return { from: monthStart(month), to: `${addMonths(month, 1)}-01` };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date of `instant` in the IANA zone `tz` (budget "today"). */
export function dateInTimeZone(instant: Date, tz: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "today" and "current month" of a budget at `instant`. */
export function budgetCalendar(
  instant: Date,
  tz: string,
): { today: CalendarDate; currentMonth: Month } {
  const today = dateInTimeZone(instant, tz);
  return { today, currentMonth: monthOfDate(today) };
}

/** Adds whole days to a calendar date (no time zone involved). */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const m = DATE_RE.exec(date);
  if (!m) throw invalid({ in: "body", field: "date", issue: "invalid_format" });
  const dt = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  );
  return dt.toISOString().slice(0, 10);
}

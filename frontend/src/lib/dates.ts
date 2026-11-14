// Calendar dates (YYYY-MM-DD) and months (YYYY-MM) from the API have no time
// and no zone (ADR-0005). They are formatted as UTC calendar values so the
// device's timezone can never shift a transaction to another day. "Today"
// always comes from the budget (Budget.today), never from the device clock.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

function utcDate(date: string): Date {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`not a calendar date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function utcMonth(month: string): Date {
  const m = MONTH.exec(month);
  if (!m) throw new RangeError(`not a calendar month: ${month}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

const DAY_MS = 86_400_000;

const weekdayDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const monthYear = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
const monthOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
});

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / DAY_MS);
}

/** "Today", "Yesterday", or "Thu, Nov 12", relative to the budget's today. */
export function dayLabel(date: string, today: string): string {
  const diff = daysBetween(date, today);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return weekdayDate.format(utcDate(date));
}

/** "Fri, Nov 14" */
export function shortDate(date: string): string {
  return weekdayDate.format(utcDate(date));
}

/** "November 2026" */
export function monthLabel(month: string): string {
  return monthYear.format(utcMonth(month));
}

/** "November" */
export function monthName(month: string): string {
  return monthOnly.format(utcMonth(month));
}

/** Days left in today's month, counting today. */
export function daysLeftInMonth(today: string): number {
  const d = utcDate(today);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return last - d.getUTCDate() + 1;
}

/** Adjacent month: shiftMonth("2026-12", 1) → "2027-01". */
export function shiftMonth(month: string, delta: number): string {
  const d = utcMonth(month);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

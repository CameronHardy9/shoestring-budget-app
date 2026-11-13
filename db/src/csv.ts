// CSV helpers for the export (data-model.md "CSV export").

/** RFC 4180 cell; user text with a leading = + - @ tab or CR gets a ' prefix. */
export function csvCell(value: string, userText: boolean): string {
  let v = value;
  if (userText && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Integer cents to "12.34" (never negative; no floating point). */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new RangeError("cents must be a non-negative safe integer");
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

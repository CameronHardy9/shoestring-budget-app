import { describe, expect, it } from "vitest";
import {
  dayLabel,
  daysBetween,
  daysLeftInMonth,
  monthLabel,
  monthName,
  shiftMonth,
  shortDate,
} from "./dates.ts";

describe("calendar dates", () => {
  it("labels days relative to the budget's today", () => {
    expect(dayLabel("2026-11-14", "2026-11-14")).toBe("Today");
    expect(dayLabel("2026-11-13", "2026-11-14")).toBe("Yesterday");
    expect(dayLabel("2026-11-12", "2026-11-14")).toBe("Thu, Nov 12");
    expect(dayLabel("2026-11-15", "2026-11-14")).toBe("Sun, Nov 15");
  });

  it("crosses month, year and DST boundaries by calendar day", () => {
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(dayLabel("2026-12-31", "2027-01-01")).toBe("Yesterday");
  });

  it("formats months and dates", () => {
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(monthName("2026-02")).toBe("February");
    expect(shortDate("2026-11-14")).toBe("Sat, Nov 14");
  });

  it("counts days left, including today", () => {
    expect(daysLeftInMonth("2026-11-14")).toBe(17);
    expect(daysLeftInMonth("2026-11-30")).toBe(1);
    expect(daysLeftInMonth("2028-02-01")).toBe(29);
  });

  it("shifts months across years", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("rejects malformed values", () => {
    expect(() => monthLabel("2026-1")).toThrow(RangeError);
    expect(() => shortDate("14/11/2026")).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import { remainderFor, splitBalance, sumCents } from "./splits.ts";

describe("sumCents", () => {
  it("adds integer cents", () => {
    expect(sumCents([])).toBe(0);
    expect(sumCents([1, 2, 3])).toBe(6);
  });
  it("refuses non-integers", () => {
    expect(() => sumCents([1, 0.5])).toThrow(RangeError);
  });
});

describe("splitBalance", () => {
  it("is balanced when splits sum to the total", () => {
    expect(splitBalance(8640, [6000, 2640])).toEqual({ kind: "balanced" });
  });
  it("reports what is left to assign, treating unfinished splits as zero", () => {
    expect(splitBalance(8640, [6000, null])).toEqual({
      kind: "under",
      leftCents: 2640,
    });
  });
  it("reports how far over the splits are", () => {
    expect(splitBalance(1000, [700, 400])).toEqual({
      kind: "over",
      overCents: 100,
    });
  });
});

describe("remainderFor", () => {
  it("gives the amount that balances the splits", () => {
    expect(remainderFor(8640, [6000, 2000, null], 2)).toBe(640);
    expect(remainderFor(8640, [6000, 2000, 99], 2)).toBe(640);
    expect(remainderFor(1000, [null, 200, null], 2)).toBe(800);
  });
  it("is null when nothing is left for that split", () => {
    expect(remainderFor(1000, [1000, null], 1)).toBeNull();
    expect(remainderFor(1000, [1200, null], 1)).toBeNull();
  });
});

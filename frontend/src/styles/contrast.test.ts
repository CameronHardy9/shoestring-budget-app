import { describe, expect, it } from "vitest";
import { contrastRatio, luminance } from "./contrast.ts";

describe("contrastRatio", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
  it("rejects anything but #rrggbb", () => {
    expect(() => luminance("red")).toThrow();
  });
});

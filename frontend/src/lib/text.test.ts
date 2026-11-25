import { describe, expect, it } from "vitest";
import { hasLongWord } from "./text.ts";

describe("hasLongWord", () => {
  it.each(["", "Groceries", "Home repairs, garden and maintenance"])(
    "keeps ordinary words whole: %j",
    (name) => {
      expect(hasLongWord(name)).toBe(false);
    },
  );
  it("counts each word, not the whole name", () => {
    expect(hasLongWord("sixteen-letters! sixteen-letters!")).toBe(false);
    expect(hasLongWord("x".repeat(16))).toBe(false);
    expect(hasLongWord(`Rent ${"x".repeat(17)}`)).toBe(true);
  });
});

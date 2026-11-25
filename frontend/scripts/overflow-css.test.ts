// @vitest-environment node
// The base rule that lets long words break (index.css). jsdom applies no
// stylesheets, so this checks that the rule is there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles/index.css", import.meta.url)),
  "utf8",
);

describe("long words", () => {
  it("break instead of widening the page, except in control labels", () => {
    // Not "anywhere": that would also shrink min-content sizes, and so change
    // how names that fit are laid out.
    expect(css).toMatch(/\n {2}body \{[^}]*overflow-wrap: break-word;/);
    expect(css).toMatch(/\n {2}button \{[^}]*overflow-wrap: normal;/);
  });
});

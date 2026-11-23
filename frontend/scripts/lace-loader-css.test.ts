// @vitest-environment node
// The lace loader's animation and reduced-motion still frame (index.css). jsdom
// applies no stylesheets, so this checks the rules themselves; the rendered
// SVG is covered by src/components/LaceLoader.test.tsx.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles/index.css", import.meta.url)),
  "utf8",
);

/** The body of the first `selector {…}` (no nested braces) after `from`. */
function rule(source: string, selector: string, from = 0): string {
  const start = source.indexOf(`${selector} {`, from);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}

/**
 * `@keyframes name`, as { "55%": { property: value } }, one entry per offset
 * (a selector list such as `94%, 100%` gives each offset the same values).
 */
function keyframes(name: string): Record<string, Record<string, string>> {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(
    css.indexOf("{", start) + 1,
    css.indexOf("\n}", start),
  );
  const out: Record<string, Record<string, string>> = {};
  for (const [, selectors = "", decls = ""] of body.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const values: Record<string, string> = {};
    for (const [, prop = "", value = ""] of decls.matchAll(
      /([a-z-]+):\s*([^;]+);/g,
    )) {
      values[prop] = value.trim();
    }
    for (const offset of selectors.split(",")) out[offset.trim()] = values;
  }
  return out;
}

describe("lace loader styles (index.css)", () => {
  const reduced = css.indexOf(
    "@media (prefers-reduced-motion: reduce)",
    css.indexOf(".ss-lace-tile"),
  );

  it("animates both paths for 3.2 s, forever, with the spec's easing", () => {
    for (const [selector, keyframes] of [
      [".ss-lace-line", "ss-lace-draw"],
      [".ss-lace-tip", "ss-lace-tip"],
    ] as const) {
      expect(rule(css, selector)).toContain(
        `animation: ${keyframes} 3.2s cubic-bezier(0.45, 0, 0.35, 1) infinite;`,
      );
      expect(css).toContain(`@keyframes ${keyframes} {`);
    }
  });

  it("fades the tip out between 50% and 55%, before the hold, and keeps it hidden", () => {
    const tip = keyframes("ss-lace-tip");
    expect(tip).toEqual({
      "0%": { "stroke-dashoffset": "0.03", opacity: "1" },
      "50%": { opacity: "1" },
      "55%": { "stroke-dashoffset": "-0.97", opacity: "0" },
      "100%": { "stroke-dashoffset": "-0.97", opacity: "0" },
    });
  });

  it("draws the lace by 55%, holds, and fades it out from 82% to 94%", () => {
    expect(keyframes("ss-lace-draw")).toEqual({
      "0%": { "stroke-dashoffset": "1", opacity: "1" },
      "55%": { "stroke-dashoffset": "0", opacity: "1" },
      "82%": { "stroke-dashoffset": "0", opacity: "1" },
      "94%": { "stroke-dashoffset": "0", opacity: "0" },
      "100%": { "stroke-dashoffset": "0", opacity: "0" },
    });
  });

  it("under reduced motion shows the finished S, still, without the tip", () => {
    // Its own block: the global base rule only shortens animations, which
    // would leave the lace undrawn.
    expect(reduced).toBeGreaterThan(0);
    const line = rule(css, ".ss-lace-line", reduced);
    expect(line).toContain("animation: none;");
    expect(line).toContain("stroke-dashoffset: 0;");
    expect(line).toContain("opacity: 1;");
    const tip = rule(css, ".ss-lace-tip", reduced);
    expect(tip).toContain("animation: none;");
    expect(tip).toContain("opacity: 0;");
  });
});

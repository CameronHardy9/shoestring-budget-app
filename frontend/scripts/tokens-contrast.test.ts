// @vitest-environment node
// Contrast gate for the design tokens (WCAG 2.2 AA): 4.5:1 for text,
// 3:1 for UI components, graphics and the focus ring (1.4.3, 1.4.11, 2.4.7).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/styles/contrast.ts";

type Tokens = Record<string, string>;

function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** Innermost `selector { --ss-x: value; }` blocks, comments removed. */
function blocks(css: string): Map<string, Tokens> {
  const out = new Map<string, Tokens>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector = "", body = ""] of clean.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const tokens: Tokens = {};
    for (const [, name = "", value = ""] of body.matchAll(
      /--ss-([a-z0-9-]+):\s*([^;]+);/g,
    )) {
      tokens[name] = value.trim().toLowerCase();
    }
    if (Object.keys(tokens).length > 0) out.set(selector.trim(), tokens);
  }
  return out;
}

const base = blocks(read("../src/styles/tokens.css"));
const light = base.get(":root")!;
const darkMedia = base.get(':root:where(:not([data-theme="light"]))')!;
const darkManual = base.get(':root[data-theme="dark"]')!;

const themes: Record<string, Tokens> = {
  light: light,
  dark: { ...light, ...darkMedia },
};

const TEXT_PAIRS: [string, string][] = [
  ["fg", "canvas"],
  ["fg", "surface"],
  ["fg", "sunken"],
  ["fg", "brand-soft"],
  ["fg", "danger-soft"],
  ["fg-muted", "canvas"],
  ["fg-muted", "surface"],
  ["fg-muted", "sunken"],
  ["brand", "surface"],
  ["brand", "canvas"],
  ["brand-strong", "brand-soft"],
  ["on-brand", "brand"],
  ["on-brand", "brand-strong"],
  ["danger", "surface"],
  ["danger", "canvas"],
  ["danger", "danger-soft"],
  ["success", "surface"],
  ["success", "success-soft"],
  ["warning", "surface"],
  ["warning", "warning-soft"],
];

const UI_PAIRS: [string, string][] = [
  ["line-strong", "surface"],
  ["line-strong", "canvas"],
  ["line-strong", "sunken"],
  ["focus", "canvas"],
  ["focus", "surface"],
  ["focus", "sunken"],
  ["brand", "track"],
  ["danger", "track"],
  ["brand", "sunken"],
];

describe("design token contrast (WCAG 2.2 AA)", () => {
  it("has the same values in both dark blocks (media query and manual switch)", () => {
    expect(darkManual).toEqual(darkMedia);
  });

  it("keeps the lace loader's colours fixed: defined once, never themed", () => {
    const lace = Object.keys(light).filter((name) => name.startsWith("lace-"));
    expect(lace.sort()).toEqual([
      "lace-eyelet",
      "lace-eyelet-rim",
      "lace-hole",
      "lace-line",
      "lace-tile",
      "lace-tip",
    ]);
    for (const dark of [darkMedia, darkManual]) {
      expect(
        Object.keys(dark).filter((name) => name.startsWith("lace-")),
      ).toEqual([]);
    }
  });

  for (const [theme, tokens] of Object.entries(themes)) {
    describe(theme, () => {
      it.each(TEXT_PAIRS)("text %s on %s >= 4.5:1", (fg, bg) => {
        expect(contrastRatio(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(
          4.5,
        );
      });
      it.each(UI_PAIRS)("UI %s on %s >= 3:1", (fg, bg) => {
        expect(contrastRatio(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(
          3,
        );
      });
    });
  }
});

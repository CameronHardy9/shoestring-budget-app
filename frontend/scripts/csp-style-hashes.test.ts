// @vitest-environment node
// Finds every <style> element that React Aria (and its packages) can inject at
// runtime and checks the CSP hashes in src/security/csp.ts still match them.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REACT_ARIA_STYLE_HASHES } from "../src/security/csp.ts";

const require = createRequire(import.meta.url);

function packageDir(name: string, from?: string): string {
  const req = from ? createRequire(join(from, "package.json")) : require;
  return dirname(req.resolve(`${name}/package.json`));
}

function mjsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => join(e.parentPath, e.name));
}

/** Text of each `style.textContent = `…`.trim()` block, constants resolved. */
function injectedStyles(source: string): string[] {
  if (!/createElement\(['"]style['"]\)/.test(source)) return [];
  const blocks = [
    ...source.matchAll(/\.textContent = `([\s\S]*?)`(\.trim\(\))?/g),
  ];
  return blocks.map(([, template = "", trim]) => {
    const text = template.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      // Resolve `${CONST}` from `const CONST = '…'` in the same file (plain
      // string search; no regular expression built from file contents).
      const marker = `const ${name.trim()} = `;
      const at = source.indexOf(marker);
      const quote = at === -1 ? "" : source.charAt(at + marker.length);
      const start = at + marker.length + 1;
      const end = quote === "" ? -1 : source.indexOf(quote, start);
      if (at === -1 || (quote !== "'" && quote !== '"') || end === -1)
        throw new Error(`cannot resolve \${${name}} in an injected style`);
      return source.slice(start, end);
    });
    return trim ? text.trim() : text;
  });
}

describe("CSP hashes for React Aria's injected styles", () => {
  it("match the installed react-aria (update src/security/csp.ts and the backend CSP if this fails)", () => {
    const rac = packageDir("react-aria-components");
    const dirs = [
      join(rac, "dist"),
      join(packageDir("react-aria", rac), "dist"),
    ];
    const hashes = new Set<string>();
    for (const dir of dirs) {
      for (const file of mjsFiles(dir)) {
        for (const text of injectedStyles(readFileSync(file, "utf8"))) {
          hashes.add(
            `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`,
          );
        }
      }
    }
    expect([...hashes].sort()).toEqual([...REACT_ARIA_STYLE_HASHES].sort());
  });
});

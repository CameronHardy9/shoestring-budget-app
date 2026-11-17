// The Dockerfile tripwire, runnable locally (test-hooks.md §2, F-10): fails if
// any built .js/.mjs/.cjs under dist/ contains `_test` as a whole word (grep -w
// semantics: letters, digits and underscore are word characters) or the
// hooks' sentinel string. Exit 1 lists the offending files.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORD = /(?<![A-Za-z0-9_])_test(?![A-Za-z0-9_])/;
const SENTINEL = "__SHOESTRING_TEST_HOOKS__";

export function scanDist(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    // Entry types come from readdir itself (no separate stat before the read:
    // CodeQL js/file-system-race). Anything that is neither a directory nor a
    // regular file (a symlink, ...) can't be checked without following it, so
    // it fails closed; rolldown never writes one.
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!entry.isFile()) hits.push(p);
      else if (/\.(m|c)?js$/.test(entry.name)) {
        const text = readFileSync(p, "utf8");
        if (WORD.test(text) || text.includes(SENTINEL)) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const hits = scanDist(dist);
  if (hits.length > 0) {
    process.stderr.write(`error: test-hook code found in dist:\n${hits.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("dist check: no test-hook code\n");
}

// The production bundle never contains the test hooks (ADR-0009, F-10): build
// both entries into a temp dir and apply the Dockerfile's tripwire.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { afterAll, describe, expect, it } from "vitest";
import { productionBuildOptions } from "./build-options.ts";
import { scanDist } from "./test-hooks-tripwire.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ss-dist-"));
  dirs.push(d);
  return d;
};

describe("production build", () => {
  it("bundles server.js and admin.js without any test-hook code", async () => {
    const out = temp();
    const res = await build({
      ...productionBuildOptions(root, `${out}/`),
      write: true,
    });
    const files = res.output.map((o) => o.fileName);
    expect(files).toEqual(expect.arrayContaining(["server.js", "admin.js"]));
    expect(scanDist(out)).toEqual([]);
  }, 60_000);

  it("the tripwire catches the sentinel and `_test` as a whole word, but not similar identifiers", () => {
    const d = temp();
    mkdirSync(join(d, "chunks"));
    writeFileSync(
      join(d, "fine.js"),
      "const is_test = 1, _tests = 2, TEST_HOOKS = 3;",
    );
    expect(scanDist(d)).toEqual([]);
    writeFileSync(
      join(d, "chunks", "a.js"),
      'app.post("/api/" + "_test" + "/reset")',
    );
    writeFileSync(
      join(d, "b.mjs"),
      'export const s = "__SHOESTRING_TEST_HOOKS__";',
    );
    expect(
      scanDist(d)
        .map((p) => p.slice(d.length + 1))
        .sort(),
    ).toEqual(["b.mjs", join("chunks", "a.js")]);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkBootFirst,
  checkNoInitialSentry,
  hasImports,
  scriptsInOrder,
  type DistReader,
} from "./dist-checks.ts";

const BOOT = "assets/boot-c7fb3811.js";
const MAIN = "assets/index-4996e86b.js";
const BOOT_JS =
  "var e=/^[A-Za-z0-9_-]{43,64}$/,t=null;function n(n,r){r.replaceState(r.state,``,n.pathname)}n(window.location,window.history);export{n as t};";
const map = (...sources: string[]) => JSON.stringify({ version: 3, sources });
const GOOD_MAP = map(
  "../../src/lib/link-token.ts",
  "../../src/boot/capture-link-token.ts",
);

function reader(files: Record<string, string>): DistReader {
  return { read: (p) => files[p] ?? null };
}

const html = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;
const GOOD_HTML = html(
  `<script type="module" crossorigin src="/${BOOT}"></script>` +
    `<script type="module" crossorigin src="/${MAIN}"></script>` +
    `<link rel="modulepreload" crossorigin href="/${BOOT}">`,
);

describe("F-50: the link-token capture runs first in the production build", () => {
  it("accepts the boot chunk as the first, self-contained module script", () => {
    expect(
      checkBootFirst(
        GOOD_HTML,
        reader({ [BOOT]: BOOT_JS, [`${BOOT}.map`]: GOOD_MAP }),
      ),
    ).toEqual([]);
  });

  it("rejects the single-entry layout F-50 found (shared chunks evaluate before the capture)", () => {
    const old = html(
      `<script type="module" crossorigin src="/${MAIN}"></script>`,
    );
    expect(checkBootFirst(old, reader({})).join()).toMatch(
      /first <script> must be the boot chunk/,
    );
  });

  it("rejects the boot script placed after main, async, or not a module", () => {
    const after = html(
      `<script type="module" src="/${MAIN}"></script><script type="module" src="/${BOOT}"></script>`,
    );
    expect(checkBootFirst(after, reader({})).join()).toMatch(/boot chunk/);
    const files = reader({ [BOOT]: BOOT_JS, [`${BOOT}.map`]: GOOD_MAP });
    expect(
      checkBootFirst(
        html(`<script type="module" async src="/${BOOT}"></script>`),
        files,
      ).join(),
    ).toMatch(/async/);
    expect(
      checkBootFirst(html(`<script src="/${BOOT}"></script>`), files).join(),
    ).toMatch(/type="module"/);
  });

  it("rejects a boot chunk that imports anything or bundles other modules", () => {
    for (const js of [
      `import{a as b}from"./States-80bd6333.js";${BOOT_JS}`,
      `import"./rolldown-runtime-16930679.js";${BOOT_JS}`,
      `${BOOT_JS}import("./sentry-574ca1c3.js");`,
    ]) {
      expect(
        checkBootFirst(
          GOOD_HTML,
          reader({ [BOOT]: js, [`${BOOT}.map`]: GOOD_MAP }),
        ).join(),
      ).toMatch(/imports other modules/);
    }
    const bigger = map(
      "../../src/lib/link-token.ts",
      "../../src/boot/capture-link-token.ts",
      "../../src/observability/report.ts",
    );
    expect(
      checkBootFirst(
        GOOD_HTML,
        reader({ [BOOT]: BOOT_JS, [`${BOOT}.map`]: bigger }),
      ).join(),
    ).toMatch(/more than the capture: src\/observability\/report\.ts/);
    expect(
      checkBootFirst(GOOD_HTML, reader({ [BOOT]: BOOT_JS })).join(),
    ).toMatch(/map is missing/);
  });

  it("finds scripts in document order and recognises minified imports", () => {
    expect(scriptsInOrder(GOOD_HTML).map((s) => s.src)).toEqual([
      `/${BOOT}`,
      `/${MAIN}`,
    ]);
    expect(hasImports(BOOT_JS)).toBe(false);
    expect(hasImports('import*as a from"./x.js"')).toBe(true);
    expect(hasImports('export{a as b}from"./x.js"')).toBe(true);
  });
});

describe("Sentry stays out of the initial bundle", () => {
  it("flags an initial chunk whose sources include the SDK", () => {
    const files = reader({
      [`${MAIN}.map`]: map("../../src/main.tsx"),
      ["assets/vendor-1234abcd.js.map"]: map(
        "../../../node_modules/.pnpm/@sentry+core@11.10.0/node_modules/@sentry/core/build/esm/index.js",
      ),
    });
    expect(checkNoInitialSentry([MAIN], files)).toEqual([]);
    expect(
      checkNoInitialSentry([MAIN, "assets/vendor-1234abcd.js"], files),
    ).toHaveLength(1);
  });
});

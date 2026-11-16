// @vitest-environment node
// F-52: the device-storage ban in eslint.config.js catches every way app code
// can reach browser storage, and the only exception is the preferences wrapper.
// Runs the project's real config against fixture snippets placed under src/.
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const BAN_RULES = new Set([
  "no-restricted-globals",
  "no-restricted-properties",
]);

const eslint = new ESLint({
  cwd: root,
  // Snippets are not in a tsconfig program: parse without type information
  // and run only the ban rules (the type-aware rules are covered by make check).
  overrideConfig: { languageOptions: { parserOptions: { project: null } } },
  ruleFilter: ({ ruleId }) => BAN_RULES.has(ruleId),
});

async function banHits(code: string, file = "src/lint-fixture.ts") {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe("device storage lint ban (F-52)", () => {
  const apis = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
    "cookieStore",
  ];

  it.each(apis)("rejects bare %s", async (name) => {
    expect(await banHits(`export const s = ${name};`)).toEqual([
      "no-restricted-globals",
    ]);
  });

  it.each(
    apis.flatMap((name) =>
      ["window", "globalThis", "self"].map((g) => [g, name]),
    ),
  )("rejects %s.%s", async (global, name) => {
    expect(await banHits(`export const s = ${global}.${name};`)).toEqual([
      "no-restricted-properties",
    ]);
  });

  it.each(apis)(
    "rejects %s through computed access, an alias or destructuring",
    async (name) => {
      expect(await banHits(`export const s = window["${name}"];`)).toEqual([
        "no-restricted-properties",
      ]);
      expect(
        await banHits(`const w = window; export const s = w.${name};`),
      ).toEqual(["no-restricted-properties"]);
      expect(await banHits(`export const { ${name} } = window;`)).toEqual([
        "no-restricted-properties",
      ]);
    },
  );

  it("rejects document.cookie reads and writes", async () => {
    expect(await banHits("export const c = document.cookie;")).toEqual([
      "no-restricted-properties",
    ]);
    expect(await banHits('document.cookie = "a=b";')).toEqual([
      "no-restricted-properties",
    ]);
    expect(await banHits("export const c = window.document.cookie;")).toEqual([
      "no-restricted-properties",
    ]);
  });

  it("applies to components and to the preferences module itself", async () => {
    expect(
      await banHits(
        "export const s = window.sessionStorage;",
        "src/screens/Example.tsx",
      ),
    ).toEqual(["no-restricted-properties"]);
    // The file's own exception covers one line, not new code in the file.
    expect(
      await banHits(
        "export const s = window.sessionStorage;",
        "src/lib/preferences.ts",
      ),
    ).toEqual(["no-restricted-properties"]);
  });

  it("allows ordinary code", async () => {
    expect(
      await banHits(
        "export const a = window.location.pathname; export const b = { cookie: 1 };",
      ),
    ).toEqual([]);
  });

  it("leaves the one commented exception in src/lib/preferences.ts", async () => {
    const [result] = await eslint.lintFiles([`${root}src/lib/preferences.ts`]);
    expect(result?.messages).toEqual([]);
    expect(result?.suppressedMessages.map((m) => m.ruleId)).toEqual([
      "no-restricted-properties",
    ]);
  });
});

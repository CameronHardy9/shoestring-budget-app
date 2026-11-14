// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src/contract/contract.gen.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      // Logs go through pino (redaction, request IDs); never console.*.
      "no-console": "error",
    },
  },
  {
    // Production entry points and everything they import must never reach the
    // test hooks or the database testing helpers (test-hooks.md, ADR-0009).
    files: ["src/**/*.ts"],
    ignores: ["src/dev-server.ts", "src/test-hooks.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Data-access bans (Kysely, db internals, the db testing helpers)
          // are Semgrep rules in .github/semgrep/data-access.yml (make audit).
          patterns: [
            { group: ["**/test-hooks*"], message: "Only src/dev-server.ts may import the test hooks." },
          ],
        },
      ],
    },
  },
  {
    // Tests only: `expect(...)!` and async idioms. Never covers production code.
    files: ["src/**/*.test.ts", "src/test-support/**", "scripts/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);

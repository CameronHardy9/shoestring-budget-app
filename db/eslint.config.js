// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
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
      "no-console": "error",
      // String-built SQL is banned: raw SQL only through Kysely's sql`` tag with
      // bound parameters (security checklist C1.1).
      "no-restricted-properties": [
        "error",
        {
          object: "sql",
          property: "raw",
          message: "sql.raw builds SQL from strings; use bound parameters.",
        },
        {
          object: "sql",
          property: "lit",
          message: "sql.lit inlines values; use bound parameters.",
        },
      ],
    },
  },
  {
    files: ["src/cli/**", "src/seed/**", "src/test-support/**"],
    rules: { "no-console": "off" },
  },
  {
    // Tests only: `expect(...)!` and `async () => expect(...)` idioms. Production
    // code keeps the full strictTypeChecked rule set. Security review condition:
    // this must never cover src/testing/** (it runs inside the backend's dev
    // server), hence the explicit ignore.
    files: ["src/**/*.test.ts", "src/test-support/**"],
    ignores: ["src/testing/**"],
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

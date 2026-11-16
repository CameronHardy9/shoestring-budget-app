// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "playwright-report/**", "test-results/**"] },
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
      // Test idioms: `body!.x` after an asserted status, and async callbacks
      // handed to fast-check / Vitest that need no await of their own.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Failure output goes through expect() messages, never console.
      "no-console": "error",
      // No fixed sleeps: wait on a condition or move the frozen clock instead
      // (tests/CLAUDE.md "Determinism").
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message:
            "No fixed sleeps in tests: freeze/advance the app clock or wait on a condition.",
        },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);

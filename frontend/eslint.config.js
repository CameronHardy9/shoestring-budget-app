// @ts-check
import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "src/api/schema.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Two programs: the browser app (tsconfig.json) and the Node-side
        // config and scripts (tsconfig.node.json).
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // No console in shipped code: errors go to Sentry through the allowlist
      // (ARCHITECTURE "Error tracking"), never to a shared phone's console.
      "no-console": "error",
      // Untrusted HTML is never rendered (CSP and XSS).
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Never render HTML strings. Render text through React.",
        },
        {
          selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Never write HTML strings into the DOM.",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message:
            "Only src/lib/preferences.ts may use localStorage (ADR-0002: theme and last budget ID only).",
        },
        {
          name: "sessionStorage",
          message:
            "No sessionStorage: financial data and tokens stay in memory (ADR-0002, auth.md §4).",
        },
        {
          name: "indexedDB",
          message:
            "No IndexedDB: nothing financial is stored on the device (ADR-0002).",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/preview/**", "**/preview"],
              message:
                "src/preview is the dev-only style preview; app code must not import it.",
            },
            {
              group: ["openapi-fetch"],
              importNames: ["default"],
              message:
                "Call the API through src/api/client.ts (CSRF, request IDs, typed errors).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.tsx"],
    ...jsxA11y.configs.strict,
  },
  {
    // The wrapper itself creates the openapi-fetch client.
    files: ["src/api/client.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // The preview may import app code (not the reverse) and shows mock data only.
    files: ["src/preview/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**", "scripts/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["scripts/**/*.ts", "vite.config.ts", "vitest.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The service worker template: plain JS run in the worker scope.
    files: ["sw/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.serviceworker, __PRECACHE__: "readonly" },
    },
  },
);

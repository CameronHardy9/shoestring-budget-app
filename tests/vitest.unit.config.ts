import { defineConfig } from "vitest/config";

// Unit tests of the test infrastructure itself (support/*.test.ts): pure
// functions, no stack, no global setup. `make check` runs them through this
// package's `test` script; the stack suites are in vitest.config.ts.
export default defineConfig({
  test: {
    include: ["support/**/*.test.ts"],
    retry: 0,
    reporters: ["default"],
  },
});

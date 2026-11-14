import { defineConfig } from "vitest/config";

// Backend unit tests: no database. The DAL is replaced by fakes
// (src/test-support/harness.ts); real-database integration tests live in
// tests/ (test-engineer). @shoestring/db/testing is not importable here (Semgrep).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      // ARCHITECTURE "Correctness": 100% branch coverage on money, split and
      // month logic. The backend's share is src/domain (date window, cursors,
      // idempotency hash) plus the TOTP and recovery-code primitives; the
      // summary math itself is db's summarize (covered in db/).
      include: ["src/domain/**/*.ts", "src/auth/totp.ts", "src/auth/recovery-codes.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});

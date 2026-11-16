import { defineConfig } from "vitest/config";

// API-level suites (contract, integration, security regressions) against the
// running e2e stack. The stack has ONE backend with global state (database,
// frozen clock, in-memory rate limiter, email outbox), and every test starts
// from POST /api/_test/reset. Test files therefore run one at a time, in one
// worker; each test is still independent of every other (tests/CLAUDE.md).
export default defineConfig({
  test: {
    include: ["contract/**/*.test.ts", "integration/**/*.test.ts"],
    globalSetup: ["./support/global-setup.ts"],
    setupFiles: ["./support/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A flaky test is fixed or quarantined with a written reason, never retried.
    retry: 0,
    reporters: ["default"],
  },
});

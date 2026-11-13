import { defineConfig } from "vitest/config";

// Unit tests run against real Postgres (make test exports DATABASE_URL,
// MIGRATOR_DATABASE_URL and DATABASE_ADMIN_URL after migrating). Each test file
// gets its own clone of the migrated database (src/test-support/harness.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test-support/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});

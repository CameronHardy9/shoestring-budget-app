// Guards for the dev-only test hooks (test-hooks.md §3-4, ADR-0009, F-30).
// The hooks' routes themselves need a database (reset) and are exercised by
// tests/ against the dev server.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hookGuardFailure, hookOriginAllowed } from "./test-hooks.ts";

const ok = {
  nodeEnv: "test",
  testHooks: true,
  appOrigin: "http://localhost:5173",
  adminDatabaseUrl: "postgres://x@localhost/db",
};

describe("test hook guards", () => {
  it("register only when every guard passes", () => {
    expect(hookGuardFailure(ok)).toBeNull();
    expect(hookGuardFailure({ ...ok, testHooks: false })).toMatch(/TEST_HOOKS/);
    expect(hookGuardFailure({ ...ok, nodeEnv: "production" })).toMatch(
      /NODE_ENV/,
    );
    expect(hookGuardFailure({ ...ok, adminDatabaseUrl: undefined })).toMatch(
      /DATABASE_ADMIN_URL/,
    );
  });

  it("the origin tripwire allows only localhost, 127.0.0.1 and *.test (F-30)", () => {
    for (const o of [
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://localhost",
      "https://shoestring.test",
      "http://e2e.test:8080",
    ])
      expect([o, hookOriginAllowed(o)]).toEqual([o, true]);
    for (const o of [
      "http://192.168.1.20:5173",
      "https://shoestring.example.com",
      "https://localhost",
      "http://localhost.evil.com",
      "http://test",
      "not a url",
    ])
      expect([o, hookOriginAllowed(o)]).toEqual([o, false]);
  });

  it("production entry points never reference the hooks module", () => {
    for (const f of ["server.ts", "admin.ts", "app.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect([
        f,
        /from\s+["'][^"']*test-hooks|import\([^)]*test-hooks|\b_test\b|__SHOESTRING_TEST_HOOKS__/.test(src),
      ]).toEqual([f, false]);
    }
  });
});

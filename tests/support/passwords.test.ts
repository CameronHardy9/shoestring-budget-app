// Unit test (no stack needed; runs in `make check`): every run-time test
// password satisfies the auth.md §7 policy, so suites that set passwords never
// fail on VALIDATION_FAILED because of the helper.
import { describe, expect, it } from "vitest";
import { randomPassword } from "./passwords.ts";

describe("randomPassword (auth.md §7 policy)", () => {
  const samples = Array.from({ length: 200 }, randomPassword);

  // ASCII only (checked below), so .length counts code points.
  it("is 12-128 code points long", () => {
    for (const pw of samples) {
      expect(pw.length).toBeGreaterThanOrEqual(12);
      expect(pw.length).toBeLessThanOrEqual(128);
    }
  });

  it("can never equal an email address", () => {
    for (const pw of samples) expect(pw).not.toContain("@");
  });

  it("is URL-safe, so it can sit in a database URL", () => {
    for (const pw of samples) expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is different on every call", () => {
    expect(new Set(samples).size).toBe(samples.length);
  });
});

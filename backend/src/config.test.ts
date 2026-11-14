import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { testEnv } from "./test-support/harness.ts";

const prod = (extra: Record<string, string> = {}) =>
  testEnv({
    NODE_ENV: "production",
    APP_ORIGIN: "https://shoestring.example.com",
    DATABASE_URL: "postgres://app:pw@db.example.net/app?sslmode=verify-full",
    EMAIL_API_KEY: "re_x",
    EMAIL_FROM: "Shoestring <no-reply@mail.example.com>",
    EMAIL_DAILY_QUOTA: "100",
    TRUST_PROXY_HOPS: "1",
    ...extra,
  });

describe("loadConfig (fail closed)", () => {
  it("refuses a missing or unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...testEnv(), NODE_ENV: undefined })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(testEnv({ NODE_ENV: "staging" }))).toThrow(
      /NODE_ENV/,
    );
  });

  it("accepts a complete production config with secure defaults", () => {
    const c = loadConfig(prod());
    expect(c).toMatchObject({
      cookieSecure: true,
      hibpEnabled: true,
      testHooks: false,
      trustProxyHops: 1,
      appHost: "shoestring.example.com",
    });
    expect(c.email.transport).toBe("provider");
  });

  it.each([
    [{ COOKIE_SECURE: "false" }, /COOKIE_SECURE/],
    [{ TEST_HOOKS: "1" }, /TEST_HOOKS/],
    [{ HIBP_ENABLED: "false" }, /HIBP_ENABLED/],
    [{ EMAIL_TRANSPORT: "console" }, /EMAIL_TRANSPORT/],
    [{ EMAIL_DAILY_QUOTA: "" }, /EMAIL_DAILY_QUOTA/],
    [{ EMAIL_API_KEY: "" }, /EMAIL_API_KEY/],
    [{ TRUST_PROXY_HOPS: "" }, /TRUST_PROXY_HOPS/],
    [{ TRUST_PROXY_HOPS: "0" }, /at least 1/],
    [{ APP_ORIGIN: "http://shoestring.example.com" }, /https/],
    [{ DATABASE_URL: "postgres://app:pw@db.example.net/app" }, /verify-full/],
    [
      { DATABASE_URL: "postgres://app:pw@db.example.net/app?sslmode=require" },
      /verify-full/,
    ],
    [
      { DATABASE_URL: "postgres://app:pw@localhost/app?host=evil.example.net" },
      /query parameter/,
    ],
    [{ APP_KEYRING: '{"current":"k2","keys":{"k1":"AAAA"}}' }, /APP_KEYRING/],
  ])("refuses %o in production", (extra, msg) => {
    expect(() => loadConfig(prod(extra))).toThrow(msg);
  });

  it("WEBAUTHN_RP_ID must be APP_ORIGIN's host; the RP ID defaults to it", () => {
    expect(loadConfig(prod()).webauthn).toEqual({ rpId: "shoestring.example.com", rpName: "Shoestring" });
    expect(() => loadConfig(prod({ WEBAUTHN_RP_ID: "example.com" }))).toThrow(/WEBAUTHN_RP_ID/);
  });

  it("uses the shared driver-parsed URL check (F-42) in every environment", () => {
    expect(() => loadConfig(testEnv({ DATABASE_URL: "postgres://app:pw@db.example.net/app" }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ DATABASE_URL: "postgres://app:pw@localhost/app?hostaddr=10.0.0.1" }))).toThrow(ConfigError);
    try {
      loadConfig(testEnv({ DATABASE_URL: "postgres://app:secretpw@db.example.net/app" }));
    } catch (e) {
      expect(String(e)).not.toContain("secretpw");
    }
  });

  it("never echoes secret values in errors", () => {
    try {
      loadConfig(prod({ APP_KEYRING: "super-secret-keyring" }));
    } catch (e) {
      expect(String(e)).not.toContain("super-secret");
    }
  });

  it("local development defaults: console mail, HIBP off, http origin allowed", () => {
    const c = loadConfig(
      testEnv({
        NODE_ENV: "development",
        APP_ORIGIN: "http://localhost:5173",
        COOKIE_SECURE: "false",
      }),
    );
    expect(c).toMatchObject({
      cookieSecure: false,
      hibpEnabled: false,
      appHost: "localhost:5173",
    });
    expect(c.email.transport).toBe("console");
    expect(loadConfig(testEnv()).email.transport).toBe("test");
  });

  it("APP_ORIGIN must be a bare origin", () => {
    expect(() =>
      loadConfig(testEnv({ APP_ORIGIN: "https://app.test/path" })),
    ).toThrow(/origin/);
    expect(
      loadConfig(testEnv({ APP_ORIGIN: "https://app.test/" })).appOrigin,
    ).toBe("https://app.test");
  });
});

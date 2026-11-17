// Unit test (no stack needed; runs in `make check`): the suites refuse any
// non-local database or origin, and a stray exported shell variable never
// silently overrides tests/.env.stack (F-56).
import { describe, expect, it } from "vitest";
import { localDatabaseUrl } from "./db-env.ts";
import {
  fakeSentryDsn,
  loopbackOrigin,
  resolveStackSource,
  StackEnvError,
} from "./env-guards.ts";

// Synthetic credentials, built at run time (never a real secret).
const PW = `pw-${String(Math.random()).slice(2)}`;
const db = (host: string, extra = "") =>
  `postgres://app:${PW}@${host}/shoestring_test${extra}`;

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a StackEnvError, nothing was thrown");
}

describe("database URLs must be local (F-56)", () => {
  it.each([
    ["127.0.0.1", db("127.0.0.1:55433")],
    ["localhost", db("localhost:5432")],
    ["::1", db("[::1]:5432")],
    ["the compose host postgres", db("postgres:5432")],
  ])("accepts %s", (_label, url) => {
    expect(localDatabaseUrl("DATABASE_URL", url)).toBe(url);
  });

  it.each([
    [
      "a hosted database",
      "DATABASE_URL",
      db(
        "ep-example-123.us-east-2.aws.neon.example:5432",
        "?sslmode=verify-full",
      ),
    ],
    ["a LAN address", "DATABASE_ADMIN_URL", db("192.168.1.20:5432")],
    [
      "a look-alike host",
      "DATABASE_URL",
      db("localhost.attacker.example:5432"),
    ],
    [
      "a ?host= override of a local authority",
      "DATABASE_ADMIN_URL",
      db("127.0.0.1:5432", "?host=db.example"),
    ],
    ["a non-postgres scheme", "DATABASE_URL", `mysql://app:${PW}@127.0.0.1/x`],
    ["a non-URL", "DATABASE_URL", `app:${PW} at somewhere`],
  ])(
    "refuses %s, naming the variable and never echoing the URL",
    (_label, name, url) => {
      const e = errorOf(() => localDatabaseUrl(name, url));
      expect(e).toBeInstanceOf(StackEnvError);
      expect(e.message).toContain(name);
      expect(e.message).not.toContain(PW);
      expect(e.message).not.toContain(url);
    },
  );

  it("refuses a missing URL with a hint to start the stack", () => {
    const e = errorOf(() => localDatabaseUrl("DATABASE_ADMIN_URL", undefined));
    expect(e).toBeInstanceOf(StackEnvError);
    expect(e.message).toMatch(/DATABASE_ADMIN_URL is not set.*make e2e-up/);
  });
});

describe("app and API origins must be loopback (F-56)", () => {
  it.each([
    "http://localhost:55173",
    "http://localhost:55173/",
    "http://127.0.0.1:53000",
    "http://[::1]:53000",
  ])("accepts %s", (url) => {
    expect(loopbackOrigin("APP_ORIGIN", url)).toBe(url.replace(/\/$/, ""));
  });

  it.each([
    "https://shoestring.example",
    "https://localhost:5173",
    "http://192.168.1.20:5173",
    "http://localhost.attacker.example:5173",
    "http://user:secret@localhost:5173",
    "not a url",
  ])("refuses %s, naming the variable", (url) => {
    const e = errorOf(() => loopbackOrigin("API_URL", url));
    expect(e).toBeInstanceOf(StackEnvError);
    expect(e.message).toContain("API_URL");
    expect(e.message).not.toContain(url);
  });
});

describe("which variables are used (F-56: no silent shell overrides)", () => {
  const stackFile = [
    "APP_ORIGIN=http://localhost:5173",
    "BASE_URL=http://localhost:5173",
    "API_URL=http://127.0.0.1:3000",
    `DATABASE_URL='${db("127.0.0.1:5433")}'`,
    `DATABASE_ADMIN_URL=${db("127.0.0.1:5433")}`,
  ].join("\n");

  it("with APP_ORIGIN exported (make e2e), the process environment is used and the stack file ignored", () => {
    const env = {
      APP_ORIGIN: "http://localhost:55173",
      DATABASE_URL: db("127.0.0.1:55433"),
    };
    expect(resolveStackSource(env, stackFile)).toMatchObject(env);
  });

  it("without APP_ORIGIN, the stack file is used whole (quotes stripped)", () => {
    const s = resolveStackSource({ HOME: "/home/x" }, stackFile);
    expect(s.APP_ORIGIN).toBe("http://localhost:5173");
    expect(s.DATABASE_URL).toBe(db("127.0.0.1:5433"));
  });

  it("names with digits are read too (E2E_SENTRY_DSN)", () => {
    const dsn = "https://e2e@o0.ingest.sentry.test/1";
    expect(
      resolveStackSource({}, `${stackFile}\nE2E_SENTRY_DSN=${dsn}`)
        .E2E_SENTRY_DSN,
    ).toBe(dsn);
  });

  it("Vitest's own BASE_URL=/ is not a stack variable", () => {
    expect(resolveStackSource({ BASE_URL: "/" }, stackFile).BASE_URL).toBe(
      "http://localhost:5173",
    );
  });

  it("an exported value equal to the stack file's is fine", () => {
    expect(
      resolveStackSource({ API_URL: "http://127.0.0.1:3000" }, stackFile)
        .API_URL,
    ).toBe("http://127.0.0.1:3000");
  });

  it.each([
    ["DATABASE_URL", db("ep-example.neon.example:5432")],
    ["DATABASE_ADMIN_URL", db("127.0.0.1:6543")],
    ["BACKEND_PORT", "3001"],
  ])(
    "an exported %s that differs from the stack file is an error, not an override",
    (name, value) => {
      const e = errorOf(() => resolveStackSource({ [name]: value }, stackFile));
      expect(e).toBeInstanceOf(StackEnvError);
      expect(e.message).toContain(`${name} is exported in this shell`);
      expect(e.message).not.toContain(value);
    },
  );

  it("with neither APP_ORIGIN nor a stack file, the process environment is passed on (env.ts then says what is missing)", () => {
    expect(resolveStackSource({ DATABASE_URL: "x" }, null)).toEqual({
      DATABASE_URL: "x",
    });
  });
});

describe("E2E_SENTRY_DSN must be a fake DSN on a reserved .test host", () => {
  // Built at run time: 32 hex characters, like a real public key.
  const key = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16)).join(
    "",
  );

  it("splits a well-formed fake DSN into the parts the suites derive values from", () => {
    expect(fakeSentryDsn(`https://${key}@o0.ingest.sentry.test/1`)).toEqual({
      dsn: `https://${key}@o0.ingest.sentry.test/1`,
      ingestOrigin: "https://o0.ingest.sentry.test",
      publicKey: key,
      projectId: "1",
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a URL", "nope"],
    ["a real Sentry host", `https://${key}@o1.ingest.us.sentry.io/1`],
    ["a .test look-alike", `https://${key}@o0.ingest.sentry.test.example/1`],
    ["plain http", `http://${key}@o0.ingest.sentry.test/1`],
    ["a non-hex key", `https://${"z".repeat(32)}@o0.ingest.sentry.test/1`],
    ["a secret part", `https://${key}:x@o0.ingest.sentry.test/1`],
    ["a non-numeric project", `https://${key}@o0.ingest.sentry.test/p`],
    ["a port", `https://${key}@o0.ingest.sentry.test:8443/1`],
    ["a query", `https://${key}@o0.ingest.sentry.test/1?x=1`],
  ])("refuses %s, naming the variable but not the value", (_, value) => {
    const e = errorOf(() => fakeSentryDsn(value));
    expect(e).toBeInstanceOf(StackEnvError);
    expect(e.message).toContain("E2E_SENTRY_DSN");
    if (value) expect(e.message).not.toContain(value);
  });
});

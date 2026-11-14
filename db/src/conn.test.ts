// F-41/F-42/F-43 regression tests: scope minting is private, database URL
// checks use the driver's parser, and the CLIs refuse unsafe targets.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DatabaseUrlError,
  assertLocalDatabaseUrl,
  assertSecureDatabaseUrl,
  parseDatabaseUrl,
} from "./conn.ts";
import * as publicApi from "./index.ts";
import * as scopeModule from "./scope.ts";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "s3cretpassw0rdvalue";

function cli(
  script: "migrate" | "seed",
  env: Record<string, string | undefined>,
) {
  const r = spawnSync(
    process.execPath,
    [join(DB_DIR, "src", "cli", `${script}.ts`)],
    {
      cwd: DB_DIR,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("F-41: scope minting is module-private", () => {
  it("does not export issueBudgetScope (types and runtime)", () => {
    // @ts-expect-error issueBudgetScope must not be exported from scope.ts
    expect(scopeModule.issueBudgetScope).toBeUndefined();
    const issuers = Object.keys(scopeModule).filter((k) =>
      /scope|membership|ownership/i.test(k),
    );
    expect(issuers.sort()).toEqual(
      [
        "assertBudgetScope",
        "assertDeletedBudgetScope",
        "requireDeletedBudgetOwnership",
        "requireMembership",
      ].sort(),
    );
  });
});

describe("F-42: database URL checks", () => {
  const local = `postgres://app:${SECRET}@localhost:5432/shoestring`;

  it("uses the driver's host and refuses host/hostaddr overrides", () => {
    expect(parseDatabaseUrl("X", local)).toMatchObject({
      host: "localhost",
      local: true,
      user: "app",
    });
    expect(parseDatabaseUrl("X", "postgres://a:b@[::1]:5432/d").local).toBe(
      true,
    );
    expect(
      parseDatabaseUrl("X", "postgresql://a:b@postgres:5432/d").local,
    ).toBe(true);
    for (const bad of [
      `${local}?host=prod.example.net`,
      `${local}?hostaddr=203.0.113.9`,
      `${local}?sslmode=disable&HOST=prod.example.net`,
    ]) {
      expect(() => assertLocalDatabaseUrl("X", bad)).toThrow(DatabaseUrlError);
    }
    expect(() => parseDatabaseUrl("X", "mysql://a:b@localhost/d")).toThrow(
      DatabaseUrlError,
    );
    expect(() => parseDatabaseUrl("X", "not a url")).toThrow(DatabaseUrlError);
  });

  it("refuses remote hosts for local-only tools", () => {
    expect(() =>
      assertLocalDatabaseUrl("X", `postgres://a:${SECRET}@db.example.com/d`),
    ).toThrow(/X must point at a local/);
    expect(() =>
      assertLocalDatabaseUrl(
        "X",
        `postgres://a:${SECRET}@localhost.example.com/d`,
      ),
    ).toThrow(DatabaseUrlError);
  });

  it("requires sslmode=verify-full for a remote URL", () => {
    expect(() =>
      assertSecureDatabaseUrl(
        "X",
        "postgres://m:p@ep-x.us-east-1.aws.neon.tech/shoestring",
      ),
    ).toThrow(/verify-full/);
    expect(() =>
      assertSecureDatabaseUrl(
        "X",
        "postgres://m:p@ep-x.us-east-1.aws.neon.tech/shoestring?sslmode=require",
      ),
    ).toThrow(/verify-full/);
    expect(
      assertSecureDatabaseUrl(
        "X",
        "postgres://m:p@ep-x.us-east-1.aws.neon.tech/shoestring?sslmode=verify-full",
      ).local,
    ).toBe(false);
    expect(assertSecureDatabaseUrl("X", local).local).toBe(true);
  });

  it("exports the shared checks from the public entry, and not the local-only one", () => {
    expect(publicApi.parseDatabaseUrl).toBe(parseDatabaseUrl);
    expect(publicApi.assertSecureDatabaseUrl).toBe(assertSecureDatabaseUrl);
    expect(publicApi.DatabaseUrlError).toBe(DatabaseUrlError);
    expect("assertLocalDatabaseUrl" in publicApi).toBe(false);
    expect(() =>
      publicApi.assertSecureDatabaseUrl(
        "DATABASE_URL",
        "postgres://app:x@db.example.net/shoestring?sslmode=require",
      ),
    ).toThrow(publicApi.DatabaseUrlError);
  });

  it("never puts the URL or password in error messages", () => {
    for (const fn of [
      () =>
        assertLocalDatabaseUrl("X", `postgres://a:${SECRET}@db.example.com/d`),
      () =>
        assertLocalDatabaseUrl(
          "X",
          `postgres://a:${SECRET}@localhost/d?host=prod`,
        ),
    ]) {
      expect(fn).toThrow(DatabaseUrlError);
      try {
        fn();
      } catch (e) {
        expect(String(e)).not.toContain(SECRET);
        expect(String(e)).not.toContain("example.com");
      }
    }
  });

  it("migrate refuses a remote migrator URL without verify-full, and an admin URL with ?host=", () => {
    const remote = cli("migrate", {
      MIGRATOR_DATABASE_URL: `postgres://migrator:${SECRET}@db.example.com/shoestring`,
    });
    expect(remote.status).not.toBe(0);
    expect(remote.output).toContain("sslmode=verify-full");
    expect(remote.output).not.toContain(SECRET);
    const sneaky = cli("migrate", {
      MIGRATOR_DATABASE_URL: `postgres://migrator:${SECRET}@localhost/shoestring`,
      DATABASE_ADMIN_URL: `postgres://postgres:${SECRET}@localhost/shoestring?host=prod.example.net`,
    });
    expect(sneaky.status).not.toBe(0);
    expect(sneaky.output).toContain("DATABASE_ADMIN_URL must not set the host");
    expect(sneaky.output).not.toContain(SECRET);
  });
});

describe("F-43: seed environment guard", () => {
  it("refuses a remote database, a host override, and NODE_ENV=production", () => {
    const remote = cli("seed", {
      DATABASE_URL: `postgres://app:${SECRET}@db.example.com/shoestring?sslmode=verify-full`,
    });
    expect(remote.status).not.toBe(0);
    expect(remote.output).toContain("seed: refused");
    const override = cli("seed", {
      DATABASE_URL: `postgres://app:${SECRET}@localhost/shoestring?host=db.example.com`,
    });
    expect(override.status).not.toBe(0);
    expect(override.output).toContain("seed: refused");
    const prod = cli("seed", {
      DATABASE_URL: `postgres://app:${SECRET}@localhost/shoestring`,
      NODE_ENV: "production",
    });
    expect(prod.status).not.toBe(0);
    expect(prod.output).toContain("NODE_ENV is production");
    for (const r of [remote, override, prod])
      expect(r.output).not.toContain(SECRET);
  });
});

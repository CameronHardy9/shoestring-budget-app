// F-07: the allowlist error serializer. The fixture is a realistic pg
// constraint error whose message/detail/where carry a payee and an amount.
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ERROR_MESSAGES,
  ERROR_STATUS,
  fromDalError,
  toErrorBody,
} from "./errors.ts";
import { DalError } from "@shoestring/db";
import { createLogger, serializeError } from "./logging.ts";

function pgError() {
  const e = new Error(
    'new row for relation "transactions" violates check constraint "transactions_payee_check" payee=Joe\'s Diner amount=4321',
  );
  return Object.assign(e, {
    name: "error",
    code: "23514",
    constraint: "transactions_payee_check",
    table: "transactions",
    column: "payee",
    detail: "Failing row contains (…, Joe's Diner, 4321, …).",
    hint: "payee Joe's Diner",
    where: "PL/pgSQL function … amount 4321",
    schema: "public",
    query: "insert into transactions values ($1)",
    parameters: ["Joe's Diner", 4321],
  });
}

describe("serializeError (F-07 allowlist)", () => {
  it("keeps name, SQLSTATE, constraint, table, column and stack frames only", () => {
    const s = serializeError(pgError());
    expect(Object.keys(s).sort()).toEqual([
      "code",
      "column",
      "constraint",
      "frames",
      "name",
      "table",
    ]);
    expect(s).toMatchObject({
      code: "23514",
      constraint: "transactions_payee_check",
      table: "transactions",
      column: "payee",
    });
    expect(s.frames!.length).toBeGreaterThan(0);
    for (const f of s.frames!) expect(f).toMatch(/^at /);
    const text = JSON.stringify(s);
    for (const leak of ["Joe", "Diner", "4321", "violates", "Failing row"])
      expect(text).not.toContain(leak);
  });

  it("drops non-token values in allowlisted fields and follows causes", () => {
    const outer = Object.assign(new Error("wrap"), {
      code: "has spaces: Joe",
      cause: pgError(),
    });
    const s = serializeError(outer);
    expect(s.code).toBeUndefined();
    expect(s.cause).toMatchObject({ code: "23514" });
    expect(serializeError("a string with Joe")).toEqual({ name: "string" });
  });

  it("drops a message line that imitates a stack frame", () => {
    const e = new Error("x\nat Joe's Diner paid 4321");
    expect(JSON.stringify(serializeError(e))).not.toContain("Joe");
  });

  // F-59: V8's stack repeats the whole message before the frames.
  it("a multi-line message with fake frames never yields a frame", () => {
    const email = "pat@example.test";
    const e = new Error(
      `failed for ${email}\n    at Pharmacy (${email}:1:2)\n    at therapy copay (x.js:3:4)\n    at x.js:5:6`,
    );
    const s = serializeError(e);
    expect(s.frames!.length).toBeGreaterThan(0);
    expect(s.frames![0]).toMatch(/logging\.test\.ts:\d+:\d+\)?$/);
    const text = JSON.stringify(s);
    for (const leak of [email, "Pharmacy", "therapy", "copay", "x.js"])
      expect(text).not.toContain(leak);
    // The header is name + message even when the name spans lines too.
    const named = Object.assign(new Error("m"), {
      name: "Bad\n    at Pharmacy (y.js:1:2)",
    });
    named.stack = `Bad\n    at Pharmacy (y.js:1:2): m\n    at real (z.js:7:8)`;
    expect(serializeError(named).frames).toEqual(["at real (z.js:7:8)"]);
    const empty = Object.assign(new Error(""), {
      stack: "Error\n    at real (z.js:7:8)",
    });
    expect(serializeError(empty).frames).toEqual(["at real (z.js:7:8)"]);
  });

  it("no frames when the header length is unknown (non-string message)", () => {
    const e = { message: { toString: () => "a\nb" }, stack: "a\nb\n    at f (z.js:1:2)" };
    expect(serializeError(e).frames).toEqual([]);
  });

  it("keeps V8 frame shapes, drops function names that are not identifiers", () => {
    const e = new Error("m");
    e.stack = [
      "Error: m",
      "    at Foo.bar [as baz] (/app/dist/server.js:1:2)",
      "    at new Foo (/app/dist/server.js:3:4)",
      "    at async Object.<anonymous> (file:///app/dist/server.js:5:6)",
      "    at Foo.#priv (node:internal/x:7:8)",
      "    at /app/dist/server.js:9:10",
      "    at Pharmacy copay (/app/dist/server.js:11:12)",
      "    at Object.get payee [as payee] (/app/dist/server.js:13:14)",
      "    at Array.map (<anonymous>)",
    ].join("\n");
    expect(serializeError(e).frames).toEqual([
      "at Foo.bar [as baz] (/app/dist/server.js:1:2)",
      "at new Foo (/app/dist/server.js:3:4)",
      "at async Object.<anonymous> (file:///app/dist/server.js:5:6)",
      "at Foo.#priv (node:internal/x:7:8)",
      "at /app/dist/server.js:9:10",
    ]);
  });

  it("the logger uses it for `err` and redacts credentials and personal data", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(c: Buffer, _e, cb) {
        lines.push(c.toString());
        cb();
      },
    });
    const log = createLogger({ logLevel: "info", release: "t" }, stream);
    log.error(
      {
        err: pgError(),
        headers: { cookie: "__Host-ss_sid=COOKIEVALUE9", "x-csrf-token": "CSRFVALUE9" },
        password: "PASSWORDVALUE9",
        email: "a@b.test",
      },
      "boom",
    );
    const out = lines.join("");
    for (const leak of ["Joe", "4321", "COOKIEVALUE9", "CSRFVALUE9", "PASSWORDVALUE9", "a@b.test"])
      expect(out).not.toContain(leak);
    expect(out).toContain("transactions_payee_check");
  });
});

describe("error registry", () => {
  it("one code = one status, and every message is fixed text", () => {
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(
      Object.keys(ERROR_STATUS).sort(),
    );
  });

  it("VALIDATION_FAILED always has at least one detail; other codes omit an empty list", () => {
    const v = fromDalError(new DalError("VALIDATION_FAILED"))!;
    expect(toErrorBody(v, "rid12345").details).toHaveLength(1);
    expect(toErrorBody(new ApiError("NOT_FOUND"), "rid12345")).toEqual({
      code: "NOT_FOUND",
      message: "Not found.",
      requestId: "rid12345",
    });
  });

  it("carries Retry-After for DAL rate limits", () => {
    expect(
      fromDalError(new DalError("RATE_LIMITED", { retryAfterSeconds: 42 }))
        ?.retryAfterSeconds,
    ).toBe(42);
  });
});

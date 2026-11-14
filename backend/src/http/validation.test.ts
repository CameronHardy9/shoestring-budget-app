import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ipKey } from "./rate-limit.ts";
import {
  BudgetCreate,
  CategoryUpdate,
  LoginRequest,
  TransactionCreate,
} from "./schemas.ts";
import { cacheControlFor, wantsSpaFallback } from "./static.ts";
import {
  codePoints,
  email,
  optionalText,
  parseOrThrow,
  text,
} from "./validation.ts";

function details(schema: z.ZodType, input: unknown) {
  try {
    parseOrThrow(schema, input, "body");
  } catch (e) {
    return (e as { details: { field: string; issue: string }[] }).details.map(
      (d) => `${d.field}:${d.issue}`,
    );
  }
  return [];
}

describe("zod -> FieldError mapping", () => {
  it("required vs invalid_type vs unknown_field", () => {
    expect(details(LoginRequest, {})).toEqual([
      "email:required",
      "password:required",
    ]);
    expect(details(LoginRequest, { email: 1, password: true })).toEqual([
      "email:invalid_type",
      "password:invalid_type",
    ]);
    expect(
      details(LoginRequest, {
        email: "a@b.test",
        password: "x",
        remember: true,
      }),
    ).toEqual(["remember:unknown_field"]);
    expect(details(LoginRequest, undefined)).toEqual([":required"]);
  });

  it("nested paths use dotted indexes", () => {
    const d = details(TransactionCreate, {
      date: "2026-11-13",
      direction: "outflow",
      amountCents: 10,
      splits: [
        { categoryId: "01a1d7ab-0000-7000-8000-0000000000c1", amountCents: 10 },
        { categoryId: "x", amountCents: 0, extra: 1 },
      ],
    });
    expect(d).toEqual([
      "splits.1.categoryId:invalid_format",
      "splits.1.amountCents:too_small",
      "splits.1.extra:unknown_field",
    ]);
  });

  it("enums are invalid_value; lengths are too_short/too_long; numbers too_small/too_big", () => {
    expect(
      details(BudgetCreate, {
        name: "",
        timezone: "UTC",
        categories: [{ name: "a", kind: "x" }],
      }),
    ).toEqual(["name:too_short", "categories.0.kind:invalid_value"]);
    expect(details(CategoryUpdate, { sortOrder: 10_001, version: 0 })).toEqual([
      "sortOrder:too_big",
      "version:too_small",
    ]);
  });

  it("caps details at 50", () => {
    const many = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`f${i}`, 1]),
    );
    expect(
      details(LoginRequest, { email: "a@b.test", password: "x", ...many }),
    ).toHaveLength(50);
  });
});

describe("text rules (data-model.md 'Text')", () => {
  it("trims (incl. NBSP and zero-width space), NFC-normalizes and counts code points", () => {
    expect(parseOrThrow(text(1, 5), "\u00a0\u200b Cafe\u0301 \u200b", "body")).toBe("Café");
    expect(codePoints("\u{1F600}\u{1F600}")).toBe(2);
    expect(details(text(1, 2), "\u{1F600}\u{1F600}\u{1F600}")).toEqual([
      ":too_long",
    ]);
  });

  it("rejects control characters", () => {
    expect(details(text(1, 50), "a\u0007b")).toEqual([":invalid_value"]);
    expect(details(text(1, 50), "a\u0085b")).toEqual([":invalid_value"]);
  });

  it("optional text: empty becomes null; null stays null", () => {
    expect(parseOrThrow(optionalText(100), "   ", "body")).toBeNull();
    expect(parseOrThrow(optionalText(100), null, "body")).toBeNull();
  });

  it("emails are lowercased and limited to 254", () => {
    expect(parseOrThrow(email, "Pat@Example.TEST", "body")).toBe(
      "pat@example.test",
    );
    expect(details(email, `${"a".repeat(250)}@b.co`)).toContain(":too_long");
  });
});

describe("client IP keys (F-08)", () => {
  it("IPv4 in full; IPv6 by /64 prefix", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:db8:abcd:12::1")).toBe(
      ipKey("2001:db8:abcd:12:ffff::9"),
    );
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("static SPA caching", () => {
  it("hashed assets are immutable; the shell is no-cache", () => {
    expect(cacheControlFor("/x/assets/index-3f2a9c1b.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("/x/index.html")).toBe("no-cache");
    expect(cacheControlFor("/x/sw.js")).toBe("no-cache");
    expect(cacheControlFor("/x/manifest.webmanifest")).toBe("no-cache");
  });

  it("falls back to index.html only for non-API HTML navigations", () => {
    const req = (url: string, accept = "text/html") =>
      ({ method: "GET", url, headers: { accept } }) as never;
    expect(wantsSpaFallback(req("/budgets/1"))).toBe(true);
    expect(wantsSpaFallback(req("/api/budgets"))).toBe(false);
    expect(wantsSpaFallback(req("/budgets/1", "application/json"))).toBe(false);
  });
});

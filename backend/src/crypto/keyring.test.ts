import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CursorCodec } from "../domain/cursor.ts";
import {
  canonicalJson,
  idempotencyRequestHash,
} from "../domain/idempotency.ts";
import { parseKeyring, randomToken, safeEqual } from "./keyring.ts";

const key = () => randomBytes(32).toString("base64");

describe("APP_KEYRING", () => {
  it("validates shape, ids and 32-byte keys", () => {
    const k = parseKeyring(
      JSON.stringify({ current: "k2", keys: { k1: key(), k2: key() } }),
    );
    expect(k.currentKeyId).toBe("k2");
    expect(k.keyIds).toEqual(["k1", "k2"]);
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ current: "k1", keys: {} }),
      JSON.stringify({
        current: "k1",
        keys: { k1: randomBytes(16).toString("base64") },
      }),
      JSON.stringify({ current: "key1", keys: { key1: key() } }),
      JSON.stringify({ current: "k1", keys: { k1: key() }, extra: 1 }),
    ])
      expect(() => parseKeyring(bad)).toThrow();
  });

  it("derives distinct HKDF subkeys per use and per key, never the raw key", () => {
    const raw = key();
    const k = parseKeyring(
      JSON.stringify({ current: "k1", keys: { k1: raw, k2: key() } }),
    );
    const a = k.subkey("cursor-v1");
    expect(a).toHaveLength(32);
    expect(a.equals(Buffer.from(raw, "base64"))).toBe(false);
    expect(a.equals(k.subkey("throttle-v1"))).toBe(false);
    expect(a.equals(k.subkeyFor("k2", "cursor-v1"))).toBe(false);
    expect(() => k.subkeyFor("k9", "cursor-v1")).toThrow();
  });

  it("tokens are 43-character base64url; safeEqual is exact", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("cursor codec", () => {
  const ring = () =>
    parseKeyring(JSON.stringify({ current: "k1", keys: { k1: key() } }));
  const B = "01a1d7ab-0000-7000-8000-0000000000b1";
  const pos = {
    date: "2026-11-13",
    id: "01a1d7ab-0000-7000-8000-0000000000d1",
  };

  it("round-trips and fits the contract pattern", () => {
    const c = new CursorCodec(ring());
    const s = c.encode(B, { month: "2026-11" }, pos);
    expect(s).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(c.decode(B, { month: "2026-11" }, s)).toEqual(pos);
  });

  it("fails for another budget, other filters, another keyring or a tampered cursor", () => {
    const r = ring();
    const c = new CursorCodec(r);
    const s = c.encode(B, { categoryId: pos.id }, pos);
    expect(() =>
      c.decode(
        "01a1d7ab-0000-7000-8000-0000000000b2",
        { categoryId: pos.id },
        s,
      ),
    ).toThrow();
    expect(() => c.decode(B, {}, s)).toThrow();
    expect(() =>
      new CursorCodec(ring()).decode(B, { categoryId: pos.id }, s),
    ).toThrow();
    const raw = Buffer.from(s, "base64url");
    raw[5] = raw[5]! ^ 1;
    expect(() =>
      c.decode(B, { categoryId: pos.id }, raw.toString("base64url")),
    ).toThrow();
  });
});

describe("idempotency request hash", () => {
  it("drops undefined members and encodes a missing body as null", () => {
    expect(canonicalJson({ z: 1, m: undefined, a: null, c: "x", b: true })).toBe('{"a":null,"b":true,"c":"x","z":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("is canonical over key order and sensitive to every input", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    );
    const h = (
      m: string,
      p: string,
      params: Record<string, string>,
      body: unknown,
    ) => idempotencyRequestHash(m, p, params, body).toString("hex");
    const base = h(
      "POST",
      "/budgets/{budgetId}/transactions",
      { budgetId: "x" },
      { a: 1, b: 2 },
    );
    expect(
      h(
        "POST",
        "/budgets/{budgetId}/transactions",
        { budgetId: "x" },
        { b: 2, a: 1 },
      ),
    ).toBe(base);
    expect(
      h(
        "POST",
        "/budgets/{budgetId}/transactions",
        { budgetId: "y" },
        { a: 1, b: 2 },
      ),
    ).not.toBe(base);
    expect(h("POST", "/budgets", {}, { a: 1, b: 2 })).not.toBe(base);
    expect(
      h(
        "POST",
        "/budgets/{budgetId}/transactions",
        { budgetId: "x" },
        { a: 1, b: 3 },
      ),
    ).not.toBe(base);
  });
});

import { describe, expect, it } from "vitest";
import { newIdempotencyKey, uuidV4 } from "./ids.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidV4", () => {
  it("produces distinct RFC 9562 v4 UUIDs", () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidV4()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it("does not need crypto.randomUUID (insecure LAN contexts lack it)", () => {
    const original = crypto.randomUUID.bind(crypto);
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(newIdempotencyKey()).toMatch(V4);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });
});

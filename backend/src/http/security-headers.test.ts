import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { testEnv } from "../test-support/harness.ts";
import {
  REACT_ARIA_STYLE_HASHES,
  securityHeaders,
} from "./security-headers.ts";

function cspDirectives(): string[] {
  const csp = new Map(securityHeaders(loadConfig(testEnv()))).get(
    "content-security-policy",
  );
  if (!csp) throw new Error("no content-security-policy header");
  return csp.split("; ");
}

describe("content-security-policy", () => {
  it("allows exactly the two React Aria style hashes (owner decision 2026-11-14)", () => {
    const style = cspDirectives().filter((d) => d.startsWith("style-src"));
    expect(style).toEqual([
      "style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='",
    ]);
  });

  it("never allows inline code by keyword or nonce", () => {
    for (const d of cspDirectives()) {
      expect(d).not.toMatch(/'unsafe-|'nonce-|'strict-dynamic'/);
      if (!d.startsWith("style-src")) expect(d).not.toContain("'sha256-");
    }
    expect(cspDirectives()).toContain("script-src 'self'");
  });

  // Drift guard: read as text so backend does not depend on the frontend
  // package. The frontend test recomputes these hashes from react-aria.
  it("carries the same style hashes as frontend/src/security/csp.ts", () => {
    const source = readFileSync(
      new URL("../../../frontend/src/security/csp.ts", import.meta.url),
      "utf8",
    );
    const frontend = [...source.matchAll(/sha256-[A-Za-z0-9+/]{43}=/g)].map(
      (m) => m[0],
    );
    expect(frontend.length).toBeGreaterThan(0);
    expect([...new Set(frontend)].sort()).toEqual(
      [...REACT_ARIA_STYLE_HASHES].sort(),
    );
  });
});

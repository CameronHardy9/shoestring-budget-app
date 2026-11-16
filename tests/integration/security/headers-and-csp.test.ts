// Security headers and CSP (ARCHITECTURE "Security headers", F-23, checklist
// C3.1-C3.3).
//   - CSP drift contract test: the backend's style-src is exactly
//     "style-src " + the frontend's STYLE_SRC, and the whole policy matches
//     ARCHITECTURE.md directive by directive (Sentry parts only with SENTRY_DSN).
//   - C3.2: every route class the e2e stack's backend serves carries every header.
//     The SPA document, static files and the SPA fallback are served by the
//     backend only from a production build (STATIC_DIR); the e2e stack serves
//     the SPA from the Vite dev server, so those classes are covered in Phase B
//     against the production build (F-53).
//   - C3.3 (dev half): session cookie attributes; Secure and the __Host- prefix
//     exist only with COOKIE_SECURE=true (production image, Phase B).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STYLE_SRC } from "../../../frontend/src/security/csp.ts";
import { createUserWithTotp, passwordLogin } from "../../support/auth.ts";
import { ApiClient, COOKIE_NAME } from "../../support/http.ts";
import type { ApiResponse } from "../../support/http.ts";
import { seedWorld } from "../../support/world.ts";

const architecture = readFileSync(
  fileURLToPath(new URL("../../../docs/ARCHITECTURE.md", import.meta.url)),
  "utf8",
);

/** The CSP line in ARCHITECTURE.md, as directive → value. */
function documentedCsp(): Map<string, string> {
  const m = /`Content-Security-Policy: ([^`]+)`/.exec(architecture);
  if (!m)
    throw new Error("ARCHITECTURE.md has no Content-Security-Policy line");
  return parseCsp(m[1]!);
}

function parseCsp(header: string): Map<string, string> {
  return new Map(
    header
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name!, rest.join(" ")] as [string, string];
      }),
  );
}

const EXPECTED_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function expectSecurityHeaders(res: ApiResponse): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS))
    expect(res.header(name), `${name} on ${res.describe}`).toBe(value);
  const csp = res.header("content-security-policy");
  expect(csp, `CSP on ${res.describe}`).toBeDefined();
  expect(parseCsp(csp!).get("frame-ancestors"), res.describe).toBe("'none'");
}

describe("CSP drift contract test (C3.1, ARCHITECTURE 'Drift rule')", () => {
  it("the backend's style-src equals 'style-src ' + the frontend's STYLE_SRC", async () => {
    const res = await new ApiClient("anonymous").get("/healthz");
    const directive = res
      .header("content-security-policy")!
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("style-src "));
    expect(directive).toBe(`style-src ${STYLE_SRC}`);
  });

  it("the whole policy matches ARCHITECTURE.md (Sentry host and report-to appear only with SENTRY_DSN)", async () => {
    const res = await new ApiClient("anonymous").get("/healthz");
    const actual = parseCsp(res.header("content-security-policy")!);
    const documented = documentedCsp();
    documented.set("connect-src", "'self'"); // no SENTRY_DSN in the e2e stack
    documented.delete("report-to");
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(documented));
    expect(res.header("reporting-endpoints")).toBeUndefined();
  });

  it("no unsafe-inline, unsafe-eval, unsafe-hashes, nonce or strict-dynamic anywhere; hashes only in style-src", async () => {
    const res = await new ApiClient("anonymous").get("/healthz");
    const csp = res.header("content-security-policy")!;
    expect(csp).not.toMatch(/unsafe-|nonce-|strict-dynamic/);
    for (const [name, value] of parseCsp(csp))
      if (name !== "style-src") expect(value, name).not.toMatch(/sha256-/);
    expect(parseCsp(csp).get("script-src")).toBe("'self'");
  });
});

describe("C3.2: security headers on every route class the backend serves", () => {
  it("success, error, empty, CSV, framework-error and non-API responses all carry every header", async () => {
    const w = await seedWorld();
    const anon = new ApiClient("anonymous");
    const responses: ApiResponse[] = [
      await anon.get("/healthz"),
      await anon.get("/readyz"),
      await anon.get("/readyz", { host: "10.0.0.9:8080" }), // probe host
      await w.owner.client.get("/me"),
      await w.owner.client.get(
        `/budgets/${w.budget.id}/months/2026-11/summary`,
      ),
      await w.owner.client.post(`/budgets/${w.budget.id}/categories`, {
        name: "Header check",
        kind: "expense",
      }), // 201
      await w.owner.client.post("/me/export", { kind: "transactions" }), // text/csv
      await anon.get("/me"), // 401
      await w.member.client.patch(`/budgets/${w.budget.id}`, {
        name: "x",
        version: 1,
      }), // 403
      await w.outsider.client.get(`/budgets/${w.budget.id}`), // 404 budget
      await anon.get("/api/does-not-exist"), // 404 route
      await anon.request("OPTIONS", "/api/me"), // 404 method
      await anon.get("/me", { host: "evil.example" }), // 400 Host
      await anon.post("/auth/login", { email: "x" }), // 400 schema
      await anon.request("POST", "/api/auth/login", {
        rawBody: "x",
        contentType: "text/plain",
      }), // 415
      await anon.request("POST", "/api/auth/login", {
        rawBody: JSON.stringify({ pad: "x".repeat(70_000) }),
        contentType: "application/json",
      }), // 413
      await w.owner.client.post(
        `/budgets/${w.budget.id}/transactions`,
        { date: w.today },
        { idempotencyKey: randomUUID() },
      ), // 400 body
      await anon.raw("GET", "/not-an-api-path"), // non-API 404 ErrorBody
      await anon.raw("GET", "/", { headers: { accept: "text/html" } }), // no STATIC_DIR in the e2e stack: 404
      await w.member.client.post("/auth/logout"), // 204
    ];
    for (const res of responses) expectSecurityHeaders(res);
    expect(new Set(responses.map((r) => r.status))).toEqual(
      new Set([200, 201, 204, 400, 401, 403, 404, 413, 415]),
    );
  });

  it("a rate-limited (429) answer carries every header too", async () => {
    const anon = new ApiClient("anonymous");
    let res = await anon.get("/healthz");
    while (res.status !== 429) res = await anon.get("/healthz");
    expectSecurityHeaders(res);
  });
});

describe("C3.3 (dev half): session cookie attributes", () => {
  function attrs(line: string): Record<string, string> {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const out: Record<string, string> = { name: pair!.split("=")[0]! };
    for (const a of rest) {
      const [k, v] = a.split("=");
      out[k!.toLowerCase()] = v ?? "true";
    }
    return out;
  }

  it("sign-in sets HttpOnly; SameSite=Strict; Path=/; Max-Age 30 days, with no Domain", async () => {
    const w = await seedWorld();
    const res = await new ApiClient("x").post("/auth/login", {
      email: w.owner.user.email,
      password: w.owner.user.password,
    });
    const cookie = attrs(
      res.setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))!,
    );
    expect(cookie).toMatchObject({
      httponly: "true",
      samesite: "Strict",
      path: "/",
      "max-age": String(30 * 24 * 3600),
    });
    expect(cookie.domain).toBeUndefined();
  });

  it("an MFA-pending session cookie lives 10 minutes; logout clears the cookie (Max-Age=0)", async () => {
    const u = await createUserWithTotp();
    const login = await new ApiClient("x").post("/auth/login", {
      email: u.email,
      password: u.password,
    });
    expect(
      attrs(login.setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))!)[
        "max-age"
      ],
    ).toBe("600");
    const { client } = await passwordLogin(u);
    const out = await client.post("/auth/logout");
    expect(out.status).toBe(204);
    const cleared = attrs(
      out.setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))!,
    );
    expect(cleared["max-age"]).toBe("0");
    expect(client.sessionToken).toBeNull();
  });

  it("session and CSRF tokens never appear in a response body other than AuthState's csrfToken", async () => {
    const w = await seedWorld();
    const token = w.owner.client.sessionToken!;
    for (const path of ["/me", "/me/sessions", "/auth/session", "/budgets"]) {
      const res = await w.owner.client.get(path);
      expect(res.text.includes(token), path).toBe(false);
    }
  });
});

// Unknown routes and methods (errors.md "Unknown routes and unimplemented
// operations"): any /api path or method the contract does not define answers
// 404 NOT_FOUND in ErrorBody at check-order step 1 (no 405, no 501), including
// HEAD and OPTIONS. Generated from the contract's path table.
import { describe, expect, it } from "vitest";
import { matchOperation, operations, spec } from "../support/contract.ts";
import { ApiClient, codeOf } from "../support/http.ts";
import { persona } from "../support/world.ts";

const PLACEHOLDER = "0190a0a0-0000-7000-8000-000000000000";
const ALL_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const concrete = (p: string) =>
  `/api${p.replace(/\{month\}/g, "2026-11").replace(/\{\w+\}/g, PLACEHOLDER)}`;

// A literal path with an undefined method can still match a parameterised
// route of that method (PUT .../plan/copy-previous is putPlanEntry with a bad
// categoryId, answered 400): those are defined routes, not unknown ones.
const undefinedMethods = Object.entries(spec.paths).flatMap(([path, item]) => {
  const defined = new Set(Object.keys(item).map((m) => m.toUpperCase()));
  return ALL_METHODS.filter((m) => !defined.has(m))
    .filter((m) => !matchOperation(m, concrete(path).slice(4)))
    .map((m) => [`${m} ${path}`, m, concrete(path)] as const);
});

function expect404(
  res: {
    status: number;
    headers: Record<string, unknown>;
    body: unknown;
    describe: string;
  },
  method: string,
): void {
  expect(res.status, res.describe).toBe(404);
  // HEAD has no body by definition; everything else carries ErrorBody NOT_FOUND.
  if (method !== "HEAD")
    expect(codeOf(res as never), res.describe).toBe("NOT_FOUND");
}

describe("methods the contract does not list for a path → 404 NOT_FOUND", () => {
  it.each(undefinedMethods)("%s", async (_label, method, path) => {
    const p = await persona("caller");
    expect404(
      await p.client.request(method, path, { contract: method !== "HEAD" }),
      method,
    );
  });
});

describe("paths the contract does not define → 404 NOT_FOUND", () => {
  const unknown = [
    "/api",
    "/api/",
    "/api/nope",
    "/api/me/",
    "/api/budgets/" + PLACEHOLDER + "/secret",
    "/api/admin",
    "/api/_internal/reset",
    "/api/v2/me",
    "/api/me/sessions/" + PLACEHOLDER + "/extra",
    "/api/healthz/../me",
  ];
  it.each(
    unknown.flatMap((p) =>
      ["GET", "POST", "DELETE"].map((m) => [`${m} ${p}`, m, p] as const),
    ),
  )("%s", async (_label, method, path) => {
    expect404(await new ApiClient("anonymous").request(method, path), method);
  });

  it("an unknown route answers 404 before the session check, CSRF and the global rate limit (step 1)", async () => {
    const c = new ApiClient("anonymous");
    // No session, foreign Origin: still 404, not 401 or 403.
    expect404(
      await c.request("POST", "/api/me/nope", {
        origin: "https://evil.example",
        body: {},
      }),
      "POST",
    );
    // Exhaust the global per-IP limit (300 / minute), then an unknown route is still 404.
    let limited = false;
    for (let i = 0; i < 310 && !limited; i++)
      limited = (await c.get("/healthz")).status === 429;
    expect(limited, "global limit never answered 429").toBe(true);
    expect(codeOf(await c.get("/me"))).toBe("RATE_LIMITED");
    expect404(await c.get("/api/nope"), "GET");
  });

  it("every contract operation is reachable (none answers 404 for its own route)", async () => {
    // A defined route never answers the unknown-route 404 to an anonymous call,
    // except budget-scoped ones, which may 404 only after authentication.
    const c = new ApiClient("anonymous");
    for (const op of operations.filter((o) => o.session !== "none" && o.session !== "optional")) {
      const res = await c.request(op.method, concrete(op.path));
      expect(res.status, res.describe).toBe(401);
    }
  });
});

describe("request bodies on GET are ignored (errors.md \"Request bodies\")", () => {
  // Owner ruling 2026-11-16 (was BUG-1): the body rules (415, 413, `{}`-only)
  // apply to POST, PUT, PATCH and DELETE. A GET body is never parsed, size-
  // checked or validated, and never the cause of an error. Every GET operation
  // is covered in contract/rejections.test.ts; these pin the plain cases.
  it("GET with a JSON body other than {} is accepted (200)", async () => {
    const res = await new ApiClient("anonymous").get("/healthz", {
      body: { stray: 1 },
    });
    expect(res.status, res.describe).toBe(200);
  });

  it("GET with a text/plain body is accepted (200), not 415", async () => {
    const res = await new ApiClient("anonymous").get("/healthz", {
      rawBody: "hello",
      contentType: "text/plain",
    });
    expect(res.status, res.describe).toBe(200);
  });

  it("GET with an empty {} body is accepted (200)", async () => {
    expect(
      (await new ApiClient("anonymous").get("/healthz", { body: {} })).status,
    ).toBe(200);
  });
});

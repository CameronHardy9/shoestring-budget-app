// The contract oracle itself (support/contract.ts) must catch violations;
// otherwise every suite would be green for the wrong reason. Pure: fabricated
// responses, no network.
import { describe, expect, it } from "vitest";
import {
  allowedErrorCodes,
  errorStatus,
  matchOperation,
  operation,
  operations,
  validateResponse,
} from "../support/contract.ts";
import type { ObservedResponse } from "../support/contract.ts";
import { NOTIFICATIONS, emailProblems } from "../support/emails.ts";
import { env } from "../support/env.ts";

const RID = "0190a0a0-0000-7000-8000-000000000001";
function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ObservedResponse {
  return {
    status,
    body,
    text: body === undefined ? "" : JSON.stringify(body),
    headers: {
      "x-request-id": RID,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  };
}
const req = (method: string, path: string) => ({
  method,
  path,
  requestId: RID,
  hostOk: true,
});
const err = (code: string, extra: object = {}) => ({
  code,
  message: "x",
  requestId: RID,
  ...extra,
});

describe("contract oracle", () => {
  it("parses all operations, the error registry and the §15 notification table", () => {
    expect(operations.length).toBe(63);
    expect(errorStatus.get("VALIDATION_FAILED")).toBe(400);
    expect(errorStatus.get("RATE_LIMITED")).toBe(429);
    expect(NOTIFICATIONS.get("new_sign_in")?.priority).toBe(true);
    expect(NOTIFICATIONS.get("password_reset")?.priority).toBe(false);
  });

  it("matches literal segments before parameters", () => {
    expect(
      matchOperation("POST", "/me/sessions/revoke-others")?.op.operationId,
    ).toBe("revokeOtherSessions");
    expect(
      matchOperation("DELETE", `/me/sessions/${RID}`)?.op.operationId,
    ).toBe("revokeSession");
  });

  it("accepts a conforming response", () => {
    expect(
      validateResponse(
        req("GET", "/api/healthz"),
        res(200, { status: "ok", version: "dev" }),
      ),
    ).toEqual([]);
  });

  it("flags an extra response field, a missing X-Request-Id, a missing no-store and a CORS header", () => {
    expect(
      validateResponse(
        req("GET", "/api/healthz"),
        res(200, { status: "ok", version: "dev", extra: 1 }),
      ).join(),
    ).toMatch(/body/);
    const r = res(
      200,
      { status: "ok", version: "dev" },
      { "access-control-allow-origin": "*" },
    );
    delete r.headers["x-request-id"];
    delete r.headers["cache-control"];
    const p = validateResponse(req("GET", "/api/healthz"), r).join("\n");
    expect(p).toMatch(/X-Request-Id/);
    expect(p).toMatch(/no-store/);
    expect(p).toMatch(/CORS/);
  });

  it("flags a code answered with the wrong status, a code the operation may not answer, and any 500", () => {
    expect(
      validateResponse(
        req("GET", "/api/me"),
        res(403, err("UNAUTHENTICATED")),
      ).join(),
    ).toMatch(/errors.md maps it to 401/);
    expect(
      validateResponse(
        req("GET", "/api/me"),
        res(409, err("CATEGORY_IN_USE")),
      ).join(),
    ).toMatch(/neither x-error-codes/);
    expect(
      validateResponse(req("GET", "/api/me"), res(500, err("INTERNAL"))).join(),
    ).toMatch(/server error/);
    expect(
      validateResponse(
        req("GET", "/api/me"),
        res(400, err("VALIDATION_FAILED")),
      ).join(),
    ).toMatch(/without details/);
    expect(
      validateResponse(
        req("POST", "/api/auth/login"),
        res(429, err("RATE_LIMITED")),
      ).join(),
    ).toMatch(/Retry-After/);
  });

  it("flags an undocumented success status and a success on an unknown route", () => {
    expect(
      validateResponse(req("GET", "/api/me"), res(201, {})).join(),
    ).toMatch(/contract lists 200/);
    expect(
      validateResponse(req("GET", "/api/nope"), res(200, {})).join(),
    ).toMatch(/not a contract operation/);
    expect(
      validateResponse(
        req("GET", "/api/nope"),
        res(401, err("UNAUTHENTICATED")),
      ).join(),
    ).toMatch(/expected 404/);
  });

  it("derives implicit codes from the x- extensions (errors.md 'Implicit codes')", () => {
    const codes = allowedErrorCodes(operation("deleteBudget"));
    for (const c of [
      "UNAUTHENTICATED",
      "MFA_REQUIRED",
      "ACCOUNT_PENDING_DELETION",
      "CSRF_FAILED",
      "NOT_FOUND",
      "FORBIDDEN",
      "REAUTH_REQUIRED",
    ])
      expect(codes.has(c), c).toBe(true);
    expect(
      allowedErrorCodes(operation("getHealthz")).has("UNAUTHENTICATED"),
    ).toBe(false);
    expect(
      allowedErrorCodes(operation("getMe")).has("ACCOUNT_PENDING_DELETION"),
    ).toBe(false);
  });

  it("allows 413 and 415 only on POST, PUT, PATCH and DELETE (errors.md 'Request bodies')", () => {
    for (const op of operations) {
      const codes = allowedErrorCodes(op);
      const takesBody = op.method !== "GET";
      expect(codes.has("PAYLOAD_TOO_LARGE"), `${op.operationId} 413`).toBe(
        takesBody,
      );
      expect(codes.has("UNSUPPORTED_MEDIA_TYPE"), `${op.operationId} 415`).toBe(
        takesBody,
      );
    }
    expect(
      validateResponse(
        req("GET", "/api/me"),
        res(415, err("UNSUPPORTED_MEDIA_TYPE")),
      ).join(),
    ).toMatch(/getMe answered UNSUPPORTED_MEDIA_TYPE/);
  });

  it("flags an email with an unknown kind, the wrong priority or a link outside §15", () => {
    const mail = {
      to: "a@example.test",
      subject: "s",
      sentAt: "",
      priority: true,
      kind: "new_sign_in",
      links: [`${env.appOrigin}/settings/sessions`],
    };
    expect(emailProblems(mail)).toEqual([]);
    expect(emailProblems({ ...mail, kind: "welcome" }).join()).toMatch(
      /vocabulary/,
    );
    expect(emailProblems({ ...mail, priority: false }).join()).toMatch(
      /P column/,
    );
    expect(
      emailProblems({
        ...mail,
        links: [`${env.appOrigin}/settings/security`],
      }).join(),
    ).toMatch(/not the auth.md §15 path/);
    expect(
      emailProblems({
        ...mail,
        links: ["https://evil.example/settings/sessions"],
      }).join(),
    ).toMatch(/APP_ORIGIN/);
    expect(
      emailProblems({
        ...mail,
        kind: "signup_invite",
        links: [`${env.appOrigin}/signup#token=${"a".repeat(43)}`],
      }),
    ).toEqual([]);
  });
});

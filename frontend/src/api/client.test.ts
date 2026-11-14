import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, onUnauthenticated, unwrap } from "./client.ts";
import { ApiError, NetworkError, UnexpectedResponseError } from "./errors.ts";
import { newIdempotencyKey } from "./ids.ts";
import {
  clearSessionMemory,
  getLastRequestId,
  setCsrfToken,
} from "./session.ts";

const BUDGET = "0194f5c2-0000-7000-8000-000000000001";
const CATEGORY = "0194f5c2-0000-7000-8000-000000000002";

function json(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function setup(...responses: (Response | Error | DOMException)[]) {
  const requests: Request[] = [];
  // openapi-fetch always calls fetch with a Request object.
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (!(input instanceof Request)) throw new Error("expected a Request");
    requests.push(input);
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return next instanceof Response
      ? Promise.resolve(next)
      : Promise.reject(next);
  });
  return {
    api: createApiClient({ baseUrl: "http://app.test/api", fetch }),
    requests,
  };
}

const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: "server text",
  requestId: "srv-req-0001",
  ...extra,
});

afterEach(() => {
  clearSessionMemory();
});

describe("request headers", () => {
  it("sends a fresh X-Request-Id per request and same-origin credentials", async () => {
    const { api, requests } = setup(
      json(200, { items: [] }),
      json(200, { items: [] }),
    );
    await unwrap(api.GET("/budgets"));
    await unwrap(api.GET("/budgets"));
    const [a, b] = requests;
    expect(a!.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(a!.headers.get("X-Request-Id")).not.toBe(
      b!.headers.get("X-Request-Id"),
    );
    expect(a!.credentials).toBe("same-origin");
    expect(a!.cache).toBe("no-store");
    expect(a!.url).toBe("http://app.test/api/budgets");
  });

  it("adds X-CSRF-Token on unsafe methods only, from memory", async () => {
    const { api, requests } = setup(
      json(200, { items: [] }),
      json(204, null),
      json(204, null),
    );
    await unwrap(api.POST("/auth/logout"));
    setCsrfToken("c".repeat(43));
    await unwrap(api.GET("/budgets"));
    await unwrap(api.POST("/auth/logout"));
    expect(requests[0]!.headers.has("X-CSRF-Token")).toBe(false);
    expect(requests[1]!.headers.has("X-CSRF-Token")).toBe(false);
    expect(requests[2]!.headers.get("X-CSRF-Token")).toBe("c".repeat(43));
  });

  it("sends no Content-Type without a body, JSON with one", async () => {
    const { api, requests } = setup(json(204, null), json(201, {}));
    await unwrap(api.POST("/auth/logout"));
    await unwrap(
      api.POST("/budgets/{budgetId}/transactions", {
        params: {
          path: { budgetId: BUDGET },
          header: { "Idempotency-Key": newIdempotencyKey() },
        },
        body: {
          date: "2026-11-14",
          direction: "outflow",
          amountCents: 1250,
          splits: [{ categoryId: CATEGORY, amountCents: 1250 }],
        },
      }),
    );
    expect(requests[0]!.headers.has("Content-Type")).toBe(false);
    expect(requests[1]!.headers.get("Content-Type")).toBe("application/json");
    expect(await requests[1]!.json()).toMatchObject({ amountCents: 1250 });
  });

  it("retries a create with the same Idempotency-Key and a new request ID", async () => {
    const { api, requests } = setup(
      new TypeError("Failed to fetch"),
      json(201, {}),
    );
    const key = newIdempotencyKey();
    const save = () =>
      unwrap(
        api.POST("/budgets/{budgetId}/transactions", {
          params: {
            path: { budgetId: BUDGET },
            header: { "Idempotency-Key": key },
          },
          body: {
            date: "2026-11-14",
            direction: "outflow",
            amountCents: 100,
            splits: [{ categoryId: CATEGORY, amountCents: 100 }],
          },
        }),
      );
    await expect(save()).rejects.toBeInstanceOf(NetworkError);
    await save();
    expect(requests.map((r) => r.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
    ]);
    expect(requests[0]!.headers.get("X-Request-Id")).not.toBe(
      requests[1]!.headers.get("X-Request-Id"),
    );
  });

  it("remembers the server's request ID for diagnostics", async () => {
    const { api } = setup(
      json(200, { items: [] }, { "X-Request-Id": "srv-req-0002" }),
    );
    await unwrap(api.GET("/budgets"));
    expect(getLastRequestId()).toBe("srv-req-0002");
  });
});

describe("errors", () => {
  it("maps ErrorBody to ApiError with details and Retry-After", async () => {
    const details = [
      { in: "body", field: "splits", issue: "sum_mismatch", message: "x" },
    ];
    const { api } = setup(
      json(422, errorBody("SPLITS_DO_NOT_SUM", { details })),
      json(429, errorBody("RATE_LIMITED"), { "Retry-After": "30" }),
    );
    const first = await unwrap(api.GET("/budgets")).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ApiError);
    expect(first).toMatchObject({
      status: 422,
      code: "SPLITS_DO_NOT_SUM",
      requestId: "srv-req-0001",
      details,
      retryAfterSeconds: null,
    });
    const second = await unwrap(api.GET("/budgets")).catch((e: unknown) => e);
    expect(second).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });
  });

  it("notifies listeners on UNAUTHENTICATED only", async () => {
    const listener = vi.fn();
    const off = onUnauthenticated(listener);
    const { api } = setup(
      json(401, errorBody("UNAUTHENTICATED")),
      json(401, errorBody("INVALID_CREDENTIALS")),
    );
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      unwrap(
        api.POST("/auth/login", {
          body: { email: "a@example.com", password: "x" },
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("treats non-ErrorBody failures as unexpected responses", async () => {
    const { api } = setup(
      new Response("<html>Bad gateway</html>", {
        status: 502,
        headers: { "X-Request-Id": "proxy-0001" },
      }),
      json(400, errorBody("NOT_A_REAL_CODE")),
      json(400, errorBody("VALIDATION_FAILED", { details: [{ field: 1 }] })),
    );
    for (let i = 0; i < 3; i++) {
      await expect(unwrap(api.GET("/budgets"))).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
    }
  });

  it("wraps fetch failures as NetworkError but lets aborts through", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const { api } = setup(new TypeError("Load failed"), abort);
    await expect(unwrap(api.GET("/budgets"))).rejects.toBeInstanceOf(
      NetworkError,
    );
    await expect(unwrap(api.GET("/budgets"))).rejects.toBe(abort);
  });
});

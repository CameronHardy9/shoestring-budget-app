// Stubs global fetch for component tests: routes by "METHOD /api/path" (path
// may contain :params), records every request, and answers JSON.
import { vi } from "vitest";

export interface Recorded {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Reply =
  { status: number; body?: unknown; headers?: Record<string, string> } | Error;
type Handler = (
  req: Recorded,
  params: Record<string, string>,
) => Reply | Promise<Reply>;

export function json(
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): Reply {
  return { status, body, ...(headers ? { headers } : {}) };
}

export function apiError(
  status: number,
  code: string,
  details?: unknown[],
): Reply {
  return json(status, {
    code,
    message: "server text",
    requestId: "test-req-0001",
    ...(details ? { details } : {}),
  });
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const p = a[i] ?? "";
    if (p.startsWith(":")) params[p.slice(1)] = b[i] ?? "";
    else if (p !== b[i]) return null;
  }
  return params;
}

export function mockApi(routes: Record<string, Handler | Reply>) {
  const calls: Recorded[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const text = await request.text();
    const rec: Recorded = {
      method: request.method,
      path: url.pathname.replace(/^\/api/, ""),
      search: url.searchParams,
      headers: request.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    calls.push(rec);
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern = ""] = key.split(" ");
      if (method !== rec.method) continue;
      const params = match(pattern, rec.path);
      if (!params) continue;
      const reply =
        typeof handler === "function" ? await handler(rec, params) : handler;
      if (reply instanceof Error) throw reply;
      return new Response(
        reply.status === 204 || reply.body === undefined
          ? null
          : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { "Content-Type": "application/json", ...reply.headers },
        },
      );
    }
    return new Response(
      JSON.stringify({
        code: "NOT_FOUND",
        message: "no mock",
        requestId: "test-req-404",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    find: (method: string, path: string | RegExp) =>
      calls.filter(
        (c) =>
          c.method === method &&
          (typeof path === "string" ? c.path === path : path.test(c.path)),
      ),
  };
}

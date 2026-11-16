// A minimal HTTP client for the API suites, on node:http so every header is
// under the test's control (Host, Origin, Sec-Fetch-Site, raw bodies, HEAD and
// OPTIONS). One ApiClient = one browser: it keeps its own session cookie and
// the in-memory CSRF token from the last AuthState, like the SPA does.
//
// Every response is checked against the contract (support/contract.ts); a
// violation fails the test at once with the operation, status and problem, so a
// red test names the area that broke.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { validateResponse } from "./contract.ts";
import { appHost, env } from "./env.ts";

export const COOKIE_NAME = "ss_sid"; // COOKIE_SECURE=false in the e2e stack (auth.md §2)

const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const target = new URL(env.apiUrl);

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON body (serialized with Content-Type: application/json). */
  body?: unknown;
  /** Raw body bytes; `contentType` decides the header. */
  rawBody?: string | Buffer;
  /** Content-Type for rawBody; null sends none. */
  contentType?: string | null;
  headers?: Record<string, string>;
  /** Origin header on unsafe methods: APP_ORIGIN by default, null to omit. */
  origin?: string | null;
  /** Send X-CSRF-Token (unsafe methods, when a session exists). Default true; a string overrides it. */
  csrf?: boolean | string;
  /** Host header; default APP_ORIGIN's host. */
  host?: string;
  /** Send the session cookie (default true). */
  cookie?: boolean;
  idempotencyKey?: string;
  /** X-Request-Id to send (a fresh UUID by default; null to omit). */
  requestId?: string | null;
  /** Check the response against the contract (default true; false only for /api/_test hooks). */
  contract?: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed JSON, or undefined for an empty or non-JSON body. */
  body: T;
  header(name: string): string | undefined;
  /** Every Set-Cookie line of the response. */
  setCookies: string[];
  /** `METHOD /path -> status CODE` for assertion messages. */
  describe: string;
}

export class ContractViolation extends Error {
  override name = "ContractViolation";
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function rawRequest(
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent,
        host: target.hostname,
        port: target.port,
        method,
        path: pathWithQuery,
        headers: {
          ...headers,
          ...(body ? { "content-length": String(body.length) } : {}),
        },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let clientCount = 0;

export class ApiClient {
  sessionToken: string | null = null;
  csrfToken: string | null = null;
  readonly label: string;
  /** Last AuthState / Me user id seen (for assertions). */
  userId: string | null = null;

  constructor(label = `client-${++clientCount}`) {
    this.label = label;
  }

  /** `path` is relative to /api (`/me`) unless it already starts with /api or is outside it (`/x`, with `raw`). */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const full =
      path.startsWith("/api") || path.startsWith("//") ? path : `/api${path}`;
    return this.send<T>(method.toUpperCase(), full, opts);
  }

  /** A path outside /api (SPA fallback, unknown non-API paths). */
  async raw<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.send<T>(method.toUpperCase(), path, opts);
  }

  private async send<T>(
    method: string,
    fullPath: string,
    opts: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      host: opts.host ?? appHost,
      accept: "application/json",
    };
    const rid = opts.requestId === undefined ? randomUUID() : opts.requestId;
    if (rid !== null) headers["x-request-id"] = rid;
    if (UNSAFE.has(method)) {
      const origin = opts.origin === undefined ? env.appOrigin : opts.origin;
      if (origin !== null) headers.origin = origin;
      if (opts.csrf !== false && this.csrfToken && opts.cookie !== false)
        headers["x-csrf-token"] =
          typeof opts.csrf === "string" ? opts.csrf : this.csrfToken;
      else if (typeof opts.csrf === "string")
        headers["x-csrf-token"] = opts.csrf;
    }
    if (opts.cookie !== false && this.sessionToken)
      headers.cookie = `${COOKIE_NAME}=${this.sessionToken}`;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    let body: Buffer | null = null;
    if (opts.rawBody !== undefined) {
      body = Buffer.isBuffer(opts.rawBody)
        ? opts.rawBody
        : Buffer.from(opts.rawBody, "utf8");
      if (opts.contentType !== null)
        headers["content-type"] = opts.contentType ?? "application/json";
    } else if (opts.body !== undefined) {
      body = Buffer.from(JSON.stringify(opts.body), "utf8");
      headers["content-type"] = "application/json";
    }
    Object.assign(headers, lowerKeys(opts.headers ?? {}));

    const pathWithQuery = withQuery(fullPath, opts.query);
    const r = await rawRequest(method, pathWithQuery, headers, body);
    let parsed: unknown = undefined;
    if (
      r.text &&
      (r.headers["content-type"] ?? "").startsWith("application/json")
    ) {
      try {
        parsed = JSON.parse(r.text);
      } catch {
        parsed = undefined;
      }
    }
    const setCookies = ([] as string[]).concat(r.headers["set-cookie"] ?? []);
    const code = (parsed as { code?: unknown } | undefined)?.code;
    const res: ApiResponse<T> = {
      status: r.status,
      headers: r.headers,
      text: r.text,
      body: parsed as T,
      setCookies,
      header: (n) => {
        const v = r.headers[n.toLowerCase()];
        return Array.isArray(v) ? v.join(", ") : v;
      },
      describe: `${method} ${fullPath} -> ${r.status}${typeof code === "string" ? ` ${code}` : ""}`,
    };

    if (opts.contract !== false) {
      const problems = validateResponse(
        {
          method,
          path: fullPath,
          requestId: rid ?? undefined,
          hostOk: headers.host === appHost,
        },
        res,
      );
      if (problems.length)
        throw new ContractViolation(
          `[contract] ${res.describe} (${this.label}):\n  - ${problems.join("\n  - ")}\n  body: ${r.text.slice(0, 500)}`,
        );
    }
    this.absorb(res);
    return res;
  }

  /** Cookie rotation and the in-memory CSRF token, like the SPA. */
  private absorb(res: ApiResponse): void {
    for (const line of res.setCookies) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (pair!.slice(0, eq).trim() !== COOKIE_NAME) continue;
      const value = pair!.slice(eq + 1).trim();
      const maxAge = /max-age=(\d+)/i.exec(line)?.[1];
      this.sessionToken = value && maxAge !== "0" ? value : null;
      if (!this.sessionToken) this.csrfToken = null;
    }
    const b = res.body as
      { csrfToken?: unknown; user?: { id?: unknown } } | undefined;
    if (res.status < 300 && b && typeof b.csrfToken === "string")
      this.csrfToken = b.csrfToken;
    if (res.status < 300 && b && typeof b.user?.id === "string")
      this.userId = b.user.id;
  }

  get<T = unknown>(
    path: string,
    opts?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(
      "POST",
      path,
      body === undefined ? opts : { ...opts, body },
    );
  }
  put<T = unknown>(
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(
      "PUT",
      path,
      body === undefined ? opts : { ...opts, body },
    );
  }
  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(
      "PATCH",
      path,
      body === undefined ? opts : { ...opts, body },
    );
  }
  delete<T = unknown>(
    path: string,
    opts?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", path, opts);
  }

  /** A second browser holding the same cookie (to replay a stolen or stale session). */
  clone(label = `${this.label}-copy`): ApiClient {
    const c = new ApiClient(label);
    c.sessionToken = this.sessionToken;
    c.csrfToken = this.csrfToken;
    c.userId = this.userId;
    return c;
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

/** ErrorBody code of a response (undefined for success). */
export function codeOf(res: ApiResponse): string | undefined {
  const c = (res.body as { code?: unknown } | undefined)?.code;
  return typeof c === "string" ? c : undefined;
}

export interface FieldErrorBody {
  in: string;
  field: string;
  issue: string;
  message: string;
}

export function detailsOf(res: ApiResponse): FieldErrorBody[] {
  return (
    (res.body as { details?: FieldErrorBody[] } | undefined)?.details ?? []
  );
}

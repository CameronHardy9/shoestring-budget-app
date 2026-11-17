// The only way the app calls the API. A thin layer over the openapi-fetch
// client generated from docs/contracts/api.openapi.yaml:
// - same-origin cookies only (credentials: "same-origin"; the session cookie
//   is httpOnly and never touched by script)
// - X-Request-Id on every request (a new one per attempt, errors.md)
// - X-CSRF-Token on unsafe methods, from memory (auth.md §3)
// - non-2xx answers become typed errors (ApiError / UnexpectedResponseError),
//   failed fetches become NetworkError
//
// Idempotency-Key is a required header parameter in the contract, so the
// generated types make every create call pass one (see ids.ts).
//
//   const budget = await unwrap(api.GET("/budgets/{budgetId}", {
//     params: { path: { budgetId } },
//   }));
import createClient, { type Client, type Middleware } from "openapi-fetch";
import {
  ApiError,
  isErrorBody,
  NetworkError,
  parseRetryAfter,
  UnexpectedResponseError,
} from "./errors.ts";
import { uuidV4 } from "./ids.ts";
import type { paths } from "./schema.gen.ts";
import { reportError } from "../observability/report.ts";
import { getCsrfToken, setLastRequestId } from "./session.ts";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const REQUEST_ID_HEADER = "X-Request-Id";
export const CSRF_HEADER = "X-CSRF-Token";

const headersMiddleware: Middleware = {
  onRequest({ request }) {
    const requestId = uuidV4();
    request.headers.set(REQUEST_ID_HEADER, requestId);
    setLastRequestId(requestId);
    const csrf = getCsrfToken();
    if (csrf !== null && UNSAFE_METHODS.has(request.method.toUpperCase())) {
      request.headers.set(CSRF_HEADER, csrf);
    }
    return request;
  },
  onResponse({ response }) {
    const echoed = response.headers.get(REQUEST_ID_HEADER);
    if (echoed !== null) setLastRequestId(echoed);
    return response;
  },
};

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Defaults to "/api" (same origin). */
  baseUrl?: string;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const client = createClient<paths>({
    // Same origin. Absolute (from location) so non-browser fetch
    // implementations such as Node's, used by tests, accept it too.
    baseUrl:
      options.baseUrl ??
      (typeof window === "undefined"
        ? "/api"
        : `${window.location.origin}/api`),
    credentials: "same-origin",
    // Never let the HTTP cache keep API data (the server also sends no-store).
    cache: "no-store",
    headers: { Accept: "application/json" },
    // Resolve fetch at call time (not at module load), so tests can stub it.
    fetch:
      options.fetch ??
      ((input: Request | string | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)),
  });
  client.use(headersMiddleware);
  return client;
}

/** The app's client. */
export const api: ApiClient = createApiClient();

type UnauthenticatedListener = (error: ApiError) => void;
const unauthenticatedListeners = new Set<UnauthenticatedListener>();

/**
 * Called on every 401 UNAUTHENTICATED (the only code that means "signed out").
 * The app shell clears in-memory state and shows sign-in, keeping unsaved input.
 */
export function onUnauthenticated(
  listener: UnauthenticatedListener,
): () => void {
  unauthenticatedListeners.add(listener);
  return () => unauthenticatedListeners.delete(listener);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

interface ApiResult<D> {
  data?: D;
  error?: unknown;
  response: Response;
}

/**
 * Resolves to the response data, or throws ApiError, UnexpectedResponseError
 * or NetworkError. An AbortError (the caller cancelled) is rethrown as is.
 */
export async function unwrap<D>(request: Promise<ApiResult<D>>): Promise<D> {
  let result: ApiResult<D>;
  try {
    result = await request;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new NetworkError({ cause: error });
  }
  const { response } = result;
  if (response.ok) return result.data as D;

  if (isErrorBody(result.error)) {
    const error = new ApiError(
      response.status,
      result.error,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
    if (error.code === "UNAUTHENTICATED") {
      for (const listener of unauthenticatedListeners) listener(error);
    }
    throw error;
  }
  const unexpected = new UnexpectedResponseError(
    response.status,
    response.headers.get(REQUEST_ID_HEADER),
  );
  // Not a contract ErrorBody (a proxy's page, a broken body): the backend may
  // never have seen it, so it goes to error tracking, tagged with the
  // requestId. ApiErrors are not reported here: the backend reports its 5xx
  // and 4xx are expected (errors.md).
  reportError(unexpected, { type: "api", handled: true });
  throw unexpected;
}

// The request pipeline, in errors.md check order:
//   0 Host  1 route exists  2 global rate limit  3 session  4 CSRF (+ writes
//   limit)  5 pending deletion  -- body parsing: 415/413 --  then per route
//   (routes.ts): 6 schema  7 endpoint limit  8 membership  9 role  10 re-auth.
// Deny by default: an /api route without contract metadata never gets here
// (registerRoutes refuses to start), and the error handler emits only ErrorBody.
import type { BudgetScope } from "@shoestring/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../auth/session.ts";
import { resolveSession, setSessionCookie } from "../auth/session.ts";
import type { ContractOperation } from "../contract/types.ts";
import { safeEqual } from "../crypto/keyring.ts";
import type { AppDeps } from "../deps.ts";
import {
  ApiError,
  fieldError,
  fromDalError,
  toErrorBody,
  validationFailed,
} from "../errors.ts";
import type { ErrorCode } from "../errors.ts";
import { MINUTE, ipKey } from "./rate-limit.ts";
import { ContractViolation } from "./response-validation.ts";
import { securityHeaders } from "./security-headers.ts";

export interface RequestState {
  auth: AuthContext | null;
  scope: BudgetScope | null;
  errorCode: ErrorCode | null;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The contract operation this route implements (set only by registerRoutes). */
    op?: ContractOperation;
    /** Dev-entry hooks: Host + Origin checks only (test-hooks.md "Behaviour"). */
    devHook?: boolean;
  }
  interface FastifyRequest {
    ss: RequestState;
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HOST_EXEMPT = new Set(["/api/healthz", "/api/readyz"]);

export const GLOBAL_LIMIT_PER_MINUTE = 300;
export const WRITES_LIMIT_PER_MINUTE = 120;

function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

/** auth.md §3 step 1 (F-23). */
export function checkHost(deps: AppDeps, req: FastifyRequest): void {
  if (req.method === "GET" && HOST_EXEMPT.has(pathOf(req.url))) return;
  if (req.headers.host !== deps.config.appHost)
    throw validationFailed([fieldError("header", "Host", "invalid_value")]);
}

/** auth.md §3 step 2: exact Origin, or Sec-Fetch-Site: same-origin when Origin is absent. */
export function checkOrigin(deps: AppDeps, req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin !== deps.config.appOrigin) throw new ApiError("CSRF_FAILED");
    return;
  }
  if (req.headers["sec-fetch-site"] !== "same-origin")
    throw new ApiError("CSRF_FAILED");
}

async function authenticate(
  deps: AppDeps,
  req: FastifyRequest,
  op: ContractOperation,
): Promise<void> {
  if (op.session === "none") return; // public: any cookie is ignored
  const auth = await resolveSession(deps, req);
  const status = auth?.session.status;
  switch (op.session) {
    case "optional":
      break;
    case "active":
      if (!auth) throw new ApiError("UNAUTHENTICATED");
      if (status === "mfa_pending") throw new ApiError("MFA_REQUIRED");
      break;
    case "mfa_pending":
      if (!auth) throw new ApiError("UNAUTHENTICATED");
      if (status === "active") throw new ApiError("FORBIDDEN");
      break;
    case "active_or_mfa_pending":
      if (!auth) throw new ApiError("UNAUTHENTICATED");
      break;
  }
  req.ss.auth = auth;
}

function csrf(deps: AppDeps, req: FastifyRequest, op: ContractOperation): void {
  if (!UNSAFE.has(req.method)) return;
  checkOrigin(deps, req);
  const auth = req.ss.auth;
  if (op.session !== "none" && auth) {
    const sent = req.headers["x-csrf-token"];
    if (typeof sent !== "string" || !safeEqual(sent, auth.session.csrfToken))
      throw new ApiError("CSRF_FAILED");
  }
}

async function onRequest(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  req.ss = { auth: null, scope: null, errorCode: null };
  reply.header("x-request-id", req.id);
  for (const [k, v] of securityHeaders(deps.config)) reply.header(k, v);
  if (pathOf(req.url).startsWith("/api"))
    reply.header("cache-control", "no-store");

  checkHost(deps, req); // 0
  const config = req.routeOptions.config;
  if (config.devHook === true) {
    // Hooks bypass CSRF tokens and rate limits; Origin must match or be absent.
    if (
      req.headers.origin !== undefined &&
      req.headers.origin !== deps.config.appOrigin
    )
      throw new ApiError("CSRF_FAILED");
    return;
  }
  const op = config.op;
  if (!op) return; // 1: unknown route (404 handler) or static asset

  deps.limiter.hit("global", ipKey(req.ip), GLOBAL_LIMIT_PER_MINUTE, MINUTE); // 2
  await authenticate(deps, req, op); // 3
  csrf(deps, req, op); // 4
  const auth = req.ss.auth;
  if (auth && UNSAFE.has(req.method))
    deps.limiter.hit(
      "writes",
      auth.session.userId,
      WRITES_LIMIT_PER_MINUTE,
      MINUTE,
    );
  if (
    auth &&
    auth.userStatus === "pending_deletion" &&
    !op.pendingDeletionAllowed
  )
    throw new ApiError("ACCOUNT_PENDING_DELETION"); // 5

  // Sliding expiry (auth.md §2): refresh at most hourly and re-send the cookie.
  if (auth && auth.session.status === "active" && op.session !== "optional") {
    const touched = await deps.dal.sessions.touchSession(auth.session.id);
    if (touched) setSessionCookie(deps, reply, auth.token, touched.expiresAt);
  }
}

const DB_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

/** Driver errors that mean "the database is unreachable" -> 503 UNAVAILABLE. */
function isDatabaseUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (
    typeof e.code === "string" &&
    (DB_UNAVAILABLE_CODES.has(e.code) || e.code.startsWith("08"))
  )
    return true;
  return (
    typeof e.message === "string" &&
    e.message.includes("timeout exceeded when trying to connect")
  );
}

/** Maps anything thrown to an ApiError; `internal` marks the 5xx that need a log line. */
export function toApiError(err: unknown): { api: ApiError; internal: boolean } {
  if (err instanceof ApiError) return { api: err, internal: err.status >= 500 };
  const dal = fromDalError(err);
  if (dal) return { api: dal, internal: false };
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
    return { api: new ApiError("PAYLOAD_TOO_LARGE"), internal: false };
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
    return { api: new ApiError("UNSUPPORTED_MEDIA_TYPE"), internal: false };
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP_"))
    return {
      api: validationFailed([fieldError("body", "", "invalid_format")]),
      internal: false,
    };
  if (isDatabaseUnavailable(err))
    return { api: new ApiError("UNAVAILABLE"), internal: true };
  return { api: new ApiError("INTERNAL"), internal: true };
}

export function sendError(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  const { api, internal } = toApiError(err);
  if (internal) {
    // F-07: only the allowlisted fields (name, SQLSTATE, constraint, table,
    // column, stack frames). Never message/detail/hint/query/params/values.
    req.log.error(
      {
        err, // serialized by the F-07 allowlist serializer (logging.ts)
        ...(err instanceof ContractViolation
          ? {
              contract: {
                operationId: err.operationId,
                status: err.status,
                problems: err.problems,
              },
            }
          : {}),
      },
      "request failed",
    );
  }
  // ss is null when Fastify fails before onRequest (e.g. a malformed URL).
  const ss = req.ss as RequestState | null;
  if (ss) ss.errorCode = api.code;
  const body = toErrorBody(api, req.id);
  if (api.retryAfterSeconds !== undefined)
    reply.header("retry-after", String(api.retryAfterSeconds));
  reply.header("x-request-id", req.id);
  reply.header("cache-control", "no-store");
  return reply
    .code(api.status)
    .type("application/json; charset=utf-8")
    .send(body);
}

export function registerPipeline(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest("ss", null as unknown as RequestState);
  app.addHook("onRequest", (req, reply) => onRequest(deps, req, reply));
  app.setErrorHandler((err, req, reply) => sendError(deps, req, reply, err));
  app.addHook("onResponse", (req, reply, done) => {
    const ss = req.ss as RequestState | null;
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? null,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        userId: ss?.auth?.session.userId ?? null,
        budgetId: ss?.scope?.budgetId ?? null,
        code: ss?.errorCode ?? null,
      },
      "request",
    );
    done();
  });
}

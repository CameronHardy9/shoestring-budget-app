// Small helpers shared by the route modules.
import type { BudgetScope, SecurityEventInput } from "@shoestring/db";
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "../auth/session.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";

export function mustAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new ApiError("UNAUTHENTICATED");
  return auth;
}

export function mustScope(scope: BudgetScope | null): BudgetScope {
  if (!scope) throw new ApiError("NOT_FOUND");
  return scope;
}

/** Records a security event; IP only for sign-in events (R-6). */
export async function recordEvent(
  deps: AppDeps,
  input: SecurityEventInput,
): Promise<void> {
  await deps.dal.securityEvents.recordSecurityEvent(input);
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/**
 * Fixed-latency responses (auth.md §14, F-22): waits until `targetMs` after
 * the request started, so timing does not reveal whether an account exists.
 */
export async function padUntil(
  deps: AppDeps,
  startedAt: number,
  targetMs = 1_000,
): Promise<void> {
  const remaining = startedAt + targetMs - deps.wallNow();
  if (remaining > 0) await deps.sleep(remaining);
}

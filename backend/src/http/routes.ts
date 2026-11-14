// Contract-driven route table (auth.md §12, ADR-0006). Routes are declared by
// operationId; method, path and the x-* extensions come from the generated
// contract, so they cannot drift. registerRoutes refuses to start when an
// operation lacks its extensions, when a {budgetId} path is not budget-scoped,
// when {deletedBudgetId} is misdeclared, or when a route's schemas disagree
// with the contract. Per-route checks run in errors.md order 6-10.
import type { BudgetScope, DeletedBudgetScope } from "@shoestring/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../auth/session.ts";
import { hasFreshReauth } from "../auth/session.ts";
import { operations } from "../contract/contract.gen.ts";
import type { ContractOperation } from "../contract/types.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError, fieldError, validationFailed } from "../errors.ts";
import { noBody, noQuery, parseOrThrow, uuid } from "./validation.ts";

export interface RouteContext<P, Q, B> {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly deps: AppDeps;
  readonly op: ContractOperation;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  /** The unparsed JSON body (for the idempotency request hash). */
  readonly rawBody: unknown;
  readonly auth: AuthContext | null;
  /** Set for x-budget-role member/owner routes (from requireMembership only). */
  readonly scope: BudgetScope | null;
  /** Set for x-budget-role deleted_budget_owner routes (from requireDeletedBudgetOwnership only, F-36). */
  readonly deletedScope: DeletedBudgetScope | null;
  /** Set for x-idempotency: required routes. */
  readonly idempotencyKey: string | null;
  /** Wall-clock start of the request (ms), for fixed-latency responses. */
  readonly startedAt: number;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}

export interface RouteDef<P, Q, B> {
  operationId: string;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  /** errors.md step 7: endpoint rate limits (auth.md §14). */
  rateLimit?: (ctx: RouteContext<P, Q, B>) => Promise<void>;
  handler: (ctx: RouteContext<P, Q, B>) => Promise<RouteResult>;
}

/** A route with its generics erased (what registerRoutes takes). */
export interface Route {
  readonly operationId: string;
  readonly paramKeys: readonly string[] | null;
  readonly hasBody: boolean;
  execute(base: BaseContext): Promise<RouteResult>;
}

export interface BaseContext {
  req: FastifyRequest;
  reply: FastifyReply;
  deps: AppDeps;
  op: ContractOperation;
  startedAt: number;
}

function shapeKeys(schema: unknown): string[] | null {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : null;
}

export function defineRoute<
  P = Record<string, never>,
  Q = Record<string, never>,
  B = undefined,
>(def: RouteDef<P, Q, B>): Route {
  return {
    operationId: def.operationId,
    paramKeys: def.params ? shapeKeys(def.params) : [],
    hasBody: def.body !== undefined,
    async execute({ req, reply, deps, op, startedAt }) {
      // 6: schema validation of path, query, headers, body.
      const params = (
        def.params ? parseOrThrow(def.params, req.params, "path") : {}
      ) as P;
      const query = (
        def.query
          ? parseOrThrow(def.query, req.query, "query")
          : parseOrThrow(noQuery, req.query, "query")
      ) as Q;
      let idempotencyKey: string | null = null;
      if (op.idempotency) {
        const raw = req.headers["idempotency-key"];
        if (raw === undefined)
          throw validationFailed([
            fieldError("header", "Idempotency-Key", "required"),
          ]);
        const parsed = uuid.safeParse(raw);
        if (!parsed.success)
          throw validationFailed([
            fieldError("header", "Idempotency-Key", "invalid_format"),
          ]);
        idempotencyKey = parsed.data;
      }
      const body = (
        def.body
          ? parseOrThrow(def.body, req.body, "body")
          : parseOrThrow(noBody, req.body, "body")
      ) as B;
      const ctx: RouteContext<P, Q, B> = {
        req,
        reply,
        deps,
        op,
        params,
        query,
        body,
        rawBody: req.body,
        auth: req.ss.auth,
        scope: null,
        deletedScope: null,
        idempotencyKey,
        startedAt,
      };
      // 7: endpoint rate limit.
      if (def.rateLimit) await def.rateLimit(ctx);
      // 8-9: membership, then role.
      let scope: BudgetScope | null = null;
      if (op.budgetRole === "member" || op.budgetRole === "owner") {
        const auth = req.ss.auth;
        const budgetId = (params as { budgetId?: unknown }).budgetId;
        if (!auth || typeof budgetId !== "string")
          throw new ApiError("NOT_FOUND");
        scope = await deps.dal.requireMembership(auth.session.userId, budgetId);
        req.ss.scope = scope;
        if (op.budgetRole === "owner" && scope.role !== "owner")
          throw new ApiError("FORBIDDEN");
      }
      let deletedScope: DeletedBudgetScope | null = null;
      if (op.budgetRole === "deleted_budget_owner") {
        const auth = req.ss.auth;
        const id = (params as { deletedBudgetId?: unknown }).deletedBudgetId;
        if (!auth || typeof id !== "string") throw new ApiError("NOT_FOUND");
        deletedScope = await deps.dal.requireDeletedBudgetOwnership(auth.session.userId, id);
      }
      // 10: re-authentication window.
      if (op.reauth) {
        const auth = req.ss.auth;
        if (!auth || !hasFreshReauth(auth.session, deps.clock.now()))
          throw new ApiError("REAUTH_REQUIRED");
      }
      return def.handler({ ...ctx, scope, deletedScope });
    },
  };
}

/** `/budgets/{budgetId}` -> `/api/budgets/:budgetId` */
export function fastifyPath(path: string): string {
  return `/api${path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1")}`;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] ?? "");
}

/** Contract-wide invariants (auth.md §12, F-18, F-36). Throws on the first violation. */
export function checkContract(ops: readonly ContractOperation[]): void {
  const ids = new Set<string>();
  for (const op of ops) {
    if (ids.has(op.operationId))
      throw new Error(`duplicate operationId ${op.operationId}`);
    ids.add(op.operationId);
    const params = pathParams(op.path);
    if (
      params.includes("budgetId") &&
      op.budgetRole !== "member" &&
      op.budgetRole !== "owner"
    )
      throw new Error(
        `${op.operationId}: {budgetId} path must be member or owner`,
      );
    if (
      params.includes("deletedBudgetId") !==
      (op.budgetRole === "deleted_budget_owner")
    )
      throw new Error(
        `${op.operationId}: deleted_budget_owner iff {deletedBudgetId}`,
      );
    if (
      (op.budgetRole === "member" || op.budgetRole === "owner") &&
      !params.includes("budgetId")
    )
      throw new Error(`${op.operationId}: budget role without {budgetId}`);
    if (op.reauth && op.session !== "active")
      throw new Error(`${op.operationId}: x-reauth requires an active session`);
  }
}

export function registerRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  routes: readonly Route[],
  ops: readonly ContractOperation[] = operations,
): void {
  checkContract(ops);
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  const seen = new Set<string>();
  for (const route of routes) {
    const op = byId.get(route.operationId);
    if (!op)
      throw new Error(`route ${route.operationId} is not in the contract`);
    if (seen.has(route.operationId))
      throw new Error(`route ${route.operationId} registered twice`);
    seen.add(route.operationId);
    const expected = pathParams(op.path).sort();
    const declared = [...(route.paramKeys ?? [])].sort();
    if (expected.join(",") !== declared.join(","))
      throw new Error(
        `${op.operationId}: path params do not match the contract`,
      );
    if ((op.requestBody !== null) !== route.hasBody)
      throw new Error(
        `${op.operationId}: request body does not match the contract`,
      );
    app.route({
      method: op.method,
      url: fastifyPath(op.path),
      config: { op },
      handler: async (req, reply) => {
        const result = await route.execute({
          req,
          reply,
          deps,
          op,
          startedAt: deps.wallNow(),
        });
        deps.responseValidator?.check(op, result.status, result.body);
        for (const [k, v] of Object.entries(result.headers ?? {}))
          if (v !== undefined) reply.header(k, v);
        reply.code(result.status);
        return result.body === undefined
          ? reply.send()
          : reply.send(result.body);
      },
    });
  }
}

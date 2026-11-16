// The contract as data: docs/contracts/api.openapi.yaml (operations, schemas,
// x- extensions) and the errors.md code registry, loaded at test time so the
// suites always check against the current contract, never a copy.
//
// validateResponse() is the oracle every API response in tests/ goes through
// (support/http.ts calls it on each response): status listed, body matches the
// schema, ErrorBody code allowed for the operation and mapped to its one HTTP
// status, X-Request-Id, Cache-Control: no-store, no CORS headers, never a 500.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const docPath = (rel: string): string =>
  fileURLToPath(new URL(`../../docs/contracts/${rel}`, import.meta.url));

export type JsonSchema = Record<string, unknown>;

interface RawParameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: JsonSchema;
  $ref?: string;
}

interface RawOperation {
  operationId: string;
  parameters?: RawParameter[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: JsonSchema }>;
  };
  responses: Record<
    string,
    {
      $ref?: string;
      content?: Record<string, { schema: JsonSchema }>;
      headers?: Record<string, unknown>;
    }
  >;
  "x-session":
    "none" | "optional" | "mfa_pending" | "active" | "active_or_mfa_pending";
  "x-budget-role": "none" | "member" | "owner" | "deleted_budget_owner";
  "x-reauth": boolean;
  "x-pending-deletion-allowed"?: boolean;
  "x-idempotency"?: "required";
  "x-rate-limit"?: string[];
  "x-error-codes"?: string[];
}

interface RawDoc {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JsonSchema>;
    parameters: Record<string, RawParameter>;
    responses: Record<
      string,
      { content?: Record<string, { schema: JsonSchema }> }
    >;
  };
}

export interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: JsonSchema;
}

export interface Operation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Contract path, e.g. `/budgets/{budgetId}` (served under /api). */
  path: string;
  pathRegex: RegExp;
  pathParams: string[];
  parameters: Parameter[];
  /** JSON schema of the body, or null when the operation takes no body. */
  requestBody: JsonSchema | null;
  /** Status → JSON schema (null for no body / non-JSON). */
  successStatuses: Map<
    number,
    { schema: JsonSchema | null; contentType: string | null }
  >;
  session: RawOperation["x-session"];
  budgetRole: RawOperation["x-budget-role"];
  reauth: boolean;
  pendingDeletionAllowed: boolean;
  idempotency: boolean;
  rateLimits: string[];
  errorCodes: string[];
}

export const spec = parseYaml(
  readFileSync(docPath("api.openapi.yaml"), "utf8"),
) as RawDoc;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function resolveParam(p: RawParameter): Parameter {
  const raw = p.$ref
    ? spec.components.parameters[p.$ref.split("/").pop()!]!
    : p;
  return {
    name: raw.name,
    in: raw.in,
    required: raw.required === true,
    schema: raw.schema,
  };
}

function buildOperations(): Operation[] {
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    const shared = ((item.parameters ?? []) as RawParameter[]).map(
      resolveParam,
    );
    for (const m of METHODS) {
      const raw = item[m] as RawOperation | undefined;
      if (!raw) continue;
      const own = (raw.parameters ?? []).map(resolveParam);
      const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
      const pathRegex = new RegExp(
        `^${path.replace(/\{\w+\}/g, "([^/]+)").replace(/\//g, "\\/")}$`,
      );
      const successStatuses = new Map<
        number,
        { schema: JsonSchema | null; contentType: string | null }
      >();
      for (const [status, resp] of Object.entries(raw.responses)) {
        if (!/^2\d\d$/.test(status)) continue;
        const content = resp.content ?? {};
        const json = content["application/json"];
        const other = Object.keys(content).find(
          (k) => k !== "application/json",
        );
        successStatuses.set(Number(status), {
          schema: json ? json.schema : null,
          contentType: json ? "application/json" : (other ?? null),
        });
      }
      ops.push({
        operationId: raw.operationId,
        method: m.toUpperCase() as Operation["method"],
        path,
        pathRegex,
        pathParams,
        parameters: [...shared, ...own],
        requestBody:
          raw.requestBody?.content["application/json"]?.schema ?? null,
        successStatuses,
        session: raw["x-session"],
        budgetRole: raw["x-budget-role"],
        reauth: raw["x-reauth"],
        pendingDeletionAllowed: raw["x-pending-deletion-allowed"] === true,
        idempotency: raw["x-idempotency"] === "required",
        rateLimits: raw["x-rate-limit"] ?? [],
        errorCodes: raw["x-error-codes"] ?? [],
      });
    }
  }
  return ops;
}

export const operations: readonly Operation[] = buildOperations();

export function operation(operationId: string): Operation {
  const op = operations.find((o) => o.operationId === operationId);
  if (!op) throw new Error(`no operation ${operationId} in api.openapi.yaml`);
  return op;
}

/** The operation a request hits (path without /api and query), with its path params. */
export function matchOperation(
  method: string,
  apiPath: string,
): { op: Operation; params: Record<string, string> } | null {
  // Literal segments win over parameters (e.g. /me/sessions/revoke-others).
  const candidates = operations
    .filter((o) => o.method === method.toUpperCase())
    .map((o) => ({ o, m: o.pathRegex.exec(apiPath) }))
    .filter((x) => x.m)
    .sort((a, b) => a.o.pathParams.length - b.o.pathParams.length);
  const hit = candidates[0];
  if (!hit?.m) return null;
  const params: Record<string, string> = {};
  hit.o.pathParams.forEach(
    (n, i) => (params[n] = decodeURIComponent(hit.m![i + 1]!)),
  );
  return { op: hit.o, params };
}

export function pathExists(apiPath: string): boolean {
  return operations.some((o) => o.pathRegex.test(apiPath));
}

// ---------------------------------------------------------------- errors.md
/** errors.md "Code registry": one code, one HTTP status. */
export const errorStatus: ReadonlyMap<string, number> = (() => {
  const text = readFileSync(docPath("errors.md"), "utf8");
  const map = new Map<string, number>();
  for (const m of text.matchAll(/^\| (\d{3}) \| `([A-Z_]+)` \|/gm))
    map.set(m[2]!, Number(m[1]));
  if (map.size < 20)
    throw new Error("could not parse the errors.md code registry");
  return map;
})();

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Codes errors.md assigns to one operation in prose without the OpenAPI
 * `x-error-codes` listing them. Each entry cites its source; see the report's
 * contract notes (architect) for aligning x-error-codes.
 */
const PROSE_CODES: Record<string, string[]> = {
  // errors.md MFA_REQUIRED row and auth.md §8 step 4.
  completePasswordReset: ["MFA_REQUIRED"],
};

/** Every code an operation may answer (errors.md "Implicit codes" + x-error-codes). */
export function allowedErrorCodes(op: Operation): Set<string> {
  // Every operation: INTERNAL, RATE_LIMITED, UNAVAILABLE. VALIDATION_FAILED,
  // 413 and 415 apply to every route too: a body other than {} on an operation
  // without a body, an unknown query parameter, or a foreign Host.
  const codes = new Set([
    "INTERNAL",
    "RATE_LIMITED",
    "UNAVAILABLE",
    "VALIDATION_FAILED",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    ...op.errorCodes,
    ...(PROSE_CODES[op.operationId] ?? []),
  ]);
  if (op.session !== "none" && op.session !== "optional")
    codes.add("UNAUTHENTICATED");
  if (op.session === "active") {
    codes.add("MFA_REQUIRED");
    if (!op.pendingDeletionAllowed) codes.add("ACCOUNT_PENDING_DELETION");
  }
  if (UNSAFE.has(op.method)) codes.add("CSRF_FAILED");
  if (op.budgetRole !== "none") codes.add("NOT_FOUND");
  if (op.budgetRole === "owner") codes.add("FORBIDDEN");
  if (op.reauth) codes.add("REAUTH_REQUIRED");
  return codes;
}

// ---------------------------------------------------------------- schemas
/** components.schemas with refs rewritten for Ajv (`#/$defs/X`) and OpenAPI-only keywords removed. */
function toAjvSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toAjvSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "discriminator") continue; // OpenAPI-only; oneOf already decides
    if (k === "$ref" && typeof v === "string")
      out[k] = v.replace("#/components/schemas/", "contract#/$defs/");
    else out[k] = toAjvSchema(v);
  }
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
// Global rule: "Timestamps are RFC 3339 UTC with `Z`".
ajv.addFormat(
  "date-time",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
);
ajv.addSchema({
  $id: "contract",
  $defs: toAjvSchema(spec.components.schemas) as object,
});

const validators = new Map<string, ValidateFunction>();
export function validatorFor(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile(toAjvSchema(schema) as object);
    validators.set(key, v);
  }
  return v;
}

/** Resolves a top-level `$ref` into components.schemas (for generators and tests). */
export function resolveSchema(schema: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref === "string")
    return resolveSchema(spec.components.schemas[ref.split("/").pop()!]!);
  return schema;
}

export function schemaErrors(
  schema: JsonSchema,
  value: unknown,
): string | null {
  const v = validatorFor(schema);
  if (v(value)) return null;
  return ajv.errorsText(v.errors, { separator: "; " });
}

const errorBody = { $ref: "#/components/schemas/ErrorBody" };
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export interface ObservedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: unknown;
}

export interface ObservedRequest {
  method: string;
  /** Full path including /api, without the query string. */
  path: string;
  requestId?: string | undefined;
  hostOk: boolean;
}

function header(res: ObservedResponse, name: string): string | undefined {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Problems with one response against the contract; [] when it conforms. */
export function validateResponse(
  req: ObservedRequest,
  res: ObservedResponse,
): string[] {
  const problems: string[] = [];
  const rid = header(res, "x-request-id");
  if (!rid || !REQUEST_ID.test(rid))
    problems.push(`X-Request-Id missing or malformed (${String(rid)})`);
  else if (
    req.requestId &&
    REQUEST_ID.test(req.requestId) &&
    rid !== req.requestId
  )
    problems.push(
      "X-Request-Id does not echo the request's valid X-Request-Id",
    );
  if (
    req.path.startsWith("/api") &&
    header(res, "cache-control") !== "no-store"
  )
    problems.push(
      `Cache-Control is ${String(header(res, "cache-control"))}, expected no-store`,
    );
  for (const k of Object.keys(res.headers))
    if (k.startsWith("access-control-"))
      problems.push(`CORS header ${k} present (contract: no CORS)`);
  if (res.status >= 500 && res.status !== 503)
    problems.push(`server error ${res.status}: ${res.text.slice(0, 200)}`);

  const isError = res.status >= 400;
  const apiPath = req.path.replace(/^\/api(?=\/|$)/, "");
  const match = req.path.startsWith("/api")
    ? matchOperation(req.method, apiPath)
    : null;

  if (isError) {
    const ct = header(res, "content-type") ?? "";
    if (!ct.startsWith("application/json"))
      problems.push(`error content-type is ${ct}`);
    const err = schemaErrors(errorBody, res.body);
    if (err) {
      problems.push(`ErrorBody schema: ${err}`);
      return problems;
    }
    const body = res.body as {
      code: string;
      requestId: string;
      details?: unknown[];
    };
    const want = errorStatus.get(body.code);
    if (want !== res.status)
      problems.push(
        `code ${body.code} answered with ${res.status}, errors.md maps it to ${String(want)}`,
      );
    if (body.requestId !== rid)
      problems.push("ErrorBody.requestId differs from X-Request-Id");
    if (body.code === "VALIDATION_FAILED" && !body.details?.length)
      problems.push("VALIDATION_FAILED without details");
    if (body.code === "RATE_LIMITED") {
      const ra = header(res, "retry-after");
      if (!ra || !/^[1-9]\d*$/.test(ra))
        problems.push(
          `RATE_LIMITED without a valid Retry-After (${String(ra)})`,
        );
    }
    if (!match) {
      // Unknown route (errors.md "Unknown routes"): 404 at step 1, or the Host check at step 0.
      const ok =
        (res.status === 404 && body.code === "NOT_FOUND") ||
        (!req.hostOk && body.code === "VALIDATION_FAILED");
      if (!ok)
        problems.push(
          `unknown route answered ${res.status} ${body.code}, expected 404 NOT_FOUND`,
        );
    } else if (!allowedErrorCodes(match.op).has(body.code)) {
      problems.push(
        `${match.op.operationId} answered ${body.code}, which neither x-error-codes nor errors.md "Implicit codes" allow`,
      );
    }
    return problems;
  }

  if (!match) {
    problems.push(
      `${req.method} ${req.path} is not a contract operation but answered ${res.status}`,
    );
    return problems;
  }
  const { op } = match;
  const success = op.successStatuses.get(res.status);
  if (!success) {
    problems.push(
      `${op.operationId} answered ${res.status}, contract lists ${[...op.successStatuses.keys()].join(", ")}`,
    );
    return problems;
  }
  if (success.schema) {
    const ct = header(res, "content-type") ?? "";
    if (!ct.startsWith("application/json"))
      problems.push(`${op.operationId} ${res.status} content-type ${ct}`);
    const err = schemaErrors(success.schema, res.body);
    if (err) problems.push(`${op.operationId} ${res.status} body: ${err}`);
  } else if (success.contentType) {
    const ct = header(res, "content-type") ?? "";
    if (!ct.startsWith(success.contentType))
      problems.push(
        `${op.operationId} content-type ${ct}, expected ${success.contentType}`,
      );
  } else if (res.text.length > 0) {
    problems.push(
      `${op.operationId} ${res.status} has a body but the contract defines none`,
    );
  }
  return problems;
}

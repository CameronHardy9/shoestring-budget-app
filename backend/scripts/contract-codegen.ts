// Builds src/contract/contract.gen.ts from docs/contracts/api.openapi.yaml:
// the operation table (method, path, x-* extensions, parameters, responses)
// and the component schemas as JSON Schema 2020-12 `$defs` for response
// validation. Pure function so the staleness test can call it.
import { parse } from "yaml";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const SESSIONS = new Set([
  "none",
  "optional",
  "mfa_pending",
  "active",
  "active_or_mfa_pending",
]);
const ROLES = new Set(["none", "member", "owner", "deleted_budget_owner"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function refName(ref: unknown, kind: string): string {
  if (typeof ref !== "string" || !ref.startsWith(`#/components/${kind}/`))
    throw new Error(`unexpected $ref ${String(ref)}`);
  return ref.slice(`#/components/${kind}/`.length);
}

/** Rewrites component refs to `$defs` refs and drops OpenAPI-only keywords. */
function toJsonSchema(node: unknown): Json {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!isObj(node)) return node as Json;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(node)) {
    // `discriminator` is OpenAPI-only; the oneOf branches already exclude each
    // other through their `const` properties.
    if (k === "discriminator") continue;
    if (k === "$ref") {
      out.$ref = `#/$defs/${refName(v, "schemas")}`;
      continue;
    }
    out[k] = toJsonSchema(v);
  }
  return out;
}

export interface GeneratedContract {
  operations: Json[];
  schemas: Record<string, Json>;
}

export function buildContract(yamlText: string): GeneratedContract {
  const doc = parse(yamlText) as Obj;
  const components = doc.components as Obj;
  const responses = components.responses as Obj;
  const parameters = components.parameters as Obj;
  const schemas = components.schemas as Obj;
  const paths = doc.paths as Obj;

  const resolveParam = (p: unknown): Obj => {
    if (isObj(p) && typeof p.$ref === "string")
      return parameters[refName(p.$ref, "parameters")] as Obj;
    return p as Obj;
  };

  const ops: Json[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const id = String(op.operationId);
      const session = op["x-session"];
      const role = op["x-budget-role"];
      const reauth = op["x-reauth"];
      if (typeof session !== "string" || !SESSIONS.has(session))
        throw new Error(`${id}: missing or invalid x-session`);
      if (typeof role !== "string" || !ROLES.has(role))
        throw new Error(`${id}: missing or invalid x-budget-role`);
      if (typeof reauth !== "boolean")
        throw new Error(`${id}: missing or invalid x-reauth`);
      const params = [
        ...(shared as unknown[]),
        ...(Array.isArray(op.parameters) ? (op.parameters as unknown[]) : []),
      ].map((p) => {
        const r = resolveParam(p);
        return {
          name: String(r.name),
          in: String(r.in),
          required: r.required === true,
        };
      });
      let requestBody: string | null = null;
      if (isObj(op.requestBody)) {
        const content = op.requestBody.content as Obj;
        const json = content["application/json"] as Obj;
        requestBody = refName((json.schema as Obj).$ref, "schemas");
      }
      const resps: Record<string, Json> = {};
      for (const [status, raw] of Object.entries(op.responses as Obj)) {
        const r: Obj =
          isObj(raw) && typeof raw.$ref === "string"
            ? (responses[refName(raw.$ref, "responses")] as Obj)
            : (raw as Obj);
        let schema: string | null = null;
        let contentType: string | null = null;
        if (isObj(r.content)) {
          const [ct, body] = Object.entries(r.content)[0] as [string, Obj];
          contentType = ct;
          const s = body.schema as Obj;
          schema =
            typeof s.$ref === "string" ? refName(s.$ref, "schemas") : null;
        }
        resps[status] = { schema, contentType };
      }
      ops.push({
        operationId: id,
        method: method.toUpperCase(),
        path,
        session,
        budgetRole: role,
        reauth,
        pendingDeletionAllowed: op["x-pending-deletion-allowed"] === true,
        idempotency: op["x-idempotency"] === "required",
        rateLimits: (op["x-rate-limit"] as Json[] | undefined) ?? [],
        errorCodes: (op["x-error-codes"] as Json[] | undefined) ?? [],
        parameters: params,
        requestBody,
        responses: resps,
      });
    }
  }
  const defs: Record<string, Json> = {};
  for (const [name, s] of Object.entries(schemas)) defs[name] = toJsonSchema(s);
  return { operations: ops, schemas: defs };
}

export function renderContractModule(yamlText: string): string {
  const { operations, schemas } = buildContract(yamlText);
  return [
    "// GENERATED by backend/scripts/gen-contract.ts from docs/contracts/api.openapi.yaml.",
    "// Do not edit by hand: run `pnpm --filter ./backend gen:contract`. A unit test",
    "// fails when this file is stale.",
    'import type { ContractOperation } from "./types.ts";',
    "",
    `export const operations: readonly ContractOperation[] = ${JSON.stringify(operations, null, 2)};`,
    "",
    `export const contractSchemas: Readonly<Record<string, unknown>> = ${JSON.stringify(schemas, null, 2)};`,
    "",
  ].join("\n");
}

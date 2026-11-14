// Idempotency request hash (data-model.md idempotency_keys): SHA-256 of
// method + route template + path params + canonical JSON body. The hash is
// Internal-derived-from-Sensitive: never logged or returned.
import { sha256 } from "../crypto/keyring.ts";

/** JSON with object keys sorted recursively (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1)); // keys are unique: never equal
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function idempotencyRequestHash(
  method: string,
  routeTemplate: string,
  params: Record<string, string>,
  body: unknown,
): Buffer {
  return sha256(
    [
      method.toUpperCase(),
      routeTemplate,
      canonicalJson(params),
      canonicalJson(body),
    ].join("\n"),
  );
}

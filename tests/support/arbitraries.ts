// JSON Schema (OpenAPI 3.1 components) → fast-check arbitraries, for the
// Schemathesis-style generated requests in contract/generated.test.ts.
// Values are biased toward the edges the schema states (lengths, bounds,
// nullability, enum members) and mixed with near-misses (one past a bound,
// wrong types, odd Unicode), because those are where servers return 500.
import fc from "fast-check";
import type { JsonSchema } from "./contract.ts";
import { resolveSchema, spec } from "./contract.ts";

type Arb = fc.Arbitrary<unknown>;

const SIMPLE_CLASS = /^\^\[([^\]]+)\]\+\$$/;

function charsOf(cls: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cls.length; i++) {
    const a = cls[i]!;
    if (cls[i + 1] === "-" && i + 2 < cls.length) {
      for (let c = a.charCodeAt(0); c <= cls.charCodeAt(i + 2); c++)
        out.push(String.fromCharCode(c));
      i += 2;
    } else out.push(a);
  }
  return out;
}

// Odd text built from code points, so this source file holds no invisible or
// bidi characters (formatters may unescape "\u" literals; Semgrep flags them).
const cp = (...points: number[]): string => String.fromCodePoint(...points);
const weirdText = fc.constantFrom(
  "",
  " ",
  "   padded   ",
  cp(0x200b), // zero-width space
  cp(0x0000),
  `${cp(0xdc)}n${cp(0xef)}c${cp(0xf6)}d${cp(0xe9)} ${cp(0x2713)}`,
  `e${cp(0x0301)}`, // NFD
  [cp(0x1f469), cp(0x1f469), cp(0x1f467)].join(cp(0x200d)), // ZWJ emoji
  `${cp(0x202e)}evil`, // bidi override (must be refused, F-48)
  "<script>",
  "'; drop table x; --",
  cp(0xd800), // lone surrogate
);

function stringArb(s: JsonSchema): Arb {
  const min = (s.minLength as number | undefined) ?? 0;
  const max = Math.min((s.maxLength as number | undefined) ?? 80, 300);
  const format = s.format as string | undefined;
  if (format === "uuid") return fc.uuid();
  if (format === "email")
    return fc.oneof(
      {
        weight: 4,
        arbitrary: fc.stringMatching(/^[a-z][a-z0-9]{0,10}@example\.test$/),
      },
      { weight: 1, arbitrary: fc.emailAddress() },
    );
  if (format === "date")
    return fc
      .date({
        min: new Date("1999-06-01T00:00:00Z"),
        max: new Date("2028-12-31T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString().slice(0, 10));
  if (format === "date-time")
    return fc
      .date({
        min: new Date("2020-01-01T00:00:00Z"),
        max: new Date("2030-01-01T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString());
  const pattern = s.pattern as string | undefined;
  if (pattern) {
    const simple = SIMPLE_CLASS.exec(pattern);
    if (simple)
      return fc.string({
        unit: fc.constantFrom(...charsOf(simple[1]!)),
        minLength: Math.max(min, 1),
        maxLength: max,
      });
    return fc
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- pattern is a JSON Schema pattern from the checked-in api.openapi.yaml, not user input
      .stringMatching(new RegExp(pattern))
      .filter((x) => x.length >= min && x.length <= max);
  }
  return fc.oneof(
    { weight: 6, arbitrary: fc.string({ minLength: min, maxLength: max }) },
    {
      weight: 1,
      arbitrary: fc.string({ unit: "binary", minLength: min, maxLength: max }),
    },
    { weight: 1, arbitrary: weirdText },
  );
}

function integerArb(s: JsonSchema): Arb {
  const min = s.minimum as number | undefined;
  const max = s.maximum as number | undefined;
  const lo = min ?? -1_000_000_000;
  const hi = max ?? 1_000_000_000;
  return fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: lo, max: hi }) },
    { weight: 2, arbitrary: fc.constantFrom(lo, hi) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        lo - 1,
        hi + 1,
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
      ),
    },
  );
}

/** A value for `schema`: mostly valid, sometimes a near-miss (the property tolerates both). */
export function arbitraryFor(schema: JsonSchema, depth = 0): Arb {
  const s = resolveSchema(schema);
  if (s.const !== undefined) return fc.constant(s.const);
  if (Array.isArray(s.enum)) return fc.constantFrom(...(s.enum as unknown[]));
  const alts = (s.oneOf ?? s.anyOf) as JsonSchema[] | undefined;
  if (alts) return fc.oneof(...alts.map((a) => arbitraryFor(a, depth + 1)));
  const types = Array.isArray(s.type)
    ? (s.type as string[])
    : [s.type as string | undefined];
  if (types.length > 1)
    return fc.oneof(
      ...types.map((t) => arbitraryFor({ ...s, type: t }, depth)),
    );
  switch (types[0]) {
    case "null":
      return fc.constant(null);
    case "boolean":
      return fc.boolean();
    case "integer":
      return integerArb(s);
    case "number":
      return fc.double({ noNaN: true });
    case "string":
      return stringArb(s);
    case "array": {
      const items = s.items
        ? arbitraryFor(s.items as JsonSchema, depth + 1)
        : fc.anything();
      const minLength = (s.minItems as number | undefined) ?? 0;
      const maxLength = Math.min(
        (s.maxItems as number | undefined) ?? 5,
        Math.max(minLength, 4),
      );
      return fc.array(items, { minLength, maxLength });
    }
    case "object":
    case undefined: {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const keys = Object.keys(props);
      if (keys.length === 0 || depth > 4)
        return fc.dictionary(
          fc.string({ maxLength: 8 }),
          fc.oneof(fc.string(), fc.integer()),
          { maxKeys: 3 },
        );
      const required = (s.required ?? []) as string[];
      return fc.record(
        Object.fromEntries(
          keys.map((k) => [k, arbitraryFor(props[k]!, depth + 1)]),
        ),
        { requiredKeys: keys.filter((k) => required.includes(k)) },
      );
    }
    default:
      return fc.anything();
  }
}

/** A JSON value of a different type than the schema asks for (for type-confusion requests). */
export function wrongTypeFor(schema: JsonSchema): Arb {
  const s = resolveSchema(schema);
  const t = Array.isArray(s.type)
    ? (s.type as string[])
    : [s.type as string | undefined];
  const pool: Arb[] = [];
  if (!t.includes("string") && s.const === undefined && !s.enum)
    pool.push(fc.string({ maxLength: 5 }));
  if (!t.includes("integer") && !t.includes("number")) pool.push(fc.integer());
  if (!t.includes("boolean")) pool.push(fc.boolean());
  if (!t.includes("array")) pool.push(fc.constant([]));
  if (!t.includes("object") && t[0] !== undefined) pool.push(fc.constant({}));
  if (!t.includes("null")) pool.push(fc.constant(null));
  return fc.oneof(...pool);
}

export { spec };

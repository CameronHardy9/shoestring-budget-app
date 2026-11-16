// Generated requests, Schemathesis style (property-based with fast-check, no
// paid service): for every contract operation, requests built from the
// OpenAPI schemas (mostly valid, biased to the edges, with near-misses and real
// IDs from a seeded world) must
//   1. never get a 5xx,
//   2. get an on-contract answer (support/contract.ts oracle, applied by the client),
//   3. be refused (4xx) whenever they break the request schema.
// Runs are seeded per operation, so a failure reproduces exactly; fast-check
// prints the seed and the shrunk counterexample. FC_SEED / FC_RUNS explore further.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitraryFor } from "../support/arbitraries.ts";
import { createUserWithTotp, startMfaSignIn } from "../support/auth.ts";
import { operations, schemaErrors } from "../support/contract.ts";
import type { JsonSchema, Operation } from "../support/contract.ts";
import { dal, testLogin } from "../support/hooks.ts";
import type { ApiClient, Query } from "../support/http.ts";
import { ApiClient as Client } from "../support/http.ts";
import type { World } from "../support/world.ts";
import { seedWorld, sessionIdOf } from "../support/world.ts";

const PADDED = new Set([
  "requestPasswordReset",
  "requestEmailChange",
  "createBudgetInvitation",
]); // fixed 1 s answers (F-22)
const HASHING = new Set([
  "login",
  "signup",
  "reauthenticate",
  "changePassword",
  "completePasswordReset",
]); // argon2id
const SESSION_ENDING = new Set([
  "logout",
  "requestAccountDeletion",
  "revokeSession",
  "revokeOtherSessions",
  "changePassword",
  "confirmEmailChange",
]);

function runsFor(op: Operation): number {
  const scale = Number(process.env.FC_RUNS ?? "1");
  const base = PADDED.has(op.operationId)
    ? 4
    : HASHING.has(op.operationId)
      ? 8
      : 15;
  return Math.max(1, Math.round(base * scale));
}

function seedFor(opId: string): number {
  if (process.env.FC_SEED) return Number(process.env.FC_SEED);
  let h = 2166136261;
  for (const ch of opId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

interface Pools {
  ids: Record<string, string[]>;
}

async function pools(w: World): Promise<Pools> {
  const { invitation } = await dal().invitations.createBudgetInvitation(
    w.outsiderBudget.scope,
    w.owner.user.email,
  );
  const pending = await dal().invitations.createBudgetInvitation(
    w.budget.scope,
    "someone@example.test",
  );
  const other = await testLogin(w.owner.user.email, "owner-second");
  return {
    ids: {
      budgetId: [w.budget.id, w.budget.id, w.outsiderBudget.id],
      deletedBudgetId: [w.budget.id, w.outsiderBudget.id],
      categoryId: [
        ...Object.values(w.budget.categories),
        ...Object.values(w.outsiderBudget.categories),
      ],
      transactionId: [w.tx.id],
      invitationId: [invitation.id, pending.invitation.id],
      userId: [
        w.member.user.userId,
        w.owner.user.userId,
        w.outsider.user.userId,
      ],
      sessionId: [await sessionIdOf(other)],
      passkeyId: [],
    },
  };
}

const malformed = fc.constantFrom(
  "not-a-uuid",
  "1",
  "00000000-0000-0000-0000-00000000000g",
  "%2e%2e",
  "a".repeat(80),
);

function paramArb(
  name: string,
  schema: JsonSchema,
  p: Pools,
  month: string,
): fc.Arbitrary<string> {
  if (name === "month")
    return fc.oneof(
      {
        weight: 5,
        arbitrary: fc.constantFrom(
          month,
          "2026-10",
          "2027-01",
          "2000-01",
          "2099-12",
        ),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          "2026-13",
          "2026-1",
          "26-11",
          "2026-11-01",
          "0000-00",
        ),
      },
    );
  const known = p.ids[name] ?? [];
  const valid =
    schemaErrors(schema, "0190a0a0-0000-7000-8000-000000000000") === null;
  const random = valid
    ? fc.uuid()
    : (arbitraryFor(schema) as fc.Arbitrary<string>);
  return fc.oneof(
    ...(known.length
      ? [{ weight: 6, arbitrary: fc.constantFrom(...known) }]
      : []),
    { weight: 2, arbitrary: random },
    { weight: 1, arbitrary: malformed },
  );
}

interface Generated {
  params: Record<string, string>;
  query: Query;
  headers: Record<string, string>;
  body: unknown;
  hasBody: boolean;
}

function requestArb(
  op: Operation,
  p: Pools,
  month: string,
): fc.Arbitrary<Generated> {
  const pathParams = op.parameters.filter((x) => x.in === "path");
  const queryParams = op.parameters.filter((x) => x.in === "query");
  const params = fc.record(
    Object.fromEntries(
      pathParams.map((x) => [x.name, paramArb(x.name, x.schema, p, month)]),
    ),
  );
  const query = fc.record(
    Object.fromEntries(
      queryParams.map((x) => [
        x.name,
        x.name === "categoryId"
          ? fc.option(fc.constantFrom(...p.ids.categoryId!), { nil: undefined })
          : x.required
            ? arbitraryFor(x.schema)
            : fc.option(arbitraryFor(x.schema), { nil: undefined }),
      ]),
    ),
  ) as fc.Arbitrary<Query>;
  const headers = op.idempotency
    ? fc.oneof(
        {
          weight: 6,
          arbitrary: fc.uuid().map((k) => ({ "idempotency-key": k })),
        },
        { weight: 1, arbitrary: fc.constant({}) },
        {
          weight: 1,
          arbitrary: malformed.map((k) => ({ "idempotency-key": k })),
        },
      )
    : fc.constant({});
  const body = op.requestBody
    ? fc.oneof(
        {
          weight: 8,
          arbitrary: arbitraryFor(op.requestBody).map((b) => ({
            body: b,
            hasBody: true,
          })),
        },
        { weight: 1, arbitrary: fc.constant({ body: {}, hasBody: true }) },
        {
          weight: 1,
          arbitrary: fc.constant({ body: undefined, hasBody: false }),
        },
      )
    : fc.oneof(
        {
          weight: 6,
          arbitrary: fc.constant({ body: undefined, hasBody: false }),
        },
        { weight: 1, arbitrary: fc.constant({ body: {}, hasBody: true }) },
        // GET bodies are ignored by the backend today, against the contract's
        // global rule: pinned as a known bug in contract/routes.test.ts (BUG-1),
        // so they are not generated here.
        ...(op.method === "GET"
          ? []
          : [
              {
                weight: 1,
                arbitrary: fc.constant({ body: { stray: 1 }, hasBody: true }),
              },
            ]),
      );
  return fc
    .record({ params, query, headers, b: body })
    .map(({ params, query, headers, b }) => ({
      params: params,
      query,
      headers: headers,
      body: b.body,
      hasBody: b.hasBody,
    }));
}

/** Does the generated request break the request schema (path, query, header or body)? */
function breaksSchema(op: Operation, g: Generated): boolean {
  for (const x of op.parameters) {
    const v =
      x.in === "path"
        ? g.params[x.name]
        : x.in === "query"
          ? g.query[x.name]
          : g.headers[x.name.toLowerCase()];
    if (v === undefined) {
      if (x.required) return true;
      continue;
    }
    const typed =
      (x.schema.type === "integer" ||
        x.schema.$ref === "#/components/schemas/Version") &&
      /^-?\d+$/.test(String(v))
        ? Number(v)
        : v;
    if (schemaErrors(x.schema, typed) !== null) return true;
  }
  if (op.requestBody) {
    if (!g.hasBody) return true;
    return schemaErrors(op.requestBody, g.body) !== null;
  }
  return g.hasBody && JSON.stringify(g.body) !== "{}";
}

function path(op: Operation, params: Record<string, string>): string {
  return op.path.replace(/\{(\w+)\}/g, (_, n: string) =>
    encodeURIComponent(params[n] ?? ""),
  );
}

async function clientFor(
  op: Operation,
  w: World,
  pending: () => Promise<ApiClient>,
): Promise<ApiClient> {
  if (op.session === "none") return new Client("anonymous");
  if (op.session === "mfa_pending") return pending();
  if (SESSION_ENDING.has(op.operationId))
    return testLogin(w.owner.user.email, "owner-run");
  return w.owner.client;
}

describe("generated requests never break the server or the contract", () => {
  it.each(operations.map((o) => [o.operationId, o] as const))(
    "%s",
    async (opId, op) => {
      const w = await seedWorld();
      const p = await pools(w);
      let pendingClient: ApiClient | null = null;
      const mfaUser =
        op.session === "mfa_pending" ? await createUserWithTotp() : null;
      const pending = async (): Promise<ApiClient> => {
        pendingClient ??= await startMfaSignIn(mfaUser!);
        return pendingClient;
      };
      await fc.assert(
        fc.asyncProperty(requestArb(op, p, w.month), async (g) => {
          const client = await clientFor(op, w, pending);
          const res = await client.request(op.method, path(op, g.params), {
            query: g.query,
            headers: g.headers,
            ...(g.hasBody ? { body: g.body } : {}),
          });
          expect(res.status, res.describe).toBeLessThan(500);
          if (breaksSchema(op, g))
            expect(
              res.status,
              `${opId} accepted a request that breaks its schema: ${res.describe}`,
            ).toBeGreaterThanOrEqual(400);
        }),
        { numRuns: runsFor(op), seed: seedFor(opId), endOnFailure: true },
      );
    },
  );
});

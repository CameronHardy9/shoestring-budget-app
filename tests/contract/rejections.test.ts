// Strict request handling for every operation (api.openapi.yaml global rules,
// errors.md step 6), generated from the contract and the known-good calls in
// support/recipes.ts, so the ONLY thing wrong with each request is the
// mutation under test:
//   - an unknown query parameter → 400 (query, <name>, unknown_field)
//   - an unknown body field → 400 (body, <name>, unknown_field)
//   - a body on an operation that takes none → 400
//   - a non-JSON Content-Type → 415, malformed JSON → 400, a body over 64 KiB → 413
import { describe, expect, it } from "vitest";
import { operations } from "../support/contract.ts";
import type { Operation } from "../support/contract.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import type { ApiClient, RequestOptions } from "../support/http.ts";
import type { Call } from "../support/recipes.ts";
import { pathFor, RECIPES } from "../support/recipes.ts";
import { seedWorld } from "../support/world.ts";

async function prepared(
  op: Operation,
): Promise<{ call: Call; client: ApiClient }> {
  const w = await seedWorld();
  const call = await RECIPES[op.operationId]!.prepare(w, w.owner);
  return { call, client: call.client ?? w.owner.client };
}

async function send(
  op: Operation,
  call: Call,
  client: ApiClient,
  extra: RequestOptions,
) {
  return client.request(op.method, pathFor(op, call.params), {
    ...(call.query ? { query: call.query } : {}),
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
    ...extra,
  });
}

const rows = operations.map((o) => [o.operationId, o] as const);
const unsafe = rows.filter(([, o]) => o.method !== "GET");

describe("unknown query parameters are rejected (no cache-busting or tracking params)", () => {
  it.each(rows)(
    "%s?utm_source=x → 400 VALIDATION_FAILED (query, utm_source, unknown_field)",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const res = await send(op, call, client, {
        query: { ...(call.query ?? {}), utm_source: "x" },
      });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({
          in: "query",
          field: "utm_source",
          issue: "unknown_field",
        }),
      );
    },
  );
});

describe("unknown body fields are rejected", () => {
  it.each(rows.filter(([, o]) => o.requestBody))(
    "%s with an extra body field → 400 VALIDATION_FAILED (body, injected, unknown_field)",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const body = {
        ...((call.body as object | undefined) ?? {}),
        injected: true,
      };
      const res = await send(op, call, client, { body });
      expect(
        [res.status, codeOf(res)],
        `${res.describe} ${res.text.slice(0, 200)}`,
      ).toEqual([400, "VALIDATION_FAILED"]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({
          in: "body",
          field: "injected",
          issue: "unknown_field",
        }),
      );
    },
  );

  it.each(unsafe.filter(([, o]) => !o.requestBody))(
    "%s (no request body) with a non-empty body → 400 VALIDATION_FAILED",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const res = await send(op, call, client, { body: { injected: true } });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
    },
  );
});

describe("body encoding (errors.md 415 / 413 / malformed JSON)", () => {
  it.each(unsafe)(
    "%s with Content-Type text/plain → 415 UNSUPPORTED_MEDIA_TYPE",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const res = await send(op, call, client, {
        rawBody: JSON.stringify(call.body ?? {}),
        contentType: "text/plain",
      });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ]);
    },
  );

  it.each(unsafe)(
    "%s with a form-encoded body → 415 (HTML forms cannot submit, auth.md §3)",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const res = await send(op, call, client, {
        rawBody: "a=1",
        contentType: "application/x-www-form-urlencoded",
      });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ]);
    },
  );

  it.each(unsafe.filter(([, o]) => o.requestBody))(
    "%s with malformed JSON → 400 VALIDATION_FAILED",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const res = await send(op, call, client, {
        rawBody: '{"broken": ',
        contentType: "application/json",
      });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
    },
  );

  it.each(unsafe)(
    "%s with a body over 64 KiB → 413 PAYLOAD_TOO_LARGE",
    async (_id, op) => {
      const { call, client } = await prepared(op);
      const big = JSON.stringify({
        ...((call.body as object | undefined) ?? {}),
        pad: "x".repeat(65 * 1024),
      });
      const res = await send(op, call, client, {
        rawBody: big,
        contentType: "application/json",
      });
      expect([res.status, codeOf(res)], res.describe).toEqual([
        413,
        "PAYLOAD_TOO_LARGE",
      ]);
    },
  );
});

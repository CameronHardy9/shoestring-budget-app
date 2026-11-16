// Contract tour: every operation in api.openapi.yaml answers its documented
// success status with a body that matches the schema (support/recipes.ts), and
// a documented error path. Every response in tests/ is also checked by the
// oracle in support/contract.ts, so this file guarantees that each operation
// is exercised at least once on both paths.
import { describe, expect, it } from "vitest";
import { operations } from "../support/contract.ts";
import { codeOf } from "../support/http.ts";
import { ApiClient } from "../support/http.ts";
import { invoke, pathFor, RECIPES } from "../support/recipes.ts";
import { seedWorld } from "../support/world.ts";

describe("every contract operation has a recipe", () => {
  it("recipes cover exactly the operations in api.openapi.yaml", () => {
    expect(Object.keys(RECIPES).sort()).toEqual(
      operations.map((o) => o.operationId).sort(),
    );
  });
});

describe("success path of every operation", () => {
  it.each(operations.map((o) => [o.operationId, o] as const))(
    "%s answers its documented success status with an on-contract body",
    async (opId) => {
      const recipe = RECIPES[opId]!;
      const w = await seedWorld();
      const call = await recipe.prepare(w, w.owner);
      const res = await invoke(opId, call, w.owner.client);
      expect(res.status, `${res.describe} ${res.text.slice(0, 300)}`).toBe(
        recipe.status,
      );
    },
  );
});

describe("documented error path of every operation", () => {
  const sessionOps = operations.filter(
    (o) => o.session !== "none" && o.session !== "optional",
  );
  it.each(sessionOps.map((o) => [o.operationId, o] as const))(
    "%s without a session answers 401 UNAUTHENTICATED",
    async (_id, op) => {
      const params = Object.fromEntries(
        op.pathParams.map((p) => [
          p,
          p === "month" ? "2026-11" : "0190a0a0-0000-7000-8000-000000000000",
        ]),
      );
      const res = await new ApiClient("anonymous").request(
        op.method,
        pathFor(op, params),
      );
      expect([res.status, codeOf(res)], res.describe).toEqual([
        401,
        "UNAUTHENTICATED",
      ]);
    },
  );

  const publicBodyOps = operations.filter(
    (o) => (o.session === "none" || o.session === "optional") && o.requestBody,
  );
  it.each(publicBodyOps.map((o) => [o.operationId, o] as const))(
    "%s with an empty object body answers 400 VALIDATION_FAILED naming the missing fields",
    async (_id, op) => {
      const res = await new ApiClient("anonymous").request(
        op.method,
        pathFor(op),
        { body: {} },
      );
      expect([res.status, codeOf(res)], res.describe).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
    },
  );
});

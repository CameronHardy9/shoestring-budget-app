// The route table refuses to start when a route disagrees with the contract.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { defineRoute, fastifyPath, registerRoutes } from "./routes.ts";
import { BudgetParams } from "./schemas.ts";

const deps = {} as AppDeps;
const ok = () => Promise.resolve({ status: 200 });

describe("registerRoutes startup checks", () => {
  it("converts contract paths", () => {
    expect(
      fastifyPath("/budgets/{budgetId}/months/{month}/plan/{categoryId}"),
    ).toBe("/api/budgets/:budgetId/months/:month/plan/:categoryId");
  });

  it.each([
    [
      "an operation that is not in the contract",
      defineRoute({ operationId: "adminBackdoor", handler: ok }),
    ],
    [
      "path params that differ from the contract",
      defineRoute({
        operationId: "getBudget",
        params: z.strictObject({ id: z.string() }),
        handler: ok,
      }),
    ],
    [
      "a missing path param schema",
      defineRoute({ operationId: "getBudget", handler: ok }),
    ],
    [
      "a body the contract does not define",
      defineRoute({
        operationId: "getBudget",
        params: BudgetParams,
        body: z.strictObject({}),
        handler: ok,
      }),
    ],
    [
      "a missing body schema",
      defineRoute({ operationId: "updateMe", handler: ok }),
    ],
  ])("refuses %s", (_name, route) => {
    expect(() => registerRoutes(Fastify(), deps, [route])).toThrow();
  });

  it("refuses registering an operation twice", () => {
    const r = defineRoute({ operationId: "getHealthz", handler: ok });
    expect(() => registerRoutes(Fastify(), deps, [r, r])).toThrow(/twice/);
  });
});

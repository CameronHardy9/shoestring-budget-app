// Contract drift is a test failure: the generated table must match the
// OpenAPI file, every operation must declare its extensions, and each zod
// body schema must have exactly the contract's properties and required set.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { renderContractModule } from "../../scripts/contract-codegen.ts";
import { apiRoutes } from "../app.ts";
import * as schemas from "../http/schemas.ts";
import { checkContract } from "../http/routes.ts";
import { contractSchemas, operations } from "./contract.gen.ts";
import type { ContractOperation } from "./types.ts";

const spec = readFileSync(
  new URL("../../../docs/contracts/api.openapi.yaml", import.meta.url),
  "utf8",
);

describe("generated contract", () => {
  it("is up to date with docs/contracts/api.openapi.yaml (run `pnpm --filter ./backend gen:contract`)", () => {
    expect(
      readFileSync(new URL("./contract.gen.ts", import.meta.url), "utf8"),
    ).toBe(renderContractModule(spec));
  });

  it("every operation declares x-session, x-budget-role and x-reauth and passes the startup checks", () => {
    expect(operations.length).toBeGreaterThanOrEqual(60);
    expect(() => checkContract(operations)).not.toThrow();
  });

  it("the startup check refuses missing or inconsistent declarations", () => {
    const base = operations.find((o) => o.operationId === "getBudget")!;
    const bad = (o: Partial<ContractOperation>) => () =>
      checkContract([{ ...base, ...o }]);
    expect(bad({ budgetRole: "none" })).toThrow(/budgetId/);
    expect(
      bad({
        path: "/me/deleted-budgets/{deletedBudgetId}/x",
        budgetRole: "owner",
      }),
    ).toThrow();
    expect(bad({ path: "/me/x", budgetRole: "deleted_budget_owner" })).toThrow(
      /deleted_budget_owner/,
    );
    expect(bad({ path: "/me/x", budgetRole: "member" })).toThrow(/without/);
    expect(bad({ reauth: true, session: "none" })).toThrow(/reauth/);
    expect(() => checkContract([base, base])).toThrow(/duplicate/);
  });

  it("every contract operation is implemented", () => {
    const ids = new Set(operations.map((o) => o.operationId));
    for (const r of apiRoutes) expect(ids.has(r.operationId)).toBe(true);
    expect(apiRoutes.length).toBe(operations.length);
  });
});

type Shape = Record<string, { _zod?: { optin?: string } } | undefined>;
function zodKeys(schema: z.ZodType): { all: string[]; required: string[] } {
  // Unwrap .superRefine/.pipe wrappers down to the object.
  let s = schema as unknown as {
    shape?: Shape;
    _zod: { def: { in?: unknown; schema?: unknown } };
  };
  while (!s.shape && (s._zod.def.in || s._zod.def.schema))
    s = (s._zod.def.in ?? s._zod.def.schema) as typeof s;
  const shape = s.shape ?? {};
  const all = Object.keys(shape).sort();
  const required = all
    .filter((k) => shape[k]?._zod?.optin !== "optional")
    .sort();
  return { all, required };
}

describe("zod request schemas match the contract", () => {
  const pairs: [string, z.ZodType][] = [
    ["LoginRequest", schemas.LoginRequest],
    ["TokenRequest", schemas.TokenRequest],
    ["SignupRequest", schemas.SignupRequest],
    ["ReauthRequest", schemas.ReauthRequest],
    ["MeUpdate", schemas.MeUpdate],
    ["BudgetCreate", schemas.BudgetCreate],
    ["BudgetUpdate", schemas.BudgetUpdate],
    ["OwnershipTransfer", schemas.OwnershipTransfer],
    ["InvitationCreate", schemas.InvitationCreate],
    ["CategoryCreate", schemas.CategoryCreate],
    ["CategoryUpdate", schemas.CategoryUpdate],
    ["PlanEntryPut", schemas.PlanEntryPut],
    ["PlanCopyRequest", schemas.PlanCopyRequest],
    ["TransactionCreate", schemas.TransactionCreate],
    ["TransactionReplace", schemas.TransactionReplace],
    ["EmailRequest", schemas.EmailRequest],
    ["PasswordResetComplete", schemas.PasswordResetComplete],
    ["PasswordChange", schemas.PasswordChange],
    ["EmailChangeRequest", schemas.EmailChangeRequest],
    ["WebAuthnChallengeRequest", schemas.WebAuthnChallengeRequest],
    ["TotpConfirm", schemas.TotpConfirm],
    ["PasskeyRegistration", schemas.PasskeyRegistration],
    ["ExportRequest", schemas.ExportRequest],
  ];
  it.each(pairs)("%s", (name, schema) => {
    const c = contractSchemas[name] as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(c.additionalProperties).toBe(false);
    const z = zodKeys(schema);
    expect(z.all).toEqual(Object.keys(c.properties).sort());
    expect(z.required).toEqual([...(c.required ?? [])].sort());
  });
});

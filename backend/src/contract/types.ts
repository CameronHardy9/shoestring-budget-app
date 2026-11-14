// Shapes of the generated contract table (contract.gen.ts). The table is built
// from docs/contracts/api.openapi.yaml by scripts/gen-contract.ts; a unit test
// fails when it is stale, so contract drift is a test failure.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `x-session` (api.openapi.yaml "Operation extensions"). */
export type SessionRequirement =
  "none" | "optional" | "mfa_pending" | "active" | "active_or_mfa_pending";

/** `x-budget-role`. */
export type BudgetRoleRequirement =
  "none" | "member" | "owner" | "deleted_budget_owner";

export interface ContractParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
}

export interface ContractResponse {
  /** Component schema name of the JSON body, or null when there is no body. */
  readonly schema: string | null;
  readonly contentType: "application/json" | "text/csv" | null;
}

export interface ContractOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI path template without the `/api` server prefix, e.g. `/budgets/{budgetId}`. */
  readonly path: string;
  readonly session: SessionRequirement;
  readonly budgetRole: BudgetRoleRequirement;
  readonly reauth: boolean;
  readonly pendingDeletionAllowed: boolean;
  readonly idempotency: boolean;
  readonly rateLimits: readonly string[];
  readonly errorCodes: readonly string[];
  readonly parameters: readonly ContractParameter[];
  /** Component schema name of the JSON request body, or null when there is none. */
  readonly requestBody: string | null;
  /** Keyed by status code (`"200"`, `"default"`, ...). */
  readonly responses: Readonly<Record<string, ContractResponse>>;
}

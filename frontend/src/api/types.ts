// Named aliases for generated contract types. Never hand-write API shapes:
// everything here points into schema.gen.ts (generated from api.openapi.yaml).
import type { components, paths } from "./schema.gen.ts";

export type { paths };
export type Schemas = components["schemas"];

export type ErrorBody = Schemas["ErrorBody"];
export type ErrorCode = Schemas["ErrorCode"];
export type FieldError = Schemas["FieldError"];
export type FieldIssue = Schemas["FieldIssue"];

export type AuthState = Schemas["AuthState"];
export type Me = Schemas["Me"];
export type Budget = Schemas["Budget"];
export type Category = Schemas["Category"];
export type CategoryKind = Schemas["CategoryKind"];
export type MonthSummary = Schemas["MonthSummary"];
export type CategorySummary = Schemas["CategorySummary"];
export type Transaction = Schemas["Transaction"];
export type TransactionCreate = Schemas["TransactionCreate"];
export type TransactionPage = Schemas["TransactionPage"];
export type Direction = Schemas["Direction"];

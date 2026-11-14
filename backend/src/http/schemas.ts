// zod request schemas, one per contract request body / parameter set
// (api.openapi.yaml components). Every object is strict: unknown fields are
// 400 VALIDATION_FAILED (unknown_field). contract.test.ts checks that each
// body schema has exactly the contract's properties and required set.
import { z } from "zod";
import {
  calendarDate,
  cents,
  cursor,
  email,
  month,
  optionalText,
  password,
  positiveCents,
  queryBool,
  queryInt,
  text,
  timezone,
  token,
  uuid,
  version,
} from "./validation.ts";

// ------------------------------------------------------------ auth / me
export const LoginRequest = z.strictObject({
  email,
  password: password(1, 128),
});
export const TokenRequest = z.strictObject({ token });
export const SignupRequest = z.strictObject({
  token,
  displayName: text(1, 50),
  password: password(12, 128),
});

const TotpProof = z.strictObject({
  method: z.literal("totp"),
  code: z.string().regex(/^[0-9]{6}$/),
});
const RecoveryCodeProof = z.strictObject({
  method: z.literal("recovery_code"),
  code: z.string().regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/),
});
const PasskeyProof = z.strictObject({
  method: z.literal("passkey"),
  // AuthenticationResponseJSON; verified server-side in Phase B.
  assertion: z.looseObject({
    id: z.string().max(1024),
    rawId: z.string().max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({}),
  }),
});
export const MfaProof = z.discriminatedUnion("method", [
  TotpProof,
  PasskeyProof,
  RecoveryCodeProof,
]);
export const ReauthRequest = z.strictObject({
  password: password(1, 128),
  mfa: MfaProof.optional(),
});
export const MeUpdate = z.strictObject({ displayName: text(1, 50) });

// ------------------------------------------------------------ budgets
const StarterCategory = z.strictObject({
  name: text(1, 40),
  kind: z.enum(["expense", "income"]),
  plannedCents: cents.optional(),
});
export const BudgetCreate = z.strictObject({
  name: text(1, 60),
  timezone,
  categories: z.array(StarterCategory).max(50).optional(),
});
export const BudgetUpdate = z
  .strictObject({
    name: text(1, 60).optional(),
    timezone: timezone.optional(),
    version,
  })
  .superRefine((v, ctx) => {
    if (v.name === undefined && v.timezone === undefined)
      ctx.addIssue({
        code: "custom",
        message: "required",
        params: { issue: "required" },
        path: [],
      });
  });
export const OwnershipTransfer = z.strictObject({ userId: uuid });
export const InvitationCreate = z.strictObject({ email });

// ------------------------------------------------------------ categories / plans
export const CategoryCreate = z.strictObject({
  name: text(1, 40),
  kind: z.enum(["expense", "income"]),
  sortOrder: z.int().min(0).max(10_000).optional(),
});
export const CategoryUpdate = z
  .strictObject({
    name: text(1, 40).optional(),
    sortOrder: z.int().min(0).max(10_000).optional(),
    archived: z.boolean().optional(),
    version,
  })
  .superRefine((v, ctx) => {
    if (
      v.name === undefined &&
      v.sortOrder === undefined &&
      v.archived === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "required",
        params: { issue: "required" },
        path: [],
      });
  });
export const PlanEntryPut = z.strictObject({
  amountCents: cents,
  version: z.union([version, z.null()]),
});
export const PlanCopyRequest = z.strictObject({
  overwrite: z.boolean().optional(),
});

// ------------------------------------------------------------ transactions
const SplitWrite = z.strictObject({
  categoryId: uuid,
  amountCents: positiveCents,
});
export const TransactionCreate = z.strictObject({
  date: calendarDate,
  direction: z.enum(["outflow", "inflow"]),
  amountCents: positiveCents,
  payee: optionalText(100).optional(),
  memo: optionalText(500).optional(),
  splits: z.array(SplitWrite).min(1).max(20),
});
export const TransactionReplace = z.strictObject({
  date: calendarDate,
  direction: z.enum(["outflow", "inflow"]),
  amountCents: positiveCents,
  payee: optionalText(100),
  memo: optionalText(500),
  splits: z.array(SplitWrite).min(1).max(20),
  version,
});

// ------------------------------------------------------------ parameters
export const BudgetParams = z.strictObject({ budgetId: uuid });
export const BudgetMemberParams = z.strictObject({
  budgetId: uuid,
  userId: uuid,
});
export const BudgetInvitationParams = z.strictObject({
  budgetId: uuid,
  invitationId: uuid,
});
export const InvitationParams = z.strictObject({ invitationId: uuid });
export const CategoryParams = z.strictObject({
  budgetId: uuid,
  categoryId: uuid,
});
export const MonthParams = z.strictObject({ budgetId: uuid, month });
export const PlanEntryParams = z.strictObject({
  budgetId: uuid,
  month,
  categoryId: uuid,
});
export const TransactionParams = z.strictObject({
  budgetId: uuid,
  transactionId: uuid,
});

export const VersionQuery = z.strictObject({
  version: queryInt(1, 2_147_483_647),
});
export const CategoryListQuery = z.strictObject({
  includeArchived: queryBool.optional(),
});
export const TransactionListQuery = z.strictObject({
  month: month.optional(),
  categoryId: uuid.optional(),
  limit: queryInt(1, 100).optional(),
  cursor: cursor.optional(),
});
export const NoQuery = z.strictObject({});
export const NoParams = z.strictObject({});

// ------------------------------------------------------------ Phase B
export const EmailRequest = z.strictObject({ email });
export const PasswordResetComplete = z.strictObject({
  token,
  newPassword: password(12, 128),
  mfa: MfaProof.optional(),
});
export const PasswordChange = z.strictObject({ newPassword: password(12, 128) });
export const EmailChangeRequest = z.strictObject({ newEmail: email });
export const WebAuthnChallengeRequest = z.strictObject({ purpose: z.enum(["mfa", "reauth"]) });
export const TotpConfirm = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const PasskeyRegistration = z.strictObject({
  name: text(1, 40),
  // RegistrationResponseJSON; verified server-side.
  credential: z.looseObject({
    id: z.string().max(1024),
    rawId: z.string().max(1024),
    type: z.literal("public-key"),
    response: z.looseObject({}),
  }),
});
export const ExportRequest = z.strictObject({ kind: z.enum(["transactions", "plans"]) });
export const SessionParams = z.strictObject({ sessionId: uuid });
export const PasskeyParams = z.strictObject({ passkeyId: uuid });
export const DeletedBudgetParams = z.strictObject({ deletedBudgetId: uuid });

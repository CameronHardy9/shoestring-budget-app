// MFA sign-in, password reset, email change, sessions, MFA management, export,
// deletion and deleted-budget restore (auth.md §5-§11, ADR-0010).
import { defineRoute } from "../http/routes.ts";
import {
  DeletedBudgetParams,
  EmailChangeRequest,
  EmailRequest,
  ExportRequest,
  MfaProof,
  PasskeyParams,
  PasskeyRegistration,
  PasswordChange,
  PasswordResetComplete,
  SessionParams,
  TokenRequest,
  TotpConfirm,
  WebAuthnChallengeRequest,
} from "../http/schemas.ts";
import {
  beginTotpSetup,
  cancelDeletion,
  changePassword,
  confirmTotpSetup,
  exportCsv,
  exportLimit,
  getMfa,
  listDeletedBudgets,
  listSessions,
  passkeyRegistrationOptions,
  regenerateRecoveryCodes,
  registerPasskey,
  removePasskey,
  removeTotp,
  requestDeletion,
  restoreDeletedBudget,
  revokeOtherSessions,
  revokeSession,
} from "../services/account.ts";
import { completeMfaSignIn, webauthnChallenge } from "../services/auth.ts";
import {
  cancelEmailChange,
  completePasswordReset,
  confirmEmailChange,
  emailChangeIpLimit,
  emailChangeRequestLimit,
  requestEmailChange,
  requestPasswordReset,
  resetRequestIpLimit,
  resetTokenIpLimit,
  resetWebauthnChallenge,
  verifyResetToken,
} from "../services/recovery.ts";
import { mustAuth, padUntil } from "./common.ts";
import { ApiError } from "../errors.ts";

export const accountRoutes = [
  // ------------------------------------------------------------ sign-in MFA
  defineRoute({
    operationId: "verifyMfa",
    body: MfaProof,
    handler: async ({ deps, req, reply, auth, body }) => ({
      status: 200,
      body: await completeMfaSignIn(deps, req, reply, mustAuth(auth), body),
    }),
  }),
  defineRoute({
    operationId: "createWebAuthnChallenge",
    body: WebAuthnChallengeRequest,
    handler: async ({ deps, auth, body }) => ({
      status: 200,
      body: await webauthnChallenge(deps, mustAuth(auth), body.purpose),
    }),
  }),
  // ------------------------------------------------------------ password reset
  defineRoute({
    operationId: "requestPasswordReset",
    body: EmailRequest,
    rateLimit: ({ deps, req }) => resetRequestIpLimit(deps, req),
    handler: async ({ deps, req, body, startedAt }) => {
      // F-22: identical, fixed-latency answer whether or not the account exists.
      try {
        await requestPasswordReset(deps, req, body.email);
        return { status: 202 };
      } finally {
        await padUntil(deps, startedAt);
      }
    },
  }),
  defineRoute({
    operationId: "verifyPasswordResetToken",
    body: TokenRequest,
    rateLimit: ({ deps, req }) => resetTokenIpLimit(deps, req),
    handler: async ({ deps, body }) => ({ status: 200, body: await verifyResetToken(deps, body.token) }),
  }),
  defineRoute({
    operationId: "createPasswordResetWebAuthnChallenge",
    body: TokenRequest,
    rateLimit: ({ deps, req }) => resetTokenIpLimit(deps, req),
    handler: async ({ deps, body }) => ({ status: 200, body: await resetWebauthnChallenge(deps, body.token) }),
  }),
  defineRoute({
    operationId: "completePasswordReset",
    body: PasswordResetComplete,
    rateLimit: ({ deps, req }) => resetTokenIpLimit(deps, req),
    handler: async ({ deps, req, body }) => {
      await completePasswordReset(deps, req, body);
      return { status: 204 };
    },
  }),
  // ------------------------------------------------------------ email change
  defineRoute({
    operationId: "requestEmailChange",
    body: EmailChangeRequest,
    rateLimit: ({ deps, auth }) => emailChangeRequestLimit(deps, mustAuth(auth)),
    handler: async ({ deps, auth, body, startedAt }) => {
      try {
        await requestEmailChange(deps, mustAuth(auth), body.newEmail);
        return { status: 202 };
      } finally {
        await padUntil(deps, startedAt);
      }
    },
  }),
  defineRoute({
    operationId: "confirmEmailChange",
    body: TokenRequest,
    rateLimit: ({ deps, req }) => emailChangeIpLimit(deps, req),
    handler: async ({ deps, auth, body }) => {
      await confirmEmailChange(deps, mustAuth(auth), body.token);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "cancelEmailChange",
    body: TokenRequest,
    rateLimit: ({ deps, req }) => emailChangeIpLimit(deps, req),
    handler: async ({ deps, reply, body }) => {
      await cancelEmailChange(deps, reply, body.token);
      return { status: 204 };
    },
  }),
  // ------------------------------------------------------------ password and sessions
  defineRoute({
    operationId: "changePassword",
    body: PasswordChange,
    handler: async ({ deps, auth, body }) => {
      await changePassword(deps, mustAuth(auth), body.newPassword);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "listSessions",
    handler: async ({ deps, auth }) => ({ status: 200, body: await listSessions(deps, mustAuth(auth)) }),
  }),
  defineRoute({
    operationId: "revokeSession",
    params: SessionParams,
    handler: async ({ deps, reply, auth, params }) => {
      await revokeSession(deps, reply, mustAuth(auth), params.sessionId);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "revokeOtherSessions",
    handler: async ({ deps, auth }) => {
      await revokeOtherSessions(deps, mustAuth(auth));
      return { status: 204 };
    },
  }),
  // ------------------------------------------------------------ MFA management
  defineRoute({
    operationId: "getMfa",
    handler: async ({ deps, auth }) => ({ status: 200, body: await getMfa(deps, mustAuth(auth).session.userId) }),
  }),
  defineRoute({
    operationId: "beginTotpSetup",
    handler: async ({ deps, auth }) => ({ status: 201, body: await beginTotpSetup(deps, mustAuth(auth)) }),
  }),
  defineRoute({
    operationId: "confirmTotpSetup",
    body: TotpConfirm,
    handler: async ({ deps, auth, body }) => ({ status: 200, body: await confirmTotpSetup(deps, mustAuth(auth), body.code) }),
  }),
  defineRoute({
    operationId: "removeTotp",
    handler: async ({ deps, auth }) => {
      await removeTotp(deps, mustAuth(auth));
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "createPasskeyRegistrationOptions",
    handler: async ({ deps, auth }) => ({ status: 200, body: await passkeyRegistrationOptions(deps, mustAuth(auth)) }),
  }),
  defineRoute({
    operationId: "registerPasskey",
    body: PasskeyRegistration,
    handler: async ({ deps, auth, body }) => ({ status: 201, body: await registerPasskey(deps, mustAuth(auth), body) }),
  }),
  defineRoute({
    operationId: "removePasskey",
    params: PasskeyParams,
    handler: async ({ deps, auth, params }) => {
      await removePasskey(deps, mustAuth(auth), params.passkeyId);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "regenerateRecoveryCodes",
    handler: async ({ deps, auth }) => ({ status: 200, body: await regenerateRecoveryCodes(deps, mustAuth(auth)) }),
  }),
  // ------------------------------------------------------------ data rights
  defineRoute({
    operationId: "exportMyData",
    body: ExportRequest,
    rateLimit: ({ deps, auth }) => exportLimit(deps, mustAuth(auth)),
    handler: async ({ deps, auth, body }) => {
      const { csv, filename } = await exportCsv(deps, mustAuth(auth), body.kind);
      return {
        status: 200,
        body: csv,
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` },
      };
    },
  }),
  defineRoute({
    operationId: "requestAccountDeletion",
    handler: async ({ deps, reply, auth }) => ({ status: 202, body: await requestDeletion(deps, reply, mustAuth(auth)) }),
  }),
  defineRoute({
    operationId: "cancelAccountDeletion",
    handler: async ({ deps, auth }) => ({ status: 200, body: await cancelDeletion(deps, mustAuth(auth)) }),
  }),
  // ------------------------------------------------------------ deleted budgets
  defineRoute({
    operationId: "listDeletedBudgets",
    handler: async ({ deps, auth }) => ({ status: 200, body: await listDeletedBudgets(deps, mustAuth(auth)) }),
  }),
  defineRoute({
    operationId: "restoreDeletedBudget",
    params: DeletedBudgetParams,
    handler: async ({ deps, auth, deletedScope }) => {
      if (!deletedScope) throw new ApiError("NOT_FOUND");
      return { status: 200, body: await restoreDeletedBudget(deps, mustAuth(auth), deletedScope) };
    },
  }),
];

// One known-good call for EVERY contract operation, keyed by operationId: what
// it needs set up, who calls it, and the success status it must answer. The
// contract tour (contract/operations.test.ts) and the permission matrix
// (integration/permission-matrix.test.ts) are generated from this table and
// the contract's x- extensions; a new operation without a recipe fails both.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createUserWithTotp, startMfaSignIn } from "./auth.ts";
import { operation } from "./contract.ts";
import type { Operation } from "./contract.ts";
import {
  createBudget,
  createCategory,
  createUser,
  uniqueEmail,
} from "./factories.ts";
import { ApiClient } from "./http.ts";
import type { ApiResponse, Query } from "./http.ts";
import { dal, now, signupInvite, testLogin } from "./hooks.ts";
import { totp } from "./totp.ts";
import { enrollPasskey, SoftAuthenticator } from "./webauthn.ts";
import type { Persona, World } from "./world.ts";
import { oneTimeToken, sessionIdOf } from "./world.ts";

export interface Call {
  params?: Record<string, string>;
  query?: Query;
  body?: unknown;
  idempotencyKey?: string;
  /** Overrides the actor's client (public operations, MFA-pending sessions). */
  client?: ApiClient;
}

export interface Recipe {
  /** The documented success status this call must answer. */
  status: number;
  prepare(w: World, actor: Persona): Promise<Call>;
}

const anon = (): ApiClient => new ApiClient("anonymous");
const NEW_PASSWORD = (): string => `new-${randomUUID()}`;

/** Path for an operation with its params filled in. */
export function pathFor(
  op: Operation,
  params: Record<string, string> = {},
): string {
  return op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined)
      throw new Error(`${op.operationId}: missing path param ${name}`);
    return encodeURIComponent(v);
  });
}

export async function invoke(
  opId: string,
  call: Call,
  client: ApiClient,
): Promise<ApiResponse> {
  const op = operation(opId);
  const c = call.client ?? client;
  return c.request(op.method, pathFor(op, call.params), {
    ...(call.query ? { query: call.query } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
  });
}

const b = (w: World): Record<string, string> => ({ budgetId: w.budget.id });

/** A pending-deletion persona (its own new session after the request). */
async function pendingDeletionClient(user: {
  userId: string;
  email: string;
}): Promise<ApiClient> {
  await dal().users.requestAccountDeletion(user.userId);
  return testLogin(user.email, "pending-deletion");
}

export const RECIPES: Record<string, Recipe> = {
  // ------------------------------------------------------------ health
  getHealthz: { status: 200, prepare: async () => ({ client: anon() }) },
  getReadyz: { status: 200, prepare: async () => ({ client: anon() }) },

  // ------------------------------------------------------------ auth
  getAuthSession: { status: 200, prepare: async () => ({}) },
  login: {
    status: 200,
    prepare: async (_w, a) => ({
      client: anon(),
      body: { email: a.user.email, password: a.user.password },
    }),
  },
  logout: { status: 204, prepare: async () => ({}) },
  verifyMfa: {
    status: 200,
    prepare: async () => {
      const u = await createUserWithTotp();
      const client = await startMfaSignIn(u);
      return { client, body: { method: "totp", code: totp(u.secret, now()) } };
    },
  },
  createWebAuthnChallenge: {
    status: 200,
    prepare: async (_w, a) => {
      await enrollPasskey(a.client);
      return { body: { purpose: "reauth" } };
    },
  },
  reauthenticate: {
    status: 200,
    prepare: async (_w, a) => ({ body: { password: a.user.password } }),
  },
  previewSignupInvite: {
    status: 200,
    prepare: async () => ({
      client: anon(),
      body: { token: await signupInvite(uniqueEmail("invitee")) },
    }),
  },
  signup: {
    status: 201,
    prepare: async () => ({
      client: anon(),
      body: {
        token: await signupInvite(uniqueEmail("invitee")),
        displayName: "New Tester",
        password: NEW_PASSWORD(),
      },
    }),
  },
  requestPasswordReset: {
    status: 202,
    prepare: async (_w, a) => ({
      client: anon(),
      body: { email: a.user.email },
    }),
  },
  verifyPasswordResetToken: {
    status: 200,
    prepare: async (_w, a) => {
      const t = oneTimeToken();
      await dal().tokens.issuePasswordResetToken(a.user.userId, t.hash);
      return { client: anon(), body: { token: t.token } };
    },
  },
  createPasswordResetWebAuthnChallenge: {
    status: 200,
    prepare: async (_w, a) => {
      await enrollPasskey(a.client);
      const t = oneTimeToken();
      await dal().tokens.issuePasswordResetToken(a.user.userId, t.hash);
      return { client: anon(), body: { token: t.token } };
    },
  },
  completePasswordReset: {
    status: 204,
    prepare: async (_w, a) => {
      const t = oneTimeToken();
      await dal().tokens.issuePasswordResetToken(a.user.userId, t.hash);
      return {
        client: anon(),
        body: { token: t.token, newPassword: NEW_PASSWORD() },
      };
    },
  },
  confirmEmailChange: {
    status: 204,
    prepare: async (_w, a) => {
      const change = oneTimeToken();
      await dal().tokens.requestEmailChange({
        userId: a.user.userId,
        sessionId: await sessionIdOf(a.client),
        newEmail: uniqueEmail("changed"),
        changeTokenHash: change.hash,
        cancelTokenHash: oneTimeToken().hash,
      });
      return { body: { token: change.token } };
    },
  },
  cancelEmailChange: {
    status: 204,
    prepare: async (_w, a) => {
      const cancel = oneTimeToken();
      await dal().tokens.requestEmailChange({
        userId: a.user.userId,
        sessionId: await sessionIdOf(a.client),
        newEmail: uniqueEmail("changed"),
        changeTokenHash: oneTimeToken().hash,
        cancelTokenHash: cancel.hash,
      });
      return { client: anon(), body: { token: cancel.token } };
    },
  },

  // ------------------------------------------------------------ me
  getMe: { status: 200, prepare: async () => ({}) },
  updateMe: {
    status: 200,
    prepare: async () => ({ body: { displayName: "Renamed Tester" } }),
  },
  changePassword: {
    status: 204,
    prepare: async () => ({ body: { newPassword: NEW_PASSWORD() } }),
  },
  requestEmailChange: {
    status: 202,
    prepare: async () => ({ body: { newEmail: uniqueEmail("new") } }),
  },
  listSessions: { status: 200, prepare: async () => ({}) },
  revokeSession: {
    status: 204,
    prepare: async (_w, a) => {
      const other = await testLogin(a.user.email, "second-device");
      return { params: { sessionId: await sessionIdOf(other) } };
    },
  },
  revokeOtherSessions: { status: 204, prepare: async () => ({}) },
  getMfa: { status: 200, prepare: async () => ({}) },
  beginTotpSetup: { status: 201, prepare: async () => ({}) },
  removeTotp: {
    status: 204,
    prepare: async (_w, a) => {
      const setup = await a.client.post<{ secret: string }>("/me/mfa/totp");
      expect(
        (
          await a.client.post("/me/mfa/totp/confirm", {
            code: totp(setup.body.secret, now()),
          })
        ).status,
      ).toBe(200);
      return {};
    },
  },
  confirmTotpSetup: {
    status: 200,
    prepare: async (_w, a) => {
      const setup = await a.client.post<{ secret: string }>("/me/mfa/totp");
      return { body: { code: totp(setup.body.secret, now()) } };
    },
  },
  createPasskeyRegistrationOptions: { status: 200, prepare: async () => ({}) },
  registerPasskey: {
    status: 201,
    prepare: async (_w, a) => {
      const options = await a.client.post<{
        challenge: string;
        rp: { id?: string };
      }>("/me/mfa/passkeys/options");
      return {
        body: {
          name: "Phone",
          credential: new SoftAuthenticator().register(options.body),
        },
      };
    },
  },
  removePasskey: {
    status: 204,
    prepare: async (_w, a) => ({
      params: { passkeyId: (await enrollPasskey(a.client)).passkeyId },
    }),
  },
  regenerateRecoveryCodes: {
    status: 200,
    prepare: async (_w, a) => {
      await enrollPasskey(a.client);
      return {};
    },
  },
  listMyInvitations: { status: 200, prepare: async () => ({}) },
  acceptInvitation: {
    status: 200,
    prepare: async (w, a) => {
      const { invitation } = await dal().invitations.createBudgetInvitation(
        w.outsiderBudget.scope,
        a.user.email,
      );
      return { params: { invitationId: invitation.id } };
    },
  },
  declineInvitation: {
    status: 204,
    prepare: async (w, a) => {
      const { invitation } = await dal().invitations.createBudgetInvitation(
        w.outsiderBudget.scope,
        a.user.email,
      );
      return { params: { invitationId: invitation.id } };
    },
  },
  listDeletedBudgets: { status: 200, prepare: async () => ({}) },
  restoreDeletedBudget: {
    status: 200,
    prepare: async (_w, a) => {
      const own = await createBudget(a.user, { name: "Old budget" });
      await dal().budgets.deleteBudget(own.scope, own.record.version);
      return { params: { deletedBudgetId: own.id } };
    },
  },
  exportMyData: {
    status: 200,
    prepare: async () => ({ body: { kind: "transactions" } }),
  },
  requestAccountDeletion: {
    status: 202,
    prepare: async () => {
      // The world's owner owns a shared budget (OWNS_SHARED_BUDGET); a solo user can leave.
      const solo = await createUser({ prefix: "solo" });
      return { client: await testLogin(solo.email, "solo") };
    },
  },
  cancelAccountDeletion: {
    status: 200,
    prepare: async () => {
      const solo = await createUser({ prefix: "leaving" });
      return { client: await pendingDeletionClient(solo) };
    },
  },

  // ------------------------------------------------------------ budgets
  listBudgets: { status: 200, prepare: async () => ({}) },
  createBudget: {
    status: 201,
    prepare: async () => ({
      idempotencyKey: randomUUID(),
      body: {
        name: "Holiday fund",
        timezone: "America/Chicago",
        categories: [{ name: "Gifts", kind: "expense", plannedCents: 10_000 }],
      },
    }),
  },
  getBudget: { status: 200, prepare: async (w) => ({ params: b(w) }) },
  updateBudget: {
    status: 200,
    prepare: async (w) => ({
      params: b(w),
      body: { name: "Renamed household", version: w.budget.record.version },
    }),
  },
  deleteBudget: {
    status: 204,
    prepare: async (w) => ({
      params: b(w),
      query: { version: w.budget.record.version },
    }),
  },
  listMembers: { status: 200, prepare: async (w) => ({ params: b(w) }) },
  removeMember: {
    status: 204,
    // The owner removes the member; the member removes themself (leave).
    prepare: async (w) => ({
      params: { ...b(w), userId: w.member.user.userId },
    }),
  },
  transferOwnership: {
    status: 200,
    prepare: async (w) => ({
      params: b(w),
      body: { userId: w.member.user.userId },
    }),
  },
  listBudgetInvitations: {
    status: 200,
    prepare: async (w) => ({ params: b(w) }),
  },
  createBudgetInvitation: {
    status: 201,
    prepare: async (w) => ({
      params: b(w),
      body: { email: uniqueEmail("partner") },
    }),
  },
  revokeBudgetInvitation: {
    status: 204,
    prepare: async (w) => {
      const { invitation } = await dal().invitations.createBudgetInvitation(
        w.budget.scope,
        uniqueEmail("later"),
      );
      return { params: { ...b(w), invitationId: invitation.id } };
    },
  },
  listCategories: {
    status: 200,
    prepare: async (w) => ({ params: b(w), query: { includeArchived: true } }),
  },
  createCategory: {
    status: 201,
    prepare: async (w) => ({
      params: b(w),
      body: { name: "Transport", kind: "expense" },
    }),
  },
  updateCategory: {
    status: 200,
    prepare: async (w) => {
      const id = w.budget.categories.Dining!;
      const c = await dal().categories.getCategory(w.budget.scope, id);
      return {
        params: { ...b(w), categoryId: id },
        body: { name: "Eating out", version: c.version },
      };
    },
  },
  deleteCategory: {
    status: 204,
    prepare: async (w) => {
      const id = await createCategory(w.budget.scope, "Unused");
      return { params: { ...b(w), categoryId: id }, query: { version: 1 } };
    },
  },
  getMonthPlan: {
    status: 200,
    prepare: async (w) => ({ params: { ...b(w), month: w.month } }),
  },
  putPlanEntry: {
    status: 201,
    prepare: async (w) => {
      const id = await createCategory(w.budget.scope, "Utilities");
      return {
        params: { ...b(w), month: w.month, categoryId: id },
        body: { amountCents: 12_000, version: null },
      };
    },
  },
  copyPreviousMonthPlan: {
    status: 200,
    prepare: async (w) => ({ params: { ...b(w), month: w.month }, body: {} }),
  },
  getMonthSummary: {
    status: 200,
    prepare: async (w) => ({ params: { ...b(w), month: w.month } }),
  },
  listTransactions: {
    status: 200,
    prepare: async (w) => ({
      params: b(w),
      query: { month: w.month, limit: 10 },
    }),
  },
  createTransaction: {
    status: 201,
    prepare: async (w) => ({
      params: b(w),
      idempotencyKey: randomUUID(),
      body: {
        date: w.today,
        direction: "outflow",
        amountCents: 2_500,
        payee: "Bakery",
        splits: [
          { categoryId: w.budget.categories.Groceries!, amountCents: 2_500 },
        ],
      },
    }),
  },
  getTransaction: {
    status: 200,
    prepare: async (w) => ({ params: { ...b(w), transactionId: w.tx.id } }),
  },
  replaceTransaction: {
    status: 200,
    prepare: async (w) => ({
      params: { ...b(w), transactionId: w.tx.id },
      body: {
        date: w.today,
        direction: "outflow",
        amountCents: 2_000,
        payee: "Corner shop",
        memo: "Edited",
        splits: [
          { categoryId: w.budget.categories.Groceries!, amountCents: 1_500 },
          { categoryId: w.budget.categories.Dining!, amountCents: 500 },
        ],
        version: w.tx.version,
      },
    }),
  },
  deleteTransaction: {
    status: 204,
    prepare: async (w) => ({
      params: { ...b(w), transactionId: w.tx.id },
      query: { version: w.tx.version },
    }),
  },
};

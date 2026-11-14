// /budgets, members, transfer-ownership, budget invitations and
// /me/invitations. Membership, role and re-auth are enforced by the route
// layer from the contract's x-* extensions before these handlers run.
import {
  toBudget,
  toInvitation,
  toMember,
  toMyInvitation,
} from "../http/mappers.ts";
import { defineRoute } from "../http/routes.ts";
import {
  BudgetCreate,
  BudgetInvitationParams,
  BudgetMemberParams,
  BudgetParams,
  BudgetUpdate,
  InvitationCreate,
  InvitationParams,
  OwnershipTransfer,
  VersionQuery,
} from "../http/schemas.ts";
import {
  acceptInvitation,
  createBudget,
  createInvitation,
  deleteBudget,
  invitationRateLimit,
  removeMember,
  revokeInvitation,
  transferOwnership,
} from "../services/budgets.ts";
import { mustAuth, mustScope, padUntil } from "./common.ts";

export const budgetRoutes = [
  defineRoute({
    operationId: "listBudgets",
    handler: async ({ deps, auth }) => ({
      status: 200,
      body: {
        items: (
          await deps.dal.budgets.listBudgetsForUser(
            mustAuth(auth).session.userId,
          )
        ).map(toBudget),
      },
    }),
  }),
  defineRoute({
    operationId: "createBudget",
    body: BudgetCreate,
    handler: async ({ deps, auth, body, idempotencyKey, op, rawBody }) => {
      const { replayed, budget } = await createBudget(
        deps,
        mustAuth(auth),
        body,
        {
          key: idempotencyKey ?? "",
          path: op.path,
          rawBody,
        },
      );
      return {
        status: 201,
        body: budget,
        headers: replayed ? { "idempotent-replayed": "true" } : {},
      };
    },
  }),
  defineRoute({
    operationId: "getBudget",
    params: BudgetParams,
    handler: async ({ deps, scope }) => ({
      status: 200,
      body: toBudget(await deps.dal.budgets.getBudget(mustScope(scope))),
    }),
  }),
  defineRoute({
    operationId: "updateBudget",
    params: BudgetParams,
    body: BudgetUpdate,
    handler: async ({ deps, scope, body }) => ({
      status: 200,
      body: toBudget(
        await deps.dal.budgets.updateBudget(mustScope(scope), body),
      ),
    }),
  }),
  defineRoute({
    operationId: "deleteBudget",
    params: BudgetParams,
    query: VersionQuery,
    handler: async ({ deps, auth, scope, query }) => {
      await deleteBudget(deps, mustAuth(auth), mustScope(scope), query.version);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "listMembers",
    params: BudgetParams,
    handler: async ({ deps, scope }) => ({
      status: 200,
      body: {
        items: (await deps.dal.members.listMembers(mustScope(scope))).map(
          toMember,
        ),
      },
    }),
  }),
  defineRoute({
    operationId: "removeMember",
    params: BudgetMemberParams,
    handler: async ({ deps, auth, scope, params }) => {
      await removeMember(deps, mustAuth(auth), mustScope(scope), params.userId);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "transferOwnership",
    params: BudgetParams,
    body: OwnershipTransfer,
    handler: async ({ deps, auth, scope, body }) => ({
      status: 200,
      body: await transferOwnership(
        deps,
        mustAuth(auth),
        mustScope(scope),
        body.userId,
      ),
    }),
  }),
  defineRoute({
    operationId: "listBudgetInvitations",
    params: BudgetParams,
    handler: async ({ deps, scope }) => ({
      status: 200,
      body: {
        items: (
          await deps.dal.invitations.listBudgetInvitations(mustScope(scope))
        ).map(toInvitation),
      },
    }),
  }),
  defineRoute({
    operationId: "createBudgetInvitation",
    params: BudgetParams,
    body: InvitationCreate,
    rateLimit: ({ deps, auth, params }) =>
      invitationRateLimit(deps, mustAuth(auth), params.budgetId),
    handler: async ({ deps, auth, scope, body, startedAt }) => {
      // F-22: the outcome (account or not, mail sent or not) leaves at a fixed 1 s.
      try {
        return {
          status: 201,
          body: await createInvitation(
            deps,
            mustAuth(auth),
            mustScope(scope),
            body.email,
          ),
        };
      } finally {
        await padUntil(deps, startedAt);
      }
    },
  }),
  defineRoute({
    operationId: "revokeBudgetInvitation",
    params: BudgetInvitationParams,
    handler: async ({ deps, auth, scope, params }) => {
      await revokeInvitation(
        deps,
        mustAuth(auth),
        mustScope(scope),
        params.invitationId,
      );
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "listMyInvitations",
    handler: async ({ deps, auth }) => ({
      status: 200,
      body: {
        items: (
          await deps.dal.invitations.listMyInvitations(
            mustAuth(auth).session.userId,
          )
        ).map(toMyInvitation),
      },
    }),
  }),
  defineRoute({
    operationId: "acceptInvitation",
    params: InvitationParams,
    handler: async ({ deps, auth, params }) => ({
      status: 200,
      body: await acceptInvitation(deps, mustAuth(auth), params.invitationId),
    }),
  }),
  defineRoute({
    operationId: "declineInvitation",
    params: InvitationParams,
    handler: async ({ deps, auth, params }) => {
      await deps.dal.invitations.declineInvitation(
        mustAuth(auth).session.userId,
        params.invitationId,
      );
      return { status: 204 };
    },
  }),
];

// /auth/* and /me routes implemented in Phase A. Phase B operations (MFA,
// password reset, email change, sessions, export, deletion) are not
// registered and answer 404 NOT_FOUND like any unknown route.
import { toMe } from "../http/mappers.ts";
import { defineRoute } from "../http/routes.ts";
import {
  LoginRequest,
  MeUpdate,
  ReauthRequest,
  SignupRequest,
  TokenRequest,
} from "../http/schemas.ts";
import {
  currentAuthState,
  login,
  loginRateLimit,
  logout,
  previewSignup,
  reauthRateLimit,
  reauthenticate,
  signup,
  signupRateLimit,
} from "../services/auth.ts";
import { mustAuth } from "./common.ts";

export const authRoutes = [
  defineRoute({
    operationId: "getAuthSession",
    handler: async ({ deps, auth }) => ({
      status: 200,
      body: await currentAuthState(deps, mustAuth(auth)),
    }),
  }),
  defineRoute({
    operationId: "login",
    body: LoginRequest,
    rateLimit: ({ deps, req, body }) => loginRateLimit(deps, req, body.email),
    handler: async ({ deps, req, reply, body }) => ({
      status: 200,
      body: await login(deps, req, reply, body),
    }),
  }),
  defineRoute({
    operationId: "logout",
    handler: async ({ deps, reply, auth }) => {
      await logout(deps, reply, auth);
      return { status: 204 };
    },
  }),
  defineRoute({
    operationId: "reauthenticate",
    body: ReauthRequest,
    rateLimit: ({ deps, auth }) => reauthRateLimit(deps, mustAuth(auth)),
    handler: async ({ deps, req, auth, body }) => ({
      status: 200,
      body: await reauthenticate(deps, req, mustAuth(auth), body),
    }),
  }),
  defineRoute({
    operationId: "previewSignupInvite",
    body: TokenRequest,
    rateLimit: ({ deps, req }) => signupRateLimit(deps, req),
    handler: async ({ deps, body }) => ({
      status: 200,
      body: await previewSignup(deps, body.token),
    }),
  }),
  defineRoute({
    operationId: "signup",
    body: SignupRequest,
    rateLimit: ({ deps, req }) => signupRateLimit(deps, req),
    handler: async ({ deps, req, reply, body }) => ({
      status: 201,
      body: await signup(deps, req, reply, body),
    }),
  }),
  defineRoute({
    operationId: "getMe",
    handler: async ({ deps, auth }) => ({
      status: 200,
      body: toMe(await deps.dal.users.getMe(mustAuth(auth).session.userId)),
    }),
  }),
  defineRoute({
    operationId: "updateMe",
    body: MeUpdate,
    handler: async ({ deps, auth, body }) => ({
      status: 200,
      body: toMe(
        await deps.dal.users.updateDisplayName(
          mustAuth(auth).session.userId,
          body.displayName,
        ),
      ),
    }),
  }),
];

// Sign-up, sign-in, sign-out and re-authentication (auth.md §2, §4, §5, §7,
// §10, §14, §15). Route handlers in routes/auth.ts stay thin.
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseDevice } from "../auth/device.ts";
import type { AuthContext } from "../auth/session.ts";
import {
  REAUTH_WINDOW_MS,
  authenticatedState,
  clearCookie,
  issueSession,
  mfaRequiredState,
  resolveSession,
  setSessionCookie,
} from "../auth/session.ts";
import { randomToken, sha256 } from "../crypto/keyring.ts";
import { authenticationOptions, newChallenge } from "../auth/webauthn.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { DAY, MINUTE, ipKey } from "../http/rate-limit.ts";
import type { AttemptGuard, MfaProofInput } from "./mfa.ts";
import { assertMfaBudget, refusedAttempt, relyingParty, throttleGuard, verifySecondFactor } from "./mfa.ts";

export const LOGIN_IP_LIMIT = 20; // attempts / 15 min
export const LOGIN_PAIR_FAILURES = 10; // (email, IP) failures / 15 min
export const LOGIN_EMAIL_FAILURES = 100; // email failures / 24 h
export const SIGNUP_IP_LIMIT = 10; // preview + signup / hour
export const REAUTH_SESSION_FAILURES = 5; // / 15 min
const FIFTEEN_MIN = 15 * MINUTE;

function loginKeys(deps: AppDeps, email: string, ip: string) {
  const t = deps.throttles;
  return {
    ip: t.key("login:ip", ip),
    pair: t.key("login:email_ip", `${email}\0${ip}`),
    email: t.key("login:email_day", email),
  };
}

/** errors.md step 7 for POST /auth/login. */
export async function loginRateLimit(
  deps: AppDeps,
  req: FastifyRequest,
  email: string,
): Promise<void> {
  const k = loginKeys(deps, email, ipKey(req.ip));
  await deps.throttles.hitOrThrow(k.ip, LOGIN_IP_LIMIT, FIFTEEN_MIN);
  await deps.throttles.assertUnder(k.pair, LOGIN_PAIR_FAILURES, FIFTEEN_MIN);
  if ((await deps.throttles.rollingCount(k.email, DAY)) >= LOGIN_EMAIL_FAILURES)
    throw new ApiError("RATE_LIMITED", { retryAfterSeconds: 3600 });
}

/** errors.md step 7 for the sign-up endpoints (preview and signup combined). */
export async function signupRateLimit(
  deps: AppDeps,
  req: FastifyRequest,
): Promise<void> {
  await deps.throttles.hitOrThrow(
    deps.throttles.key("signup:ip", ipKey(req.ip)),
    SIGNUP_IP_LIMIT,
    60 * MINUTE,
  );
}

export async function login(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  input: { email: string; password: string },
) {
  const { dal, passwords } = deps;
  const creds = await dal.users.getLoginCredentials(input.email);
  const ok = creds
    ? await passwords.verify(creds.passwordHash, input.password)
    : await passwords.verifyDummy(input.password);
  if (!creds || !ok) {
    const k = loginKeys(deps, input.email, ipKey(req.ip));
    await deps.throttles.hit(k.pair, FIFTEEN_MIN);
    const failures = await deps.throttles.rollingHit(k.email, DAY);
    await dal.securityEvents.recordSecurityEvent({
      type: "login_failed",
      userId: creds?.userId ?? null,
      ip: req.ip,
    });
    if (creds && failures === LOGIN_EMAIL_FAILURES) {
      const contact = await dal.users.getUserContact(creds.userId);
      await deps.mailer.send(deps.notifications.loginThrottled(contact.email));
    }
    throw new ApiError("INVALID_CREDENTIALS");
  }
  if (passwords.needsRehash(creds.passwordHash)) {
    // Rehash on login only (no F-01 side effects by design).
    await dal.users.updatePasswordHash(
      creds.userId,
      await passwords.hash(input.password),
    );
  }
  const prior = await resolveSession(deps, req);
  const device = parseDevice(req.headers["user-agent"]);
  const mfa = await dal.mfa.getMfaSummary(creds.userId);
  if (mfa.enabled) {
    const pending = await issueSession(deps, reply, {
      userId: creds.userId,
      status: "mfa_pending",
      device,
      replacesSessionId: prior?.session.id,
    });
    return mfaRequiredState(deps, pending);
  }
  const session = await issueSession(deps, reply, {
    userId: creds.userId,
    status: "active",
    device,
    mfaVerified: false,
    replacesSessionId: prior?.session.id,
  });
  await dal.securityEvents.recordSecurityEvent({
    type: "login_succeeded",
    userId: creds.userId,
    sessionId: session.id,
    deviceBrowser: device.browser,
    deviceOs: device.os,
    ip: req.ip,
  });
  const state = await authenticatedState(deps, session);
  // F-12, F-34: a notice on every successful sign-in, no skip rule.
  await deps.mailer.send(
    deps.notifications.newSignIn(state.user.email, device, deps.clock.now()),
  );
  return state;
}

export async function previewSignup(deps: AppDeps, token: string) {
  const preview = await deps.dal.signup.previewSignupInvite(sha256(token));
  return {
    email: preview.email,
    expiresAt: preview.expiresAt.toISOString(),
  };
}

export async function signup(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  input: { token: string; displayName: string; password: string },
) {
  const tokenHash = sha256(input.token);
  // The policy needs the invite's email (password != email); INVITATION_INVALID otherwise.
  const { email } = await deps.dal.signup.previewSignupInvite(tokenHash);
  await deps.passwords.assertAcceptable(input.password, email, {
    in: "body",
    field: "password",
  });
  const passwordHash = await deps.passwords.hash(input.password);
  const { userId } = await deps.dal.signup.signUpWithInvite({
    tokenHash,
    displayName: input.displayName,
    passwordHash,
  });
  const prior = await resolveSession(deps, req);
  const device = parseDevice(req.headers["user-agent"]);
  const session = await issueSession(deps, reply, {
    userId,
    status: "active",
    device,
    mfaVerified: false,
    replacesSessionId: prior?.session.id,
  });
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "signup",
    userId,
    sessionId: session.id,
    deviceBrowser: device.browser,
    deviceOs: device.os,
    ip: req.ip,
  });
  return authenticatedState(deps, session);
}

export async function logout(
  deps: AppDeps,
  reply: FastifyReply,
  auth: AuthContext | null,
): Promise<void> {
  if (auth) {
    // Only the ID resolved from the caller's own cookie (PR #4 note).
    await deps.dal.sessions.deleteSession(auth.session.id);
    await deps.dal.securityEvents.recordSecurityEvent({
      type: "logout",
      userId: auth.session.userId,
      sessionId: auth.session.id,
    });
  }
  clearCookie(deps, reply);
}

export async function currentAuthState(deps: AppDeps, auth: AuthContext) {
  return auth.session.status === "active"
    ? authenticatedState(deps, auth.session)
    : mfaRequiredState(deps, auth.session);
}

/** reauth row: 5 failures (password or second factor) per session per 15 min, counted first (F-45). */
export function reauthGuard(deps: AppDeps, auth: AuthContext) {
  return throttleGuard(deps, "reauth:session", auth.session.id, REAUTH_SESSION_FAILURES, FIFTEEN_MIN);
}

/** POST /auth/reauth: password, plus a second factor when the user has MFA (auth.md §10). */
export async function reauthenticate(
  deps: AppDeps,
  _req: FastifyRequest,
  auth: AuthContext,
  input: { password: string; mfa?: MfaProofInput | undefined },
) {
  const { dal } = deps;
  const userId = auth.session.userId;
  // The attempt is counted before any check and refunded only on success.
  const guard = reauthGuard(deps, auth);
  await guard.reserve();
  const fail = async (code: "INVALID_CREDENTIALS" | null) => {
    await dal.securityEvents.recordSecurityEvent({ type: "reauth_failed", userId, sessionId: auth.session.id });
    if (code) throw new ApiError(code);
  };
  const hash = await dal.users.getPasswordHash(userId);
  if (!(await deps.passwords.verify(hash, input.password))) await fail("INVALID_CREDENTIALS");
  const mfa = await dal.mfa.getMfaSummary(userId);
  if (mfa.enabled) {
    if (input.mfa === undefined) {
      await guard.release(); // the password was right; asking for the factor is not a failure
      throw new ApiError("MFA_REQUIRED");
    }
    try {
      await verifySecondFactor(deps, userId, input.mfa, { kind: "reauth", sessionId: auth.session.id });
    } catch (e) {
      if (e instanceof ApiError && e.code === "MFA_FAILED") await fail(null);
      else await guard.release(); // 429 from the user budget: not counted here
      throw e;
    }
  }
  await guard.release();
  await dal.sessions.markReauthenticated(auth.session.id, { mfaVerified: mfa.enabled });
  await dal.securityEvents.recordSecurityEvent({
    type: "reauth_succeeded",
    userId,
    sessionId: auth.session.id,
  });
  return {
    reauthenticatedUntil: new Date(
      deps.clock.now().getTime() + REAUTH_WINDOW_MS,
    ).toISOString(),
  };
}

/**
 * POST /auth/mfa/verify (mfa_pending session). Success replaces the pending
 * session with a new active one (new cookie and CSRF token) and sends the
 * new sign-in notice. 5 failures delete the pending session; the 5th emails
 * the user (auth.md §5).
 */
export async function completeMfaSignIn(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContext,
  proof: MfaProofInput,
) {
  const { dal } = deps;
  const pending = auth.session;
  await verifySecondFactor(deps, pending.userId, proof, { kind: "login", sessionId: pending.id }, pendingSessionGuard(deps, reply, pending));
  const token = randomToken();
  const session = await dal.sessions.completeMfaSession(pending.id, { tokenHash: sha256(token), csrfToken: randomToken() });
  if (!session) throw new ApiError("UNAUTHENTICATED");
  setSessionCookie(deps, reply, token, session.expiresAt);
  const device = { browser: session.deviceBrowser, os: session.deviceOs };
  await dal.securityEvents.recordSecurityEvent({ type: "mfa_succeeded", userId: session.userId, sessionId: session.id });
  await dal.securityEvents.recordSecurityEvent({
    type: "login_succeeded",
    userId: session.userId,
    sessionId: session.id,
    deviceBrowser: device.browser,
    deviceOs: device.os,
    ip: req.ip,
  });
  const state = await authenticatedState(deps, session);
  await deps.mailer.send(deps.notifications.newSignIn(state.user.email, device, deps.clock.now()));
  return state;
}

/**
 * POST /auth/webauthn/challenge: `mfa` needs an mfa_pending session, `reauth`
 * an active one (else 403). 409 MFA_NOT_ENABLED without passkeys. One
 * outstanding challenge per session; a new call replaces it.
 */
export async function webauthnChallenge(deps: AppDeps, auth: AuthContext, purpose: "mfa" | "reauth") {
  const { dal } = deps;
  const wanted = purpose === "mfa" ? "mfa_pending" : "active";
  if (auth.session.status !== wanted) throw new ApiError("FORBIDDEN");
  await assertMfaBudget(deps, auth.session.userId);
  const creds = await dal.mfa.listPasskeyCredentials(auth.session.userId);
  if (creds.length === 0) throw new ApiError("MFA_NOT_ENABLED");
  const challenge = newChallenge();
  await dal.mfa.createWebAuthnChallenge(auth.session.userId, { purpose, sessionId: auth.session.id }, challenge);
  return authenticationOptions(relyingParty(deps), creds, challenge);
}

/**
 * mfa-verify row for the pending session (auth.md §5, F-45): an attempt slot
 * is reserved atomically before the check, so at most 5 checks ever run per
 * pending session. When the last slot fails the session is deleted and the
 * user is emailed once (`deleted` is true for exactly one caller).
 */
function pendingSessionGuard(deps: AppDeps, reply: FastifyReply, pending: AuthContext["session"]): AttemptGuard {
  return {
    async reserve() {
      const r = await deps.dal.sessions.reserveSessionMfaAttempt(pending.id);
      if (!r.granted) {
        if (r.reason === "invalid") clearCookie(deps, reply);
        throw refusedAttempt(r.reason, () => new ApiError("UNAUTHENTICATED"));
      }
    },
    async failed() {
      const r = await deps.dal.sessions.failSessionMfaAttempt(pending.id);
      if (!r.open) clearCookie(deps, reply);
      if (r.deleted) {
        const contact = await deps.dal.users.getUserContact(pending.userId);
        await deps.mailer.send(deps.notifications.mfaFailures(contact.email));
      }
    },
    release: () => deps.dal.sessions.releaseSessionMfaAttempt(pending.id),
  };
}

// Server-side cookie sessions (auth.md §2): opaque 32-byte token in an
// httpOnly cookie, only SHA-256(token) stored; per-session CSRF token; 30-day
// sliding expiry capped at 90 days (enforced by the DAL); rotation on sign-up,
// login and MFA completion. Tokens never appear in logs or response bodies.
import type {
  DeviceBrowser,
  DeviceOs,
  MfaSummaryRecord,
  SessionRecord,
  SessionStatus,
  UserStatus,
} from "@shoestring/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomToken, sha256 } from "../crypto/keyring.ts";
import type { AppDeps } from "../deps.ts";
import { iso, toMe } from "../http/mappers.ts";

export const REAUTH_WINDOW_MS = 10 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthContext {
  readonly session: SessionRecord;
  readonly userStatus: UserStatus;
  /** The raw cookie token (Secret): kept in memory for this request only, to re-send the cookie. */
  readonly token: string;
}

export function cookieName(secure: boolean): string {
  return secure ? "__Host-ss_sid" : "ss_sid";
}

/** The session token from the Cookie header, or null (malformed values are ignored). */
export function readSessionToken(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(
  name: string,
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attrs = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(name: string, secure: boolean): string {
  return sessionCookie(name, "", 0, secure);
}

export function setSessionCookie(
  deps: AppDeps,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  const secure = deps.config.cookieSecure;
  const maxAge = (expiresAt.getTime() - deps.clock.now().getTime()) / 1000;
  reply.header(
    "set-cookie",
    sessionCookie(cookieName(secure), token, maxAge, secure),
  );
}

export function clearCookie(deps: AppDeps, reply: FastifyReply): void {
  const secure = deps.config.cookieSecure;
  reply.header("set-cookie", clearSessionCookie(cookieName(secure), secure));
}

/** Resolves the caller's own cookie to an unexpired session (or null). */
export async function resolveSession(
  deps: AppDeps,
  req: FastifyRequest,
): Promise<AuthContext | null> {
  const token = readSessionToken(
    req.headers.cookie,
    cookieName(deps.config.cookieSecure),
  );
  if (!token) return null;
  const found = await deps.dal.sessions.findSessionByTokenHash(sha256(token));
  return found
    ? { session: found.session, userStatus: found.userStatus, token }
    : null;
}

export interface IssueSessionInput {
  userId: string;
  status: SessionStatus;
  device: { browser: DeviceBrowser; os: DeviceOs };
  mfaVerified?: boolean;
  /** Only an ID resolved from the caller's own cookie (security note for PR #4). */
  replacesSessionId?: string | undefined;
}

/** Creates a session row and sets the cookie. */
export async function issueSession(
  deps: AppDeps,
  reply: FastifyReply,
  input: IssueSessionInput,
): Promise<SessionRecord> {
  const token = randomToken();
  const session = await deps.dal.sessions.createSession({
    userId: input.userId,
    tokenHash: sha256(token),
    csrfToken: randomToken(),
    status: input.status,
    deviceBrowser: input.device.browser,
    deviceOs: input.device.os,
    ...(input.mfaVerified !== undefined
      ? { mfaVerified: input.mfaVerified }
      : {}),
    replacesSessionId: input.replacesSessionId,
  });
  setSessionCookie(deps, reply, token, session.expiresAt);
  return session;
}

export function reauthenticatedUntil(
  session: SessionRecord,
  now: Date,
): string | null {
  if (!session.reauthAt) return null;
  const until = session.reauthAt.getTime() + REAUTH_WINDOW_MS;
  return until > now.getTime() ? new Date(until).toISOString() : null;
}

export function hasFreshReauth(session: SessionRecord, now: Date): boolean {
  return reauthenticatedUntil(session, now) !== null;
}

export function mfaMethods(
  mfa: MfaSummaryRecord,
): ("totp" | "passkey" | "recovery_code")[] {
  const out: ("totp" | "passkey" | "recovery_code")[] = [];
  if (mfa.totp) out.push("totp");
  if (mfa.passkeyCount > 0) out.push("passkey");
  if (mfa.recoveryCodesRemaining > 0) out.push("recovery_code");
  return out;
}

/** AuthState for an `active` session. */
export async function authenticatedState(
  deps: AppDeps,
  session: SessionRecord,
) {
  const me = await deps.dal.users.getMe(session.userId);
  return {
    state: "authenticated" as const,
    user: toMe(me),
    session: {
      id: session.id,
      expiresAt: iso(session.expiresAt),
      reauthenticatedUntil: reauthenticatedUntil(session, deps.clock.now()),
    },
    csrfToken: session.csrfToken,
  };
}

/** AuthState for an `mfa_pending` session. */
export async function mfaRequiredState(deps: AppDeps, session: SessionRecord) {
  const mfa = await deps.dal.mfa.getMfaSummary(session.userId);
  return {
    state: "mfa_required" as const,
    mfaMethods: mfaMethods(mfa),
    expiresAt: iso(session.expiresAt),
    csrfToken: session.csrfToken,
  };
}

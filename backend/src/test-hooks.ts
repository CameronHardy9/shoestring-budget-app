// TEST HOOKS: development entry only (test-hooks.md, ADR-0009). Imported by
// src/dev-server.ts and nothing else; the production build never contains it,
// and the Dockerfile tripwire fails the image build if the sentinel below (or
// the hooks' route prefix) ever appears in backend/dist.
import { resetDatabase } from "@shoestring/db/testing";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticatedState, issueSession } from "./auth/session.ts";
import { parseDevice } from "./auth/device.ts";
import { randomToken, sha256 } from "./crypto/keyring.ts";
import type { AppDeps } from "./deps.ts";
import { Outbox } from "./email/transports.ts";
import type { EmailTransport } from "./email/transports.ts";
import { ApiError } from "./errors.ts";
import { email, noBody, parseOrThrow } from "./http/validation.ts";

/** Sentinel: its absence from backend/dist proves the hooks are out (never tree-shaken). */
export const __SHOESTRING_TEST_HOOKS__ = "__SHOESTRING_TEST_HOOKS__";

const PREFIX = "/api/_test";

/** test-hooks.md §4: only localhost, 127.0.0.1 (http) or *.test origins. */
export function hookOriginAllowed(appOrigin: string): boolean {
  let u: URL;
  try {
    u = new URL(appOrigin);
  } catch {
    return false;
  }
  if (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1")
  )
    return true;
  return (
    (u.protocol === "http:" || u.protocol === "https:") &&
    u.hostname.endsWith(".test")
  );
}

export interface HookGuardInput {
  nodeEnv: string;
  testHooks: boolean;
  appOrigin: string;
  adminDatabaseUrl: string | undefined;
}

/** Every guard must pass; otherwise the hooks stay unregistered. Returns the failing guard. */
export function hookGuardFailure(g: HookGuardInput): string | null {
  if (!g.testHooks) return "TEST_HOOKS is not 1";
  if (g.nodeEnv !== "development" && g.nodeEnv !== "test")
    return "NODE_ENV is not development or test";
  if (!hookOriginAllowed(g.appOrigin))
    return "APP_ORIGIN is not a localhost or .test origin";
  if (!g.adminDatabaseUrl) return "DATABASE_ADMIN_URL is not set";
  return null;
}

const ClockBody = z.strictObject({
  now: z.union([z.iso.datetime({ offset: true }), z.null()]),
});
const EmailBody = z.strictObject({ email });
const EmailsQuery = z.strictObject({ to: z.string().max(254).optional() });

export interface TestHookOptions {
  adminDatabaseUrl: string;
  transport: EmailTransport | null;
}

export async function registerTestHooks(
  app: FastifyInstance,
  deps: AppDeps,
  options: TestHookOptions,
): Promise<void> {
  const outbox = options.transport instanceof Outbox ? options.transport : null;
  const config = { devHook: true };

  app.post(`${PREFIX}/reset`, { config }, async (req, reply) => {
    parseOrThrow(noBody, req.body, "body");
    await resetDatabase(options.adminDatabaseUrl);
    deps.limiter.clear();
    return reply.code(204).send();
  });

  app.post(`${PREFIX}/clock`, { config }, async (req, reply) => {
    const { now } = parseOrThrow(ClockBody, req.body, "body");
    deps.clock.freeze(now === null ? null : new Date(now));
    return reply.code(204).send();
  });

  app.post(`${PREFIX}/signup-invites`, { config }, async (req, reply) => {
    const body = parseOrThrow(EmailBody, req.body, "body");
    const token = randomToken();
    const invite = await deps.dal.signup.createSignupInvite(
      body.email,
      sha256(token),
    );
    await deps.mailer.send(
      deps.notifications.signupInvite(body.email, token, invite.expiresAt),
    );
    return reply.code(201).send({ token });
  });

  app.post(`${PREFIX}/login`, { config }, async (req, reply) => {
    const body = parseOrThrow(EmailBody, req.body, "body");
    const userId = await deps.dal.users.findUserIdByEmail(body.email);
    if (!userId) throw new ApiError("NOT_FOUND");
    const session = await issueSession(deps, reply, {
      userId,
      status: "active",
      device: parseDevice(req.headers["user-agent"]),
      mfaVerified: true,
    });
    return reply.code(200).send(await authenticatedState(deps, session));
  });

  app.get(`${PREFIX}/emails`, { config }, async (req, reply) => {
    const q = parseOrThrow(EmailsQuery, req.query, "query");
    return reply.code(200).send({ items: outbox ? outbox.list(q.to) : [] });
  });

  app.delete(`${PREFIX}/emails`, { config }, async (_req, reply) => {
    outbox?.clear();
    return reply.code(204).send();
  });

  await Promise.resolve();
}

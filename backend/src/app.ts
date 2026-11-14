// Builds the Fastify app: config-driven deps, the pipeline, the contract route
// table and (optionally) static SPA serving. No test hooks here: those are
// added only by src/dev-server.ts (ADR-0009).
import type { Dal } from "@shoestring/db";
import { createDal, createUuidV7Generator } from "@shoestring/db";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { setTimeout as sleep } from "node:timers/promises";
import { PasswordService, createBreachChecker } from "./auth/passwords.ts";
import type { AppClock } from "./clock.ts";
import { createAppClock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { AppDeps } from "./deps.ts";
import { CursorCodec } from "./domain/cursor.ts";
import { Mailer } from "./email/mailer.ts";
import { Notifications } from "./email/notifications.ts";
import {
  ConsoleTransport,
  Outbox,
  ResendTransport,
} from "./email/transports.ts";
import type { EmailTransport } from "./email/transports.ts";
import { ApiError, fieldError, validationFailed } from "./errors.ts";
import { registerPipeline, sendError } from "./http/pipeline.ts";
import { MemoryLimiter, Throttles } from "./http/rate-limit.ts";
import { ResponseValidator } from "./http/response-validation.ts";
import type { Route } from "./http/routes.ts";
import { registerRoutes } from "./http/routes.ts";
import { registerStatic, sendIndex, wantsSpaFallback } from "./http/static.ts";
import type { Logger } from "./logging.ts";
import { accountRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { budgetRoutes } from "./routes/budgets.ts";
import { healthRoutes } from "./routes/health.ts";
import {
  categoryRoutes,
  planRoutes,
  transactionRoutes,
} from "./routes/ledger.ts";

/** Every implemented operation. Unlisted contract operations are not registered (404). */
export const apiRoutes: readonly Route[] = [
  ...healthRoutes,
  ...authRoutes,
  ...accountRoutes,
  ...budgetRoutes,
  ...categoryRoutes,
  ...planRoutes,
  ...transactionRoutes,
];

export const BODY_LIMIT = 64 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export interface DepsOverrides {
  dal?: Dal;
  clock?: AppClock;
  transport?: EmailTransport;
  passwords?: PasswordService;
  wallNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

/** Wires real dependencies from config (overridable for tests and the dev entry). */
export function createDeps(
  config: Config,
  logger: Logger,
  o: DepsOverrides = {},
): AppDeps {
  const clock = o.clock ?? createAppClock();
  const dal =
    o.dal ??
    createDal({
      connectionString: config.databaseUrl,
      clock: () => clock.now(),
    });
  const throttles = new Throttles(dal, config.keyring, clock);
  const transport: EmailTransport =
    o.transport ??
    (config.email.transport === "provider"
      ? new ResendTransport(
          config.email.apiKey ?? "",
          config.email.from ?? "",
          o.fetch,
        )
      : config.email.transport === "test"
        ? new Outbox(() => clock.now())
        : new ConsoleTransport());
  return {
    config,
    dal,
    clock,
    logger,
    passwords:
      o.passwords ??
      new PasswordService({
        isBreached: createBreachChecker({
          enabled: config.hibpEnabled,
          logger,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        }),
      }),
    throttles,
    limiter: new MemoryLimiter(clock),
    mailer: new Mailer({
      transport,
      throttles,
      clock,
      logger,
      dailyQuota: config.email.dailyQuota,
    }),
    notifications: new Notifications(config.appOrigin),
    cursors: new CursorCodec(config.keyring),
    responseValidator:
      config.nodeEnv === "production" ? null : new ResponseValidator(),
    wallNow: o.wallNow ?? Date.now,
    sleep: o.sleep ?? ((ms) => sleep(ms).then(() => undefined)),
  };
}

const newRequestId = createUuidV7Generator();

export interface BuildAppOptions {
  routes?: readonly Route[];
  /** Registers extra routes (the dev entry's test hooks) after the pipeline. */
  extend?: (app: FastifyInstance) => Promise<void>;
}

export async function buildApp(
  deps: AppDeps,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { config } = deps;
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    // One log line per request comes from the onResponse hook (pipeline.ts).
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "requestId" }),
    genReqId: (req) => {
      const sent = req.headers["x-request-id"];
      return typeof sent === "string" && REQUEST_ID_RE.test(sent)
        ? sent
        : newRequestId();
    },
    // F-08: trust exactly the platform's hop count (never `true`), so a forged
    // leftmost X-Forwarded-For entry is ignored. Index 0 is the socket peer.
    trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops,
    bodyLimit: BODY_LIMIT,
    exposeHeadRoutes: false,
    return503OnClosing: true,
    routerOptions: {
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      maxParamLength: 200,
    },
  });

  // JSON only (auth.md §3 step 4). Empty body -> undefined; the route schema decides.
  app.removeAllContentTypeParsers();
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: BODY_LIMIT },
    (req, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text === "") {
        done(null, undefined);
        return;
      }
      void defaultJson(req, text, (err, value) => {
        if (err)
          done(
            validationFailed([fieldError("body", "", "invalid_format")]),
            undefined,
          );
        else done(null, value);
      });
    },
  );

  // Deny by default: every /api route must carry contract metadata (or be a dev hook).
  app.addHook("onRoute", (r) => {
    const url = r.url;
    if (url.startsWith("/api") && !r.config?.op && r.config?.devHook !== true)
      throw new Error(`route ${url} has no contract operation`);
  });

  registerPipeline(app, deps);
  registerRoutes(app, deps, options.routes ?? apiRoutes);
  const hasStatic = config.staticDir
    ? await registerStatic(app, config.staticDir)
    : false;
  if (options.extend) await options.extend(app);

  app.setNotFoundHandler((req, reply) => {
    if (hasStatic && wantsSpaFallback(req)) return sendIndex(reply);
    return sendError(deps, req, reply, new ApiError("NOT_FOUND"));
  });
  return app;
}

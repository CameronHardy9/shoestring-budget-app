// Development entry (pnpm dev, make dev, make e2e). Same app as server.ts,
// plus the test hooks when every guard passes (test-hooks.md, ADR-0009):
// TEST_HOOKS=1, NODE_ENV development|test (config already refuses production),
// a localhost or *.test APP_ORIGIN, and DATABASE_ADMIN_URL. Never bundled.
import { buildApp, createDeps } from "./app.ts";
import { createAppClock } from "./clock.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { ConsoleTransport, Outbox } from "./email/transports.ts";
import { createLogger } from "./logging.ts";
import { hookGuardFailure, registerTestHooks } from "./test-hooks.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(
      `${e instanceof ConfigError ? e.message : "invalid configuration"}\n`,
    );
    process.exit(1);
  }
  const logger = createLogger(config);
  const clock = createAppClock();
  const transport =
    config.email.transport === "test"
      ? new Outbox(() => clock.now())
      : config.email.transport === "console"
        ? new ConsoleTransport()
        : undefined;
  const deps = createDeps(config, logger, {
    clock,
    ...(transport ? { transport } : {}),
  });

  const adminDatabaseUrl = process.env.DATABASE_ADMIN_URL;
  const failure = hookGuardFailure({
    nodeEnv: config.nodeEnv,
    testHooks: config.testHooks,
    appOrigin: config.appOrigin,
    adminDatabaseUrl,
  });
  if (config.testHooks && failure)
    logger.warn({ reason: failure }, "test hooks NOT registered");

  const app = await buildApp(deps, {
    extend: async (a) => {
      if (failure || !adminDatabaseUrl) return;
      await registerTestHooks(a, deps, {
        adminDatabaseUrl,
        transport: transport ?? null,
      });
      logger.warn("test hooks registered (development entry only)");
    },
  });
  const shutdown = async (): Promise<void> => {
    await app.close();
    await deps.dal.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
}

void main();

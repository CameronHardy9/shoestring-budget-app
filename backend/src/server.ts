// Production entry point (built to dist/server.js). Never imports the test
// hooks module, directly or dynamically (test-hooks.md, ADR-0009).
import { buildApp, createDeps } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logging.ts";
import { initErrorTracker } from "./observability/error-tracker.ts";

function fatal(message: string): never {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: message, time: new Date().toISOString() })}\n`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    fatal(e instanceof ConfigError ? e.message : "invalid configuration");
  }
  const logger = createLogger(config);
  // A no-op unless SENTRY_DSN is set (then @sentry/node is loaded).
  const errors = await initErrorTracker({
    dsn: config.sentryDsn,
    release: config.release,
    environment: config.nodeEnv,
    captureUncaught: true,
  });
  const deps = createDeps(config, logger, { errors });
  const app = await buildApp(deps);
  const shutdown = async (): Promise<void> => {
    await app.close();
    await errors.flush(2000); // in-flight 5xx events and quota alerts
    await deps.dal.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
}

main().catch(() => {
  fatal("server failed to start");
});

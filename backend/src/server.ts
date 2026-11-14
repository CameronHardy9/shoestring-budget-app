// Production entry point (built to dist/server.js). Never imports the test
// hooks module, directly or dynamically (test-hooks.md, ADR-0009).
import { buildApp, createDeps } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logging.ts";

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
  const deps = createDeps(config, logger);
  const app = await buildApp(deps);
  const shutdown = async (): Promise<void> => {
    await app.close();
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

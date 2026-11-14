// GET /healthz (process up, no database) and GET /readyz (database within 1 s,
// migrations applied, every key ID in use present in APP_KEYRING). readyz is
// public: its 503 body is the generic UNAVAILABLE message; the failing check is
// logged server-side only (errors.md, data-model.md "Rotation check").
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { defineRoute } from "../http/routes.ts";

type Check = "database" | "migrations" | "keyring";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("timeout"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readiness(deps: AppDeps): Promise<Check | null> {
  try {
    await withTimeout(deps.dal.health.ping(), 1_000);
  } catch {
    return "database";
  }
  try {
    if (!(await withTimeout(deps.dal.health.isSchemaCurrent(), 1_000)))
      return "migrations";
    const inUse = await withTimeout(deps.dal.mfa.listKeyIdsInUse(), 1_000);
    if (inUse.some((id) => !deps.config.keyring.keyIds.includes(id)))
      return "keyring";
  } catch {
    return "database";
  }
  return null;
}

export const healthRoutes = [
  defineRoute({
    operationId: "getHealthz",
    handler: ({ deps }) =>
      Promise.resolve({
        status: 200,
        body: { status: "ok", version: deps.config.release },
      }),
  }),
  defineRoute({
    operationId: "getReadyz",
    handler: async ({ deps, req }) => {
      const failed = await readiness(deps);
      if (failed) {
        req.log.warn({ readiness: failed }, "not ready");
        throw new ApiError("UNAVAILABLE");
      }
      return {
        status: 200,
        body: { status: "ok", checks: { database: "ok" } },
      };
    },
  }),
];

// The shared DAL for factories and assertions (test-hooks.md: factories write
// through the data-engineer's DAL, not HTTP). Its clock is the same instant the
// server's clock is frozen at (hooks.now()). Kept apart from hooks.ts so suites
// that only use HTTP never load the database packages.
import { createDal } from "@shoestring/db";
import type { Dal } from "@shoestring/db";
import { databaseUrl } from "./db-env.ts";
import { now, onTeardown } from "./hooks.ts";

let dalInstance: Dal | null = null;

export function dal(): Dal {
  dalInstance ??= createDal({
    connectionString: databaseUrl(),
    clock: () => now(),
    poolMax: 4,
    applicationName: "shoestring-tests",
  });
  return dalInstance;
}

export async function closeDal(): Promise<void> {
  await dalInstance?.close();
  dalInstance = null;
}

onTeardown(closeDal);

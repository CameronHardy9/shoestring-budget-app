// `pnpm --filter ./db run seed` (make dev with SEED=1). Idempotent and
// deterministic: see src/seed/demo.ts. Runs as the `app` role (DATABASE_URL)
// through the DAL, like the backend.
//
// Sign-in for the seed users: set SEED_USER_PASSWORD (12+ characters) in your
// local environment before the first seed; it is hashed with argon2id
// (Node's built-in crypto.argon2). Without it, each seed user gets a random
// password nobody knows (use the dev test-login hook or a password reset).
// No password is ever written to the repository or printed.
import { argon2Sync, randomBytes } from "node:crypto";
import { manualClock } from "../clock.ts";
import { DatabaseUrlError, assertLocalDatabaseUrl } from "../conn.ts";
import { createDal } from "../dal.ts";
import { createDeterministicIdGenerator } from "../ids.ts";
import { SEED_START, seedDemoData } from "../seed/demo.ts";

const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");

/** argon2id PHC string with the OWASP baseline parameters used by the backend (auth.md §7). */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const memory = 19_456;
  const passes = 2;
  const hash = argon2Sync("argon2id", {
    message: password,
    nonce: salt,
    parallelism: 1,
    tagLength: 32,
    memory,
    passes,
  });
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=1$${b64(salt)}$${b64(hash)}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("seed: DATABASE_URL is not set");
    process.exit(1);
  }
  // F-43: demo data never goes into production or any remote database.
  if (process.env.NODE_ENV === "production") {
    console.error("seed: refused, NODE_ENV is production");
    process.exit(1);
  }
  try {
    assertLocalDatabaseUrl("DATABASE_URL", url);
  } catch (e) {
    console.error(`seed: refused, ${e instanceof DatabaseUrlError ? e.message : "invalid DATABASE_URL"}`);
    process.exit(1);
  }
  // An empty value (e.g. from an unset compose interpolation) means "not set".
  const raw = process.env.SEED_USER_PASSWORD;
  const configured = raw === undefined || raw === "" ? undefined : raw;
  if (configured !== undefined && configured.length < 12) {
    console.error("seed: SEED_USER_PASSWORD must be at least 12 characters");
    process.exit(1);
  }
  const clock = manualClock(SEED_START);
  const dal = createDal({
    connectionString: url,
    clock: clock.clock,
    idGenerator: createDeterministicIdGenerator(
      Date.parse(SEED_START),
      20261113,
    ),
    applicationName: "shoestring-seed",
  });
  try {
    const result = await seedDemoData(dal, clock, () =>
      hashPassword(configured ?? randomBytes(24).toString("base64url")),
    );
    if (!result.created) {
      console.log("seed: demo data already present; nothing to do");
      return;
    }
    console.log(
      `seed: created ${String(result.users)} users, ${String(result.budgets)} budgets, ${String(result.transactions)} transactions`,
    );
    console.log(
      configured
        ? "seed: seed users sign in with SEED_USER_PASSWORD"
        : "seed: seed users have random passwords (set SEED_USER_PASSWORD before seeding to sign in as them)",
    );
  } finally {
    await dal.close();
  }
}

main().catch((e: unknown) => {
  const code =
    typeof e === "object" && e !== null && "code" in e
      ? String(e.code)
      : "unknown";
  console.error(`seed: failed (${code})`);
  process.exit(1);
});

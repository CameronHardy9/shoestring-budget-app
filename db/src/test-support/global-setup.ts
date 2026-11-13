// Vitest global setup: the db tests need the throwaway Postgres that
// `make test` starts and migrates (it exports these variables).
export default function setup(): void {
  const missing = [
    "DATABASE_URL",
    "MIGRATOR_DATABASE_URL",
    "DATABASE_ADMIN_URL",
  ].filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `db tests need ${missing.join(", ")}: run them with \`make test\` (it starts and migrates a throwaway Postgres).`,
    );
  }
}

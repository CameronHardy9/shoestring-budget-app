// Database URL safety checks shared by the migrate and seed CLIs and the
// test-only helpers (F-42). Error messages name the variable, never the URL.
//
// The host is taken from the pg driver's own connection-string parser (the
// code that would actually connect), not from `new URL().hostname`: a query
// parameter such as `?host=prod.example.net` overrides the authority for the
// driver. URLs with `host` or `hostaddr` parameters are refused outright, and
// the driver's host must agree with the URL's authority.
import pg from "pg";

/** localhost, loopback, or the compose service name. */
export const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
]);

export class DatabaseUrlError extends Error {
  override readonly name = "DatabaseUrlError";
}

export interface ParsedDatabaseUrl {
  /** Host as the driver will use it. */
  host: string;
  user: string;
  local: boolean;
  /** `sslmode` query parameter, or null. */
  sslmode: string | null;
}

const OVERRIDE_PARAMS = new Set(["host", "hostaddr"]);

export function parseDatabaseUrl(name: string, url: string): ParsedDatabaseUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DatabaseUrlError(`${name} is not a valid URL`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new DatabaseUrlError(`${name} must be a postgres:// URL`);
  }
  for (const key of u.searchParams.keys()) {
    if (OVERRIDE_PARAMS.has(key.toLowerCase())) {
      throw new DatabaseUrlError(
        `${name} must not set the host through a query parameter (host/hostaddr)`,
      );
    }
  }
  // Constructing a Client parses the string with the driver's parser; it does
  // not connect.
  const client = new pg.Client({ connectionString: url });
  const host = client.host;
  const authority = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host || host !== decodeURIComponent(authority)) {
    throw new DatabaseUrlError(`${name} has an ambiguous host`);
  }
  return {
    host,
    user: client.user ?? "",
    local: LOCAL_DB_HOSTS.has(host),
    sslmode: u.searchParams.get("sslmode"),
  };
}

/** For local/test-only tools: refuses anything but a local or compose database. */
export function assertLocalDatabaseUrl(
  name: string,
  url: string,
): ParsedDatabaseUrl {
  const parsed = parseDatabaseUrl(name, url);
  if (!parsed.local) {
    throw new DatabaseUrlError(
      `${name} must point at a local or compose database`,
    );
  }
  return parsed;
}

/** A remote database must be reached with sslmode=verify-full (F-28). */
export function assertSecureDatabaseUrl(
  name: string,
  url: string,
): ParsedDatabaseUrl {
  const parsed = parseDatabaseUrl(name, url);
  if (!parsed.local && parsed.sslmode !== "verify-full") {
    throw new DatabaseUrlError(
      `${name} must use sslmode=verify-full for a non-local database`,
    );
  }
  return parsed;
}

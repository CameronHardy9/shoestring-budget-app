// Environment configuration (ARCHITECTURE "Config", test-hooks.md §3).
// Validated with zod at startup; fails closed. Error messages name variables,
// never their values (values can be secrets).
import { DatabaseUrlError, assertSecureDatabaseUrl } from "@shoestring/db";
import { z } from "zod";
import { parseKeyring } from "./crypto/keyring.ts";
import type { Keyring } from "./crypto/keyring.ts";

export type NodeEnv = "development" | "test" | "production";
export type EmailTransportKind = "console" | "test" | "provider";

export interface Config {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  /** Exact browser origin, e.g. https://shoestring.example.com (no trailing slash). */
  appOrigin: string;
  /** Host (with port when not default) of APP_ORIGIN: the only accepted Host header. */
  appHost: string;
  staticDir: string | null;
  databaseUrl: string;
  cookieSecure: boolean;
  keyring: Keyring;
  email: {
    transport: EmailTransportKind;
    apiKey: string | null;
    from: string | null;
    dailyQuota: number;
  };
  hibpEnabled: boolean;
  sentryDsn: string | null;
  release: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  testHooks: boolean;
  /** Fastify trustProxy hop count (F-08). Never `true`. */
  trustProxyHops: number;
  /** WebAuthn relying party: ID = host of APP_ORIGIN (auth.md §6), origin = APP_ORIGIN. */
  webauthn: { rpId: string; rpName: string };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const bool = (name: string) =>
  z
    .enum(["true", "false", "1", "0"], {
      error: `${name} must be true or false`,
    })
    .transform((v) => v === "true" || v === "1");

/**
 * F-28/F-42: the driver-parsed host, no `host`/`hostaddr` query parameters,
 * and sslmode=verify-full for any non-local database (the shared @shoestring/db
 * check). Messages name the variable, never the URL.
 */
export function checkDatabaseUrl(url: string): void {
  try {
    assertSecureDatabaseUrl("DATABASE_URL", url);
  } catch (e) {
    if (e instanceof DatabaseUrlError) throw new ConfigError(e.message);
    throw new ConfigError("DATABASE_URL is invalid");
  }
}

function parseOrigin(raw: string, production: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("APP_ORIGIN is not a valid URL");
  }
  if (u.origin !== raw.replace(/\/$/, "") || u.origin === "null")
    throw new ConfigError("APP_ORIGIN must be an origin (scheme, host, port)");
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new ConfigError("APP_ORIGIN must be http or https");
  if (production && u.protocol !== "https:")
    throw new ConfigError("APP_ORIGIN must be https in production");
  return u;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"], {
    error: "NODE_ENV is required: development, test or production",
  }),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string({ error: "APP_ORIGIN is required" }).min(1),
  STATIC_DIR: z.string().optional(),
  DATABASE_URL: z.string({ error: "DATABASE_URL is required" }).min(1),
  COOKIE_SECURE: bool("COOKIE_SECURE").optional(),
  APP_KEYRING: z.string({ error: "APP_KEYRING is required" }).min(1),
  EMAIL_TRANSPORT: z
    .enum(["console", "test", "provider"], {
      error: "EMAIL_TRANSPORT must be console, test or provider",
    })
    .optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_DAILY_QUOTA: z.coerce.number().int().min(1).max(1_000_000).optional(),
  HIBP_ENABLED: bool("HIBP_ENABLED").optional(),
  SENTRY_DSN: z.string().optional(),
  APP_RELEASE: z.string().min(1).max(64).default("dev"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  TEST_HOOKS: z.enum(["0", "1"]).default("0"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  WEBAUTHN_RP_ID: z.string().optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).max(64).optional(),
});

const empty = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === "" ? undefined : v;

/** Parses and cross-checks the environment. Throws ConfigError (values never echoed). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.keys(envSchema.shape).map((k) => [k, empty(env[k])]),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?"))),
    ];
    const first = parsed.error.issues[0];
    const hint =
      first && /^[A-Z_]+ /.test(first.message) ? ` (${first.message})` : "";
    throw new ConfigError(`invalid configuration: ${names.join(", ")}${hint}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const origin = parseOrigin(e.APP_ORIGIN, production);
  checkDatabaseUrl(e.DATABASE_URL);

  const cookieSecure = e.COOKIE_SECURE ?? true;
  if (production && !cookieSecure)
    throw new ConfigError("COOKIE_SECURE=false is refused in production");
  const testHooks = e.TEST_HOOKS === "1";
  if (production && testHooks)
    throw new ConfigError("TEST_HOOKS=1 is refused in production");

  const transport: EmailTransportKind =
    e.EMAIL_TRANSPORT ??
    (production ? "provider" : e.NODE_ENV === "test" ? "test" : "console");
  if (production && transport !== "provider")
    throw new ConfigError("EMAIL_TRANSPORT must be provider in production");
  if (transport === "provider" && (!e.EMAIL_API_KEY || !e.EMAIL_FROM))
    throw new ConfigError(
      "EMAIL_API_KEY and EMAIL_FROM are required for EMAIL_TRANSPORT=provider",
    );
  if (production && e.EMAIL_DAILY_QUOTA === undefined)
    throw new ConfigError("EMAIL_DAILY_QUOTA is required in production");

  // HIBP: on by default in production and refused off there; off by default
  // locally and in tests so they never call the network (the bundled list
  // still applies).
  const hibpEnabled = e.HIBP_ENABLED ?? production;
  if (production && !hibpEnabled)
    throw new ConfigError("HIBP_ENABLED=false is refused in production");

  if (production && e.TRUST_PROXY_HOPS === undefined)
    throw new ConfigError("TRUST_PROXY_HOPS is required in production");

  // Passkeys are bound to the RP ID; it must be APP_ORIGIN's host (ADR-0007).
  if (e.WEBAUTHN_RP_ID !== undefined && e.WEBAUTHN_RP_ID !== origin.hostname)
    throw new ConfigError("WEBAUTHN_RP_ID must equal the host of APP_ORIGIN");

  let keyring: Keyring;
  try {
    keyring = parseKeyring(e.APP_KEYRING);
  } catch {
    throw new ConfigError("APP_KEYRING is invalid");
  }

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    appOrigin: origin.origin,
    appHost: origin.host,
    staticDir: e.STATIC_DIR ?? null,
    databaseUrl: e.DATABASE_URL,
    cookieSecure,
    keyring,
    email: {
      transport,
      apiKey: e.EMAIL_API_KEY ?? null,
      from: e.EMAIL_FROM ?? null,
      dailyQuota: e.EMAIL_DAILY_QUOTA ?? 100,
    },
    hibpEnabled,
    sentryDsn: e.SENTRY_DSN ?? null,
    release: e.APP_RELEASE,
    logLevel: e.LOG_LEVEL,
    testHooks,
    trustProxyHops: e.TRUST_PROXY_HOPS ?? 0,
    webauthn: { rpId: origin.hostname, rpName: e.WEBAUTHN_RP_NAME ?? "Shoestring" },
  };
}

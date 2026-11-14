// Least config for admin commands (admin-commands.md "Common rules", F-02):
// each command validates only the variables it needs. Same fail-closed rules
// as the server for the variables it does read.
import { z } from "zod";
import { ConfigError, checkDatabaseUrl } from "../config.ts";
import { parseKeyring } from "../crypto/keyring.ts";
import type { Keyring } from "../crypto/keyring.ts";

export interface AdminNeeds {
  email?: boolean;
  keyring?: boolean;
}

export interface AdminConfig {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  appOrigin: string | null;
  email: {
    transport: "console" | "test" | "provider";
    apiKey: string | null;
    from: string | null;
    dailyQuota: number;
  } | null;
  keyring: Keyring | null;
}

const empty = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === "" ? undefined : v;

export function loadAdminConfig(
  env: NodeJS.ProcessEnv,
  needs: AdminNeeds,
): AdminConfig {
  const nodeEnv = z
    .enum(["development", "test", "production"])
    .safeParse(env.NODE_ENV);
  if (!nodeEnv.success)
    throw new ConfigError(
      "NODE_ENV is required: development, test or production",
    );
  const production = nodeEnv.data === "production";
  const databaseUrl = empty(env.DATABASE_URL);
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required");
  checkDatabaseUrl(databaseUrl);

  let appOrigin: string | null = null;
  let email: AdminConfig["email"] = null;
  if (needs.email) {
    const raw = empty(env.APP_ORIGIN);
    if (!raw) throw new ConfigError("APP_ORIGIN is required");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ConfigError("APP_ORIGIN is not a valid URL");
    }
    if (production && u.protocol !== "https:")
      throw new ConfigError("APP_ORIGIN must be https in production");
    appOrigin = u.origin;
    const transport = (empty(env.EMAIL_TRANSPORT) ??
      (production ? "provider" : "console")) as "console" | "test" | "provider";
    if (!["console", "test", "provider"].includes(transport))
      throw new ConfigError(
        "EMAIL_TRANSPORT must be console, test or provider",
      );
    if (production && transport !== "provider")
      throw new ConfigError("EMAIL_TRANSPORT must be provider in production");
    const apiKey = empty(env.EMAIL_API_KEY) ?? null;
    const from = empty(env.EMAIL_FROM) ?? null;
    if (transport === "provider" && (!apiKey || !from))
      throw new ConfigError(
        "EMAIL_API_KEY and EMAIL_FROM are required for EMAIL_TRANSPORT=provider",
      );
    const quotaRaw = empty(env.EMAIL_DAILY_QUOTA);
    if (production && !quotaRaw)
      throw new ConfigError("EMAIL_DAILY_QUOTA is required in production");
    const quota = quotaRaw ? Number(quotaRaw) : 100;
    if (!Number.isInteger(quota) || quota < 1)
      throw new ConfigError("EMAIL_DAILY_QUOTA is invalid");
    email = { transport, apiKey, from, dailyQuota: quota };
  }

  let keyring: Keyring | null = null;
  if (needs.keyring) {
    const raw = empty(env.APP_KEYRING);
    if (!raw) throw new ConfigError("APP_KEYRING is required");
    try {
      keyring = parseKeyring(raw);
    } catch {
      throw new ConfigError("APP_KEYRING is invalid");
    }
  }
  return { nodeEnv: nodeEnv.data, databaseUrl, appOrigin, email, keyring };
}

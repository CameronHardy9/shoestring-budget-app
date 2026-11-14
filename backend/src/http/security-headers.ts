// Security headers on every response (ARCHITECTURE "Security headers", F-23).
import type { Config } from "../config.ts";

interface SentryEndpoints {
  ingestOrigin: string;
  reportUrl: string;
}

/** Derives the exact ingest host and CSP report URL from SENTRY_DSN, if set. */
export function sentryEndpoints(dsn: string | null): SentryEndpoints | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+/, "");
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(project))
      return null;
    return {
      ingestOrigin: u.origin,
      reportUrl: `${u.origin}/api/${project}/security/?sentry_key=${u.username}`,
    };
  } catch {
    return null;
  }
}

const cache = new WeakMap<Config, [string, string][]>();

export function securityHeaders(config: Config): [string, string][] {
  const hit = cache.get(config);
  if (hit) return hit;
  const sentry = sentryEndpoints(config.sentryDsn);
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${sentry ? ` ${sentry.ingestOrigin}` : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(sentry ? ["report-to csp"] : []),
  ].join("; ");
  const headers: [string, string][] = [
    ["strict-transport-security", "max-age=31536000; includeSubDomains"],
    ["content-security-policy", csp],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "no-referrer"],
    ["cross-origin-opener-policy", "same-origin"],
    ["cross-origin-resource-policy", "same-origin"],
    ["x-frame-options", "DENY"],
    ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ];
  if (sentry)
    headers.push(["reporting-endpoints", `csp="${sentry.reportUrl}"`]);
  cache.set(config, headers);
  return headers;
}

// Owner admin CLI (admin-commands.md); entry point src/admin.ts, built to
// dist/admin.js and run only as Cloud Run jobs. Output: JSON lines with a
// generated requestId, the command, an outcome and counts or opaque IDs.
// Never emails, tokens or links (F-02). Each command loads only the config it
// needs. Destructive commands are two-step: a dry run without --yes, then
// --yes --expect-user-id <id>. Exit codes: 0 ok, 1 unexpected, 2 usage,
// 3 not found / not eligible, 4 refused by a safety rule.
import type { Dal } from "@shoestring/db";
import {
  createDal,
  createUuidV7Generator,
  isDalError,
  systemClock,
} from "@shoestring/db";
import { createAppClock } from "../clock.ts";
import { ConfigError } from "../config.ts";
import { randomToken, sha256 } from "../crypto/keyring.ts";
import { decryptTotpSecret, encryptTotpSecret } from "../auth/totp.ts";
import { Mailer } from "../email/mailer.ts";
import { Notifications } from "../email/notifications.ts";
import {
  ConsoleTransport,
  Outbox,
  ResendTransport,
} from "../email/transports.ts";
import type { EmailTransport } from "../email/transports.ts";
import { Throttles } from "../http/rate-limit.ts";
import { createLogger } from "../logging.ts";
import type { AdminConfig, AdminNeeds } from "./config.ts";
import { loadAdminConfig } from "./config.ts";

export const COMMANDS = [
  "create-signup-invite",
  "reset-mfa",
  "revoke-sessions",
  "security-events",
  "rewrap-mfa",
  "purge",
] as const;
export type AdminCommand = (typeof COMMANDS)[number];

export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  notFound: 3,
  refused: 4,
} as const;

export interface ParsedArgs {
  command: AdminCommand;
  flags: Map<string, string | true>;
}

const KNOWN_FLAGS: Record<AdminCommand, readonly string[]> = {
  "create-signup-invite": ["email"],
  "reset-mfa": ["email", "yes", "expect-user-id"],
  "revoke-sessions": ["email", "yes", "expect-user-id", "all", "restore"],
  "security-events": ["user-id", "since"],
  "rewrap-mfa": ["dry-run", "yes", "retire-recovery-codes"],
  purge: ["dry-run", "yes"],
};

/** Parses `<command> --flag value --switch`. */
export function parseArgs(
  argv: readonly string[],
): ParsedArgs | { usageError: string } {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command))
    return { usageError: "unknown command" };
  const cmd = command as AdminCommand;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) return { usageError: "unexpected argument" };
    const eq = arg.indexOf("=");
    let name: string;
    if (eq > 0) {
      name = arg.slice(2, eq);
      flags.set(name, arg.slice(eq + 1));
    } else {
      name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else flags.set(name, true);
    }
    if (!KNOWN_FLAGS[cmd].includes(name)) return { usageError: "unknown flag" };
  }
  // gcloud joins --args with commas, so an email with a comma is ambiguous (F-02 note).
  const email = flags.get("email");
  if (email !== undefined && (email === true || email.includes(",")))
    return { usageError: "invalid --email" };
  return { command: cmd, flags };
}

export interface AdminIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  createDal?: (config: AdminConfig) => Dal;
  transport?: EmailTransport;
}

class Exit extends Error {
  readonly code: number;
  readonly fields: Record<string, unknown>;
  constructor(code: number, fields: Record<string, unknown>) {
    super("exit");
    this.code = code;
    this.fields = fields;
  }
}

const usage = (reason: string) =>
  new Exit(EXIT.usage, { outcome: "usage_error", reason });

function str(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

const NEEDS: Record<
  AdminCommand,
  (f: Map<string, string | true>) => AdminNeeds
> = {
  "create-signup-invite": () => ({ email: true }),
  "reset-mfa": () => ({ email: true }),
  "revoke-sessions": () => ({}),
  "security-events": () => ({}),
  "rewrap-mfa": (f) => ({
    keyring: true,
    email: f.has("retire-recovery-codes"),
  }),
  purge: () => ({}),
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export async function run(
  argv: readonly string[],
  io: AdminIo,
): Promise<number> {
  const requestId = createUuidV7Generator()();
  const emit = (fields: Record<string, unknown>, level = "info") => {
    io.out(
      `${JSON.stringify({ time: new Date().toISOString(), level, service: "shoestring-admin", requestId, ...fields })}\n`,
    );
  };
  const parsed = parseArgs(argv);
  if ("usageError" in parsed) {
    emit({ outcome: "usage_error", reason: parsed.usageError }, "error");
    return EXIT.usage;
  }
  const { command, flags } = parsed;
  let dal: Dal | null = null;
  try {
    const config = loadAdminConfig(io.env, NEEDS[command](flags));
    dal = io.createDal
      ? io.createDal(config)
      : createDal({
          connectionString: config.databaseUrl,
          clock: systemClock,
          applicationName: "shoestring-admin",
        });
    const fields = await COMMAND_IMPL[command]({ dal, config, flags, io });
    emit({ command, outcome: "ok", ...fields });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof Exit) {
      emit({ command, ...e.fields }, e.code === EXIT.ok ? "info" : "error");
      return e.code;
    }
    if (e instanceof ConfigError) {
      emit({ command, outcome: "config_error", reason: e.message }, "error");
      return EXIT.usage;
    }
    emit(
      {
        command,
        outcome: "error",
        error: isDalError(e) ? e.code : "unexpected",
      },
      "error",
    );
    return EXIT.unexpected;
  } finally {
    await dal?.close();
  }
}

/** For tests and the entry point: run with process I/O. */
export function main(argv: readonly string[]): Promise<number> {
  return run(argv, { env: process.env, out: (l) => process.stdout.write(l) });
}

interface Ctx {
  dal: Dal;
  config: AdminConfig;
  flags: Map<string, string | true>;
  io: AdminIo;
}

function mailer(ctx: Ctx): { mailer: Mailer; notifications: Notifications } {
  const e = ctx.config.email;
  const origin = ctx.config.appOrigin;
  if (!e || !origin) throw new Error("email not configured");
  const clock = createAppClock();
  const transport =
    ctx.io.transport ??
    (e.transport === "provider"
      ? new ResendTransport(e.apiKey ?? "", e.from ?? "")
      : e.transport === "test"
        ? new Outbox(() => clock.now())
        : new ConsoleTransport());
  const logger = createLogger({ logLevel: "warn", release: "admin" });
  const throttles = new Throttles(ctx.dal, ctx.config.keyring, clock);
  return {
    mailer: new Mailer({
      transport,
      throttles,
      clock,
      logger,
      dailyQuota: e.dailyQuota,
    }),
    notifications: new Notifications(origin),
  };
}

function requireEmail(flags: Map<string, string | true>): string {
  const email = str(flags, "email")?.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email))
    throw usage("--email is required");
  return email;
}

async function userIdFor(ctx: Ctx, email: string): Promise<string> {
  const id = await ctx.dal.users.findUserIdByEmail(email);
  if (!id) throw new Exit(EXIT.notFound, { outcome: "not_found" });
  return id;
}

/** Two-step confirmation: without --yes a dry run; with --yes the ID must match. */
function confirmed(flags: Map<string, string | true>, userId: string): boolean {
  if (flags.get("yes") !== true) return false;
  if (str(flags, "expect-user-id") !== userId)
    throw new Exit(EXIT.refused, {
      outcome: "refused",
      reason: "expect-user-id mismatch",
      userId,
    });
  return true;
}

type Impl = (ctx: Ctx) => Promise<Record<string, unknown>>;

const COMMAND_IMPL: Record<AdminCommand, Impl> = {
  async "create-signup-invite"(ctx) {
    const email = requireEmail(ctx.flags);
    const token = randomToken();
    let invite: { inviteId: string; expiresAt: Date };
    try {
      invite = await ctx.dal.signup.createSignupInvite(email, sha256(token));
    } catch (e) {
      if (isDalError(e) && e.code === "ALREADY_EXISTS")
        throw new Exit(EXIT.refused, {
          outcome: "refused",
          reason: "account exists",
        });
      throw e;
    }
    await ctx.dal.securityEvents.recordSecurityEvent({
      type: "admin_signup_invite_created",
      userId: null,
    });
    const m = mailer(ctx);
    const sent = await m.mailer.send(
      m.notifications.signupInvite(email, token, invite.expiresAt),
    );
    if (sent !== "sent")
      throw new Exit(EXIT.unexpected, {
        outcome: "email_failed",
        inviteId: invite.inviteId,
        emailOutcome: sent,
      });
    return {
      inviteId: invite.inviteId,
      expiresAt: invite.expiresAt.toISOString(),
    };
  },

  async "reset-mfa"(ctx) {
    const email = requireEmail(ctx.flags);
    const userId = await userIdFor(ctx, email);
    const go = confirmed(ctx.flags, userId);
    try {
      const r = await ctx.dal.mfa.resetMfa(userId, { dryRun: !go });
      if (!go)
        return {
          dryRun: true,
          userId,
          wouldDelete:
            "all MFA factors, recovery codes, open tokens; revoke all sessions",
        };
      const m = mailer(ctx);
      const sent = await m.mailer.send(m.notifications.mfaReset(email));
      return { userId, revokedSessions: r.revokedSessions, notice: sent };
    } catch (e) {
      if (isDalError(e) && e.code === "MFA_NOT_ENABLED")
        throw new Exit(EXIT.refused, {
          outcome: "refused",
          reason: "user has no MFA",
          userId,
        });
      throw e;
    }
  },

  async "revoke-sessions"(ctx) {
    const { flags, dal } = ctx;
    const all = flags.get("all") === true;
    if (flags.has("restore") && !all)
      throw new Exit(EXIT.refused, {
        outcome: "refused",
        reason: "--restore requires --all",
      });
    if (all) {
      if (flags.has("email")) throw usage("--all and --email are exclusive");
      if (flags.get("yes") !== true) throw usage("--all requires --yes");
      const restore = flags.get("restore") === true;
      const r = await dal.sessions.revokeAllSessions({ restore });
      await dal.securityEvents.recordSecurityEvent({
        type: "admin_sessions_revoked",
        userId: null,
      });
      return { scope: "all", restore, sessions: r.sessions, tokens: r.tokens };
    }
    const userId = await userIdFor(ctx, requireEmail(flags));
    const go = confirmed(flags, userId);
    const r = await dal.sessions.revokeAllSessionsForUser(userId, {
      dryRun: !go,
    });
    if (go)
      await dal.securityEvents.recordSecurityEvent({
        type: "admin_sessions_revoked",
        userId,
      });
    return {
      ...(go ? {} : { dryRun: true }),
      userId,
      sessions: r.sessions,
      tokens: r.tokens,
    };
  },

  async "security-events"(ctx) {
    const userId = str(ctx.flags, "user-id");
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId))
      throw usage("--user-id is required");
    const sinceRaw = str(ctx.flags, "since");
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    if (since && Number.isNaN(since.getTime())) throw usage("invalid --since");
    try {
      await ctx.dal.users.getUserContact(userId);
    } catch (e) {
      if (isDalError(e) && e.code === "NOT_FOUND")
        throw new Exit(EXIT.notFound, { outcome: "not_found" });
      throw e;
    }
    const rows = await ctx.dal.securityEvents.listSecurityEventsForUser(
      userId,
      since ? { since } : {},
    );
    // One line per event (IPs are accepted in this output, R-6); never emails.
    for (const r of rows)
      ctx.io.out(
        `${JSON.stringify({
          created_at: r.createdAt.toISOString(),
          type: r.type,
          session_id: r.sessionId,
          budget_id: r.budgetId,
          device_browser: r.deviceBrowser,
          device_os: r.deviceOs,
          ip: r.ip,
        })}\n`,
      );
    return { userId, events: rows.length };
  },

  async "rewrap-mfa"(ctx) {
    const { flags, dal } = ctx;
    const keyring = ctx.config.keyring;
    if (!keyring) throw new Error("keyring not loaded");
    const retire = flags.get("retire-recovery-codes");
    if (retire !== undefined) {
      if (
        retire === true ||
        !/^k[0-9]{1,4}$/.test(retire) ||
        retire === keyring.currentKeyId
      )
        throw new Exit(EXIT.refused, {
          outcome: "refused",
          reason: "invalid or current key id",
        });
      const go = flags.get("yes") === true;
      const r = await dal.mfa.retireRecoveryCodes(retire, { dryRun: !go });
      let notices = 0;
      if (go && r.affectedUserIds.length > 0) {
        const m = mailer(ctx);
        for (const id of r.affectedUserIds) {
          const c = await dal.users.getUserContact(id);
          if (
            (await m.mailer.send(
              m.notifications.recoveryCodesRetired(c.email),
            )) === "sent"
          )
            notices++;
        }
      }
      return {
        ...(go ? {} : { dryRun: true }),
        keyId: retire,
        users: r.affectedUserIds.length,
        codes: r.codes,
        ...(go ? { notices } : {}),
      };
    }
    const dry = flags.get("dry-run") === true;
    if (dry === (flags.get("yes") === true))
      throw usage("use exactly one of --dry-run or --yes");
    if (dry)
      return {
        dryRun: true,
        current: keyring.currentKeyId,
        keys: await dal.mfa.countMfaRowsByKeyId(),
      };
    let rewrapped = 0;
    let failed = 0;
    for (;;) {
      const batch = await dal.mfa.listTotpSecretsToRewrap(
        keyring.currentKeyId,
        100,
      );
      const todo = batch.filter((r) => keyring.keyIds.includes(r.keyId));
      failed += batch.length - todo.length;
      if (todo.length === 0) break;
      for (const row of todo) {
        const secret = decryptTotpSecret(
          keyring,
          row.keyId,
          row.userId,
          row.ciphertext,
        );
        const next = encryptTotpSecret(keyring, row.userId, secret);
        if (
          await dal.mfa.rewrapTotpSecret(row.userId, {
            fromKeyId: row.keyId,
            toKeyId: next.keyId,
            ciphertext: next.ciphertext,
          })
        )
          rewrapped++;
      }
      if (todo.length < 100) break;
    }
    const remaining = (await dal.mfa.countMfaRowsByKeyId()).filter(
      (k) => k.keyId !== keyring.currentKeyId,
    );
    if (failed > 0)
      throw new Exit(EXIT.unexpected, {
        outcome: "missing_keys",
        rewrapped,
        rowsOnUnknownKeys: failed,
      });
    return {
      rewrapped,
      recoveryCodesOnOldKeys: remaining.reduce(
        (a, k) => a + k.recoveryCodes,
        0,
      ),
    };
  },

  async purge(ctx) {
    const dry = ctx.flags.get("dry-run") === true;
    if (!dry && ctx.flags.get("yes") !== true)
      throw usage("purge requires --yes (or --dry-run)");
    const r = await ctx.dal.purge.runPurge({ dryRun: dry });
    const { failed, ...counts } = r;
    if (failed)
      throw new Exit(EXIT.unexpected, {
        outcome: "users_skipped",
        dryRun: dry,
        ...counts,
      });
    return { dryRun: dry, ...counts };
  },
};

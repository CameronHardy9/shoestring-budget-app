// Sends mail inside the request with a 700 ms provider timeout and no retry
// (auth.md §14 F-22, deviation 1), under the app-wide daily budget (F-09):
// past 60% of EMAIL_DAILY_QUOTA only priority mail goes out; at 100% nothing.
// Never throws: a failed or dropped send is logged with counts only.
import type { AppClock } from "../clock.ts";
import { sha256 } from "../crypto/keyring.ts";
import type { Logger } from "../logging.ts";
import type { Throttles } from "../http/rate-limit.ts";
import { DAY } from "../http/rate-limit.ts";
import { EmailSendError } from "./transports.ts";
import type { EmailTransport, OutgoingEmail } from "./transports.ts";

export type SendOutcome = "sent" | "dropped" | "failed";

export interface MailerOptions {
  transport: EmailTransport;
  throttles: Throttles;
  clock: AppClock;
  logger: Logger;
  dailyQuota: number;
  timeoutMs?: number;
}

export class Mailer {
  private warnedDay: number | null = null;
  private readonly o: MailerOptions;
  constructor(
    o: MailerOptions,
  ) {
    this.o = o;
  }

  get transportName(): string {
    return this.o.transport.name;
  }

  /**
   * Reserve-first: a send is counted with the atomic upsert before it goes
   * out, and the returned position is what the limits are checked against, so
   * concurrent sends cannot all pass a stale read. A cheap read comes first so
   * that, once a limit is reached, dropped mail costs no write and in-flight
   * bulk reservations rarely crowd out priority mail. A dropped send refunds
   * its slot; a send the provider fails keeps it (the quota errs safe).
   */
  async send(message: OutgoingEmail): Promise<SendOutcome> {
    // App-wide counter: the key is a constant with no PII, so it needs no
    // keyring HMAC (the admin job sends mail without mounting APP_KEYRING).
    const key = { scope: "email:daily", keyHash: sha256("email:daily\0app") };
    const quota = this.o.dailyQuota;
    const softLimit = Math.floor(quota * 0.6);
    // Over the limit for this message once `used` sends are already counted.
    const over = (used: number) =>
      used >= quota || (!message.priority && used >= softLimit);
    try {
      const used = await this.o.throttles.count(key, DAY);
      if (used >= softLimit) this.warnOnce();
      if (over(used)) return this.dropped(message);
      const slot = await this.o.throttles.reserve(key, DAY);
      if (over(slot.count - 1)) {
        await this.o.throttles.release(slot);
        return this.dropped(message);
      }
    } catch {
      this.o.logger.error(
        { email: undefined, kind: message.kind, outcome: "failed" },
        "email budget unavailable",
      );
      return "failed";
    }
    try {
      await this.o.transport.send(
        message,
        AbortSignal.timeout(this.o.timeoutMs ?? 700),
      );
      return "sent";
    } catch (e) {
      const status = e instanceof EmailSendError ? e.status : null;
      this.o.logger.warn(
        { kind: message.kind, outcome: "failed", providerStatus: status },
        "email send failed",
      );
      return "failed";
    }
  }

  /** Sends several messages concurrently (e.g. a notice to every member). */
  async sendAll(messages: OutgoingEmail[]): Promise<SendOutcome[]> {
    return Promise.all(messages.map((m) => this.send(m)));
  }

  private dropped(message: OutgoingEmail): SendOutcome {
    this.o.logger.warn(
      { kind: message.kind, outcome: "dropped" },
      "email dropped by the daily budget",
    );
    return "dropped";
  }

  private warnOnce(): void {
    const day = Math.floor(this.o.clock.now().getTime() / DAY);
    if (this.warnedDay === day) return;
    this.warnedDay = day;
    // Warning level: Sentry alerts the owner (F-09).
    this.o.logger.warn(
      { alert: "email_budget_60pct" },
      "email budget: 60% of the daily quota used",
    );
  }
}

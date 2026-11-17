// Sends mail inside the request with a 700 ms provider timeout and no retry
// (auth.md §14 F-22, deviation 1), under the app-wide daily budget (F-09):
// past 60% of EMAIL_DAILY_QUOTA only priority mail goes out; at 100% nothing.
// Never throws: a failed or dropped send is logged with counts only.
// A6 (observability/README.md): a Sentry `warning` at that 60% cutoff (F-60:
// from there on password resets and invitations are dropped) and an `error` at
// 100% of the quota, once per UTC day each (one-shot reservations).
import type { AppClock } from "../clock.ts";
import { sha256 } from "../crypto/keyring.ts";
import type { Logger } from "../logging.ts";
import type { Throttles } from "../http/rate-limit.ts";
import { DAY } from "../http/rate-limit.ts";
import { ALERTS } from "../observability/error-tracker.ts";
import type { Alert, ErrorTracker } from "../observability/error-tracker.ts";
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
  /** A6 quota alerts (Sentry). Absent or disabled: no alert and no one-shot slot spent. */
  alerts?: Pick<ErrorTracker, "enabled" | "alert">;
}

/** Sends counted today from which only priority mail goes out (auth.md §14). */
export function bulkCutoff(quota: number): number {
  return Math.floor(quota * 0.6);
}

/**
 * Constant, PII-free keys like email:daily (no keyring HMAC needed). The
 * warning line is exactly the bulk cutoff (F-60): bulk mail can raise the
 * count to the cutoff but never past it, so any higher line would never fire
 * on a bulk flood, the case where resets silently stop.
 */
const QUOTA_ALERTS: readonly {
  scope: string;
  line: (quota: number) => number;
  alert: Alert;
}[] = [
  {
    scope: "email:quota_warning",
    line: bulkCutoff,
    alert: ALERTS.emailQuotaWarning,
  },
  { scope: "email:quota_error", line: (q) => q, alert: ALERTS.emailQuotaReached },
];

export class Mailer {
  private warnedDay: number | null = null;
  private readonly o: MailerOptions;
  constructor(o: MailerOptions) {
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
    const softLimit = bulkCutoff(quota);
    // Over the limit for this message once `used` sends are already counted.
    const over = (used: number) =>
      used >= quota || (!message.priority && used >= softLimit);
    let sentToday: number;
    try {
      const used = await this.o.throttles.count(key, DAY);
      if (used >= softLimit) this.warnOnce();
      if (over(used)) return this.dropped(message);
      const slot = await this.o.throttles.reserve(key, DAY);
      if (over(slot.count - 1)) {
        await this.o.throttles.release(slot);
        return this.dropped(message);
      }
      sentToday = slot.count;
    } catch {
      this.o.logger.error(
        { email: undefined, kind: message.kind, outcome: "failed" },
        "email budget unavailable",
      );
      return "failed";
    }
    let outcome: SendOutcome;
    try {
      await this.o.transport.send(
        message,
        AbortSignal.timeout(this.o.timeoutMs ?? 700),
      );
      outcome = "sent";
    } catch (e) {
      const status = e instanceof EmailSendError ? e.status : null;
      this.o.logger.warn(
        { kind: message.kind, outcome: "failed", providerStatus: status },
        "email send failed",
      );
      outcome = "failed";
    }
    // A failed send keeps its slot, so it counts toward the thresholds too.
    await this.quotaAlerts(sentToday);
    return outcome;
  }

  /**
   * A6: once the day's kept sends reach the 60% cutoff (and 100%), the
   * first send to see it wins a one-shot reservation and raises the alert.
   * `>=` plus the reservation means concurrent sends can neither skip the
   * threshold nor raise it twice.
   */
  private async quotaAlerts(sentToday: number): Promise<void> {
    const alerts = this.o.alerts;
    if (!alerts?.enabled) return;
    for (const q of QUOTA_ALERTS) {
      if (sentToday < q.line(this.o.dailyQuota)) continue;
      try {
        const key = { scope: q.scope, keyHash: sha256(`${q.scope}\0app`) };
        const once = await this.o.throttles.reserve(key, DAY);
        if (once.count === 1) alerts.alert(q.alert);
      } catch {
        this.o.logger.warn({ alert: q.scope }, "email quota alert unavailable");
      }
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
    // Once per day per instance: 60% is the bulk cutoff (auth.md §14), from
    // here only priority mail goes out. The A6 Sentry warning fires at this
    // same point (F-60), once per UTC day across instances, through the
    // one-shot reservation in quotaAlerts; the error follows at 100%.
    this.o.logger.warn(
      { alert: "email_budget_60pct" },
      "email budget: 60% of the daily quota used",
    );
  }
}

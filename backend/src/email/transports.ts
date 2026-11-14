// Email transports (ARCHITECTURE "Email"): console (local dev), test (captured
// outbox read by the dev-only hooks) and provider (Resend HTTP API, no SDK).
// Transports never log message bodies, recipients or links.

/** Notification kinds (auth.md §15). Values are this backend's vocabulary. */
export type EmailKind =
  | "signup_invite"
  | "new_sign_in"
  | "login_throttled"
  | "budget_invitation"
  | "invitation_accepted"
  | "budget_deleted"
  | "budget_restored"
  | "member_removed"
  | "ownership_transferred"
  | "mfa_failures"
  | "mfa_locked"
  | "password_reset"
  | "password_changed"
  | "email_change_confirm"
  | "email_change_notice"
  | "email_change_exists"
  | "email_changed"
  | "email_change_cancelled"
  | "mfa_factor_added"
  | "mfa_factor_removed"
  | "recovery_code_used"
  | "recovery_codes_regenerated"
  | "recovery_codes_retired"
  | "mfa_reset"
  | "account_deletion_scheduled"
  | "account_deletion_cancelled";

export interface OutgoingEmail {
  /** PII */
  to: string;
  subject: string;
  /** Plain text only. May contain one-time links (Secret until expiry). */
  text: string;
  kind: EmailKind;
  /** Priority mail is still sent past 60% of the daily quota (auth.md §14). */
  priority: boolean;
  /** Every link in `text`, all built from APP_ORIGIN. */
  links: string[];
}

export interface EmailTransport {
  readonly name: "console" | "test" | "provider";
  send(message: OutgoingEmail, signal: AbortSignal): Promise<void>;
}

export interface CapturedEmail {
  to: string;
  subject: string;
  kind: EmailKind;
  priority: boolean;
  links: string[];
  sentAt: string;
}

/** In-memory outbox (test transport). Bounded so a long e2e run cannot grow it without limit. */
export class Outbox implements EmailTransport {
  readonly name = "test";
  private items: CapturedEmail[] = [];
  private readonly now: () => Date;
  private readonly max: number;
  constructor(now: () => Date, max = 1_000) {
    this.now = now;
    this.max = max;
  }

  send(m: OutgoingEmail): Promise<void> {
    this.items.push({
      to: m.to,
      subject: m.subject,
      kind: m.kind,
      priority: m.priority,
      links: [...m.links],
      sentAt: this.now().toISOString(),
    });
    if (this.items.length > this.max)
      this.items.splice(0, this.items.length - this.max);
    return Promise.resolve();
  }

  list(to?: string): CapturedEmail[] {
    const want = to?.toLowerCase();
    return this.items.filter(
      (i) => want === undefined || i.to.toLowerCase() === want,
    );
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Local development only (config refuses it in production): prints the message
 * to stderr so a developer can follow links. Never wired to the JSON logger.
 */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";
  private readonly write: (s: string) => void;
  constructor(write: (s: string) => void = (s) => process.stderr.write(s)) {
    this.write = write;
  }

  send(m: OutgoingEmail): Promise<void> {
    this.write(
      `\n----- email (${m.kind}${m.priority ? ", priority" : ""}) -----\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n----- end email -----\n`,
    );
    return Promise.resolve();
  }
}

export class EmailSendError extends Error {
  override readonly name = "EmailSendError";
  readonly status: number | null;
  constructor(
    status: number | null,
  ) {
    super("email provider error");
    this.status = status;
  }
}

/** Resend HTTP API. Plain text; tracking is configured off at the provider. */
export class ResendTransport implements EmailTransport {
  readonly name = "provider";
  private readonly apiKey: string;
  private readonly from: string;
  private readonly doFetch: typeof fetch;
  constructor(
    apiKey: string,
    from: string,
    doFetch: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.from = from;
    this.doFetch = doFetch;
  }

  async send(m: OutgoingEmail, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await this.doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [m.to],
          subject: m.subject,
          text: m.text,
        }),
        signal,
        redirect: "error",
      });
    } catch {
      throw new EmailSendError(null);
    }
    // Drain without reading the body into logs.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new EmailSendError(res.status);
  }
}

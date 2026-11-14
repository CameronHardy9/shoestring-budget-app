// Everything the HTTP layer and services need, injected (tests pass fakes).
import type { Dal } from "@shoestring/db";
import type { PasswordService } from "./auth/passwords.ts";
import type { AppClock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { CursorCodec } from "./domain/cursor.ts";
import type { Mailer } from "./email/mailer.ts";
import type { Notifications } from "./email/notifications.ts";
import type { MemoryLimiter, Throttles } from "./http/rate-limit.ts";
import type { ResponseValidator } from "./http/response-validation.ts";
import type { Logger } from "./logging.ts";

export interface AppDeps {
  readonly config: Config;
  readonly dal: Dal;
  readonly clock: AppClock;
  readonly logger: Logger;
  readonly passwords: PasswordService;
  readonly throttles: Throttles;
  readonly limiter: MemoryLimiter;
  readonly mailer: Mailer;
  readonly notifications: Notifications;
  readonly cursors: CursorCodec;
  /** Dev/test only: checks every response against the contract (null in production). */
  readonly responseValidator: ResponseValidator | null;
  /** Wall clock (ms) for latency padding; never the app clock. */
  readonly wallNow: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

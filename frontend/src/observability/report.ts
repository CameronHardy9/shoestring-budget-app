// Error reporting facade, in the main bundle (a few hundred bytes). Sentry
// itself is a lazy chunk, loaded after the first render and only when a DSN
// was built in (VITE_SENTRY_DSN): it costs the initial bundle nothing and can
// only ever start after the link-token capture (boot script, F-50). Until it
// is up, uncaught errors wait in a small buffer; with no DSN nothing is
// buffered, loaded or sent.
import type { RouteOf } from "./scrub.ts";

export interface Mechanism {
  type: string;
  handled: boolean;
}

export interface Tracker {
  capture(error: unknown, mechanism: Mechanism): void;
}

export interface TrackerOptions {
  dsn: string;
  release: string;
  routeOf: RouteOf;
  /** The signed-in person's opaque ID at the time of an event, or null. */
  userId: () => string | null;
}

const MAX_BUFFERED = 10;
let tracker: Tracker | null = null;
let buffer: { error: unknown; mechanism: Mechanism }[] = [];
let userId: string | null = null;

/** Reports an error (buffered until error tracking is up; dropped without a DSN). */
export function reportError(
  error: unknown,
  mechanism: Mechanism = { type: "generic", handled: true },
): void {
  if (tracker) tracker.capture(error, mechanism);
  else if (buffer.length < MAX_BUFFERED) buffer.push({ error, mechanism });
}

/** The opaque user ID for events (null when signed out). */
export function setReportUser(id: string | null): void {
  userId = id;
}

/**
 * Buffers uncaught errors and unhandled rejections until Sentry's own global
 * handlers take over. Returns the function that stops it.
 */
export function bufferEarlyErrors(target: Window): () => void {
  const onError = (event: ErrorEvent) => {
    reportError(event.error ?? new Error("Script error"), {
      type: "onerror",
      handled: false,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError(event.reason, { type: "onunhandledrejection", handled: false });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * Loads and starts Sentry, then sends what was buffered. `stopBuffer` runs as
 * soon as Sentry's handlers are installed, so no error is reported twice. A
 * failed load (offline, a new deploy) leaves tracking off; the app carries on.
 */
export async function startErrorTracking(
  options: Omit<TrackerOptions, "userId"> & {
    stopBuffer?: () => void;
    load?: () => Promise<{
      createTracker: (o: TrackerOptions) => Tracker;
    }>;
  },
): Promise<boolean> {
  const { stopBuffer, load, ...rest } = options;
  try {
    const { createTracker } = await (load ?? (() => import("./sentry.ts")))();
    tracker = createTracker({ ...rest, userId: () => userId });
  } catch {
    return false;
  }
  stopBuffer?.();
  const pending = buffer;
  buffer = [];
  for (const item of pending) tracker.capture(item.error, item.mechanism);
  return true;
}

/** Tests only. */
export function resetReporting(): void {
  tracker = null;
  buffer = [];
  userId = null;
}

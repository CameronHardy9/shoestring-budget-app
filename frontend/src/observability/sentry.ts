// Sentry browser SDK (lazy chunk; see report.ts). Settings from ARCHITECTURE
// "Error tracking" (F-06, F-07): no default PII (dataCollection off), no replay, no tracing, no
// sessions; DOM and console breadcrumbs off; fetch breadcrumbs reduced to the
// path; every event rebuilt from an allowlist (scrub.ts). The ingest origin is
// the only network destination and is already in connect-src (backend
// security-headers.ts); the SDK adds no script, style or inline code.
import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  captureException,
  dedupeIntegration,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
  type BrowserOptions,
} from "@sentry/browser";
import type { Tracker, TrackerOptions } from "./report.ts";
import { scrubBreadcrumb, scrubEvent } from "./scrub.ts";

/** Builds the SDK options; exported so a test can pin every privacy setting. */
export function sentryOptions({
  dsn,
  release,
  routeOf,
  userId,
}: TrackerOptions): BrowserOptions {
  return {
    dsn,
    release,
    tracesSampleRate: 0,
    // v11's replacement for `sendDefaultPii: false` (ARCHITECTURE wording):
    // every collection category off, as in the backend's error-tracker.ts.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // Explicit list only: no session tracking, replay, feedback, tracing,
    // HTTP context (it would add the page URL), console capture or DOM
    // breadcrumbs.
    defaultIntegrations: false,
    integrations: [
      globalHandlersIntegration(),
      browserApiErrorsIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      breadcrumbsIntegration({
        dom: false,
        fetch: true,
        history: true,
        sentry: false,
        xhr: false,
      }),
    ],
    maxBreadcrumbs: 30,
    attachStacktrace: false,
    sendClientReports: false,
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, routeOf),
    beforeSend: (event, hint) =>
      scrubEvent(event, hint, {
        routeOf,
        pathname: window.location.pathname,
        userId: userId(),
        userAgent: navigator.userAgent,
        origin: window.location.origin,
      }),
  };
}

export function createTracker(options: TrackerOptions): Tracker {
  init(sentryOptions(options));
  return {
    capture: (error, mechanism) => {
      captureException(error, { mechanism });
    },
  };
}

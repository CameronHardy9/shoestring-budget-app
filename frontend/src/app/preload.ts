// Preloads the tab screens' chunks once the first page is on screen (owner
// ruling 2026-11-24). A lazy screen's first visit otherwise suspends, React
// holds its fallback for at least 300 ms, which always outlasts the page
// loader's grace, and the lace then runs a whole 3.2 s cycle. A preloaded
// screen renders on the first pass, so a first tab visit shows no loader.
//
// Idle-time only, after the page loader session has ended, so it never
// delays a reveal. Failures are swallowed: nothing is shown, and the normal
// lazy path loads (and reports) the chunk again on navigation.
import { useEffect, useRef } from "react";
import { usePageLoader } from "../components/page-loader.ts";

export interface Preloadable {
  preload: () => Promise<void>;
}

/** Without requestIdleCallback (Safari), this long after the call. */
export const IDLE_FALLBACK_MS = 200;
/** requestIdleCallback's deadline, so a busy page still gets them. */
export const IDLE_TIMEOUT_MS = 2000;

/** Runs `fn` when the browser is idle. */
export function whenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(fn, IDLE_FALLBACK_MS);
  }
}

/** Preloads `screens` at idle time; a failed one is left to the lazy path. */
export function preloadWhenIdle(screens: readonly Preloadable[]): void {
  whenIdle(() => {
    for (const screen of screens) {
      screen.preload().catch(() => undefined);
    }
  });
}

/**
 * Once, after the first page has been revealed (no page loader session
 * running) while `enabled` (signed in: the tab screens need a session).
 */
export function usePreloadAfterFirstReveal(
  enabled: boolean,
  screens: readonly Preloadable[],
): void {
  const { active } = usePageLoader();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !enabled || active) return;
    done.current = true;
    // Not cancelled on a later change: preloading is harmless at any time.
    preloadWhenIdle(screens);
  }, [enabled, active, screens]);
}

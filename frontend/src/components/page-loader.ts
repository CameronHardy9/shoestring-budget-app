// The page loader session (owner rulings 2026-11-24). Every viewport
// LoadingState registers here while it is mounted; one app-level <PageLoader>
// draws the lace for all of them, so a cold start's chain of loads (boot, the
// budgets list, a lazy route, the budget, the month) is one animation, not a
// loader per step.
//
//   idle ── a load starts ──▶ grace (nothing shown, LACE_GRACE_MS)
//   grace ── loads all done at the deadline ──▶ idle (no loader, no delay)
//   grace ── still loading ──▶ shown (lace + opaque cover; cycle 0 starts now)
//   shown ── at a cycle boundary with nothing loading ──▶ chain
//            (reduced motion: as soon as nothing is loading)
//   chain ── a load starts within LACE_CHAIN_MS ──▶ shown (same phase)
//   chain ── otherwise ──▶ idle
//   any ── an OfflineState / ErrorState mounts ──▶ idle (or "interrupted"
//          while other loads are still mounted: no loader until they finish)
//
// Ungated loads (owner rulings 2026-11-25: moving between months or category
// filters) differ in three ways, as long as no gated load joined the same session (gated wins,
// even if it has already finished):
//   grace ── nothing loading ──▶ idle at once (the next one gets a whole grace)
//   shown ── nothing loading ──▶ idle at once, mid-cycle, without a chain window
//   chain ── an ungated load starts ──▶ grace (a new session: it was caused by
//            a tap, not by the load before it)
//
// The opening (owner ruling 2026-11-25: no navigation bars until the opening
// loader ends) runs on top of the sessions, from signing in (a cold start's
// session check or the sign-in form: auth.tsx) to the first page revealed.
// Meanwhile AppShell renders no navigation at all, and the grace is covered
// too (a plain cover, no lace), so nothing of the page shows early. It ends,
// in the same commit that reveals the page, when nothing is loading and a page
// (<PageMain>) is mounted: in the grace at once, with the lace up at the
// boundary. A boundary with nothing loading but no page is the gap of a
// redirect between two loads: the cover stays for up to LACE_CHAIN_MS more
// instead of lifting. An OfflineState / ErrorState in a page ends it at once.
//
// One epoch drives both clocks: the lace's CSS animation is started that many
// ms in (a negative animation-delay, LaceLoader.tsx), and the boundaries here
// are epoch + k * LACE_CYCLE_MS on the same performance.now() clock, so they
// can't drift apart. A late timer is caught by the LACE_SEAM_MS check.
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  LACE_CHAIN_MS,
  LACE_CYCLE_MS,
  LACE_GRACE_MS,
  LACE_SEAM_MS,
} from "./lace-timing.ts";

export interface PageLoaderSnapshot {
  /** A session is running: its status region exists (grace, shown, chain). */
  readonly active: boolean;
  /** The lace and the cover are on screen, and the page under them is inert. */
  readonly shown: boolean;
  /** The page is covered and inert: `shown`, or the opening's grace (no lace). */
  readonly covered: boolean;
  /** The opening: no navigation is rendered. */
  readonly opening: boolean;
  /** performance.now() when cycle 0 started; null before the lace is shown. */
  readonly epoch: number | null;
  /** The status text, fixed when first shown so it is announced once. */
  readonly label: string | null;
}

type Phase = "idle" | "grace" | "shown" | "chain" | "interrupted";

const IDLE: PageLoaderSnapshot = {
  active: false,
  shown: false,
  covered: false,
  opening: false,
  epoch: null,
  label: null,
};

interface Load {
  readonly label: string;
}

const loads = new Set<Load>();
const listeners = new Set<() => void>();
let phase: Phase = "idle";
let epoch: number | null = null;
let label: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let settleQueued = false;
/** A gated load is, or was, part of this session (set anew when one starts). */
let gated = false;
let opening = false;
/** The opening's boundary passed in a redirect gap: covered a little longer. */
let holding = false;
/** Mounted pages (<PageMain>), interstitials excluded. */
let pages = 0;
let snapshot: PageLoaderSnapshot = IDLE;
/** Focus when the cover went up (the page goes inert and loses it). */
let focusBefore: Element | null = null;
let afterUncover: (() => void)[] = [];

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function publish(): void {
  const running = phase !== "idle" && phase !== "interrupted";
  const shown = phase === "shown";
  const next: PageLoaderSnapshot = {
    active: running,
    shown,
    covered: shown || (opening && phase === "grace"),
    opening,
    epoch: running ? epoch : null,
    label: running ? label : null,
  };
  if (
    next.active === snapshot.active &&
    next.shown === snapshot.shown &&
    next.covered === snapshot.covered &&
    next.opening === snapshot.opening &&
    next.epoch === snapshot.epoch &&
    next.label === snapshot.label
  )
    return;
  // Read before the page goes inert (and the browser takes focus away).
  if (next.covered && !snapshot.covered) focusBefore = document.activeElement;
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function end(): void {
  clearTimer();
  phase = "idle";
  epoch = null;
  label = null;
  holding = false;
  publish();
}

/** ms since cycle 0 began (the session is shown or chaining). */
function elapsed(): number {
  return performance.now() - (epoch ?? performance.now());
}

function scheduleBoundary(): void {
  clearTimer();
  const now = elapsed();
  // The next boundary clearly ahead (a timer that fired a little early has
  // already been handled as this boundary).
  const next =
    (Math.floor((now + LACE_SEAM_MS) / LACE_CYCLE_MS) + 1) * LACE_CYCLE_MS;
  timer = setTimeout(atBoundary, next - now);
}

function show(): void {
  clearTimer();
  phase = "shown";
  epoch ??= performance.now();
  label ??= [...loads].at(-1)?.label ?? null;
  publish();
  scheduleBoundary();
}

function reveal(): void {
  clearTimer();
  if (opening && pages === 0 && !holding) {
    // Between two loads of the opening (a redirect): keep it covered.
    holding = true;
    timer = setTimeout(reveal, LACE_CHAIN_MS);
    return;
  }
  holding = false;
  if (pages > 0) opening = false;
  if (!gated) {
    end();
    return;
  }
  phase = "chain";
  publish();
  timer = setTimeout(end, LACE_CHAIN_MS);
}

function atBoundary(): void {
  timer = undefined;
  if (loads.size > 0) {
    scheduleBoundary();
    return;
  }
  const into = elapsed() % LACE_CYCLE_MS;
  const atSeam = Math.min(into, LACE_CYCLE_MS - into) <= LACE_SEAM_MS;
  // Nobody sees a hidden tab, and a still frame has no cycle to finish.
  if (
    atSeam ||
    document.visibilityState === "hidden" ||
    prefersReducedMotion()
  ) {
    reveal();
  } else {
    scheduleBoundary();
  }
}

function endGrace(): void {
  timer = undefined;
  if (loads.size === 0) end();
  else show();
}

/**
 * After the commit that removed the last load or mounted a page (one loader
 * replacing another in the same commit never reaches zero here), and before
 * the browser paints it.
 */
function settle(): void {
  settleQueued = false;
  if (loads.size > 0) {
    if (phase === "interrupted" && pages > 0) opening = false;
    publish();
    return;
  }
  if (phase === "shown") {
    if (prefersReducedMotion() || !gated || (holding && pages > 0)) reveal();
    return;
  }
  if (pages > 0) opening = false;
  if (phase === "interrupted" || (phase === "grace" && !gated)) end();
  else publish();
}

function queueSettle(): void {
  if (settleQueued) return;
  settleQueued = true;
  queueMicrotask(settle);
}

/**
 * Registers a page-level load; returns its end. `gated: false` only for a
 * load the person caused on a page that was already showing (a month or
 * category filter switch).
 */
export function registerPageLoad(
  text: string,
  { gated: isGated = true }: { gated?: boolean } = {},
): () => void {
  const load: Load = { label: text };
  loads.add(load);
  if (phase === "chain" && !isGated) end();
  if (phase === "idle") {
    phase = "grace";
    gated = isGated;
    timer = setTimeout(endGrace, LACE_GRACE_MS);
    publish();
  } else if (phase !== "interrupted") {
    gated ||= isGated;
    if (phase === "chain") show();
    else if (holding) {
      // The next load of the opening came: on with the same animation.
      holding = false;
      scheduleBoundary();
    }
  }
  return () => {
    if (loads.delete(load) && loads.size === 0) queueSettle();
  };
}

/**
 * Someone has just been signed in: no navigation until their first page is
 * revealed (auth.tsx, the only caller).
 */
export function beginOpening(): void {
  opening = true;
  publish();
}

/**
 * An offline or error message took a loader's place: it shows at once,
 * mid-cycle if need be, and the session ends. Loads still mounted stay
 * unshown until they finish (a new cover would hide the message).
 */
export function interruptPageLoader(): void {
  // The message's page brings its navigation, so nobody is stranded. (A page
  // mounting in the same commit comes after this: settle() sees it.)
  if (pages > 0) opening = false;
  if (phase === "idle" || phase === "interrupted") {
    publish();
    return;
  }
  clearTimer();
  if (loads.size === 0) {
    end();
    return;
  }
  phase = "interrupted";
  epoch = null;
  label = null;
  holding = false;
  publish();
}

/** Runs `fn` once the page is no longer covered (now, if it isn't). */
export function whenPageUncovered(fn: () => void): void {
  if (snapshot.covered) afterUncover.push(fn);
  else fn();
}

/**
 * For <PageLoader> once the cover is gone: the element focused when it went
 * up, and the callbacks that waited for it.
 */
export function takeUncoverWork(): {
  focusBefore: Element | null;
  callbacks: (() => void)[];
} {
  const work = { focusBefore, callbacks: afterUncover };
  focusBefore = null;
  afterUncover = [];
  return work;
}

/** The running session's epoch, while the lace is on screen. */
export function shownEpoch(): number | null {
  return snapshot.shown ? snapshot.epoch : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PageLoaderSnapshot {
  return snapshot;
}

export function usePageLoader(): PageLoaderSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** True while the page loader covers the page: put it on `inert`. */
export function usePageCovered(): boolean {
  return usePageLoader().covered;
}

/** True during the opening: render no navigation. */
export function useOpening(): boolean {
  return usePageLoader().opening;
}

/** A page-level load for as long as the calling component is mounted. */
export function usePageLoad(text: string, isGated: boolean): void {
  useLayoutEffect(
    () => registerPageLoad(text, { gated: isGated }),
    [text, isGated],
  );
}

/**
 * A page is on screen for as long as the calling component is mounted (and not
 * hidden by Suspense, which undoes layout effects).
 */
export function usePageMounted(counts: boolean): void {
  useLayoutEffect(() => {
    if (!counts) return;
    pages += 1;
    if (opening) queueSettle();
    return () => {
      pages -= 1;
    };
  }, [counts]);
}

/** Ends the page loader session when the calling component mounts. */
export function useInterruptPageLoader(): void {
  useLayoutEffect(() => {
    interruptPageLoader();
  }, []);
}

/** Test only: forget every session (module state outlives a test). */
export function resetPageLoaderForTests(): void {
  clearTimer();
  loads.clear();
  phase = "idle";
  epoch = null;
  label = null;
  settleQueued = false;
  gated = false;
  opening = false;
  holding = false;
  focusBefore = null;
  afterUncover = [];
  snapshot = IDLE;
  for (const listener of listeners) listener();
}

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
  /** performance.now() when cycle 0 started; null before the lace is shown. */
  readonly epoch: number | null;
  /** The status text, fixed when first shown so it is announced once. */
  readonly label: string | null;
}

type Phase = "idle" | "grace" | "shown" | "chain" | "interrupted";

const IDLE: PageLoaderSnapshot = {
  active: false,
  shown: false,
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
  const next: PageLoaderSnapshot =
    phase === "idle" || phase === "interrupted"
      ? IDLE
      : { active: true, shown: phase === "shown", epoch, label };
  if (
    next.active === snapshot.active &&
    next.shown === snapshot.shown &&
    next.epoch === snapshot.epoch &&
    next.label === snapshot.label
  )
    return;
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
  focusBefore = document.activeElement;
  phase = "shown";
  epoch ??= performance.now();
  label ??= [...loads].at(-1)?.label ?? null;
  publish();
  scheduleBoundary();
}

function reveal(): void {
  clearTimer();
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
 * After the commit that removed the last load (one loader replacing another
 * in the same commit never reaches zero here).
 */
function settle(): void {
  settleQueued = false;
  if (loads.size > 0) return;
  if (phase === "interrupted") end();
  else if (phase === "shown" && prefersReducedMotion()) reveal();
}

/** Registers a page-level load; returns its end. */
export function registerPageLoad(text: string): () => void {
  const load: Load = { label: text };
  loads.add(load);
  if (phase === "idle") {
    phase = "grace";
    timer = setTimeout(endGrace, LACE_GRACE_MS);
    publish();
  } else if (phase === "chain") {
    show();
  }
  return () => {
    if (!loads.delete(load) || loads.size > 0 || settleQueued) return;
    settleQueued = true;
    queueMicrotask(settle);
  };
}

/**
 * An offline or error message took a loader's place: it shows at once,
 * mid-cycle if need be, and the session ends. Loads still mounted stay
 * unshown until they finish (a new cover would hide the message).
 */
export function interruptPageLoader(): void {
  if (phase === "idle" || phase === "interrupted") return;
  clearTimer();
  if (loads.size === 0) {
    end();
    return;
  }
  phase = "interrupted";
  epoch = null;
  label = null;
  publish();
}

/** Runs `fn` once the page is no longer covered (now, if it isn't). */
export function whenPageUncovered(fn: () => void): void {
  if (snapshot.shown) afterUncover.push(fn);
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
  return usePageLoader().shown;
}

/** A page-level load for as long as the calling component is mounted. */
export function usePageLoad(text: string): void {
  useLayoutEffect(() => registerPageLoad(text), [text]);
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
  focusBefore = null;
  afterUncover = [];
  snapshot = IDLE;
  for (const listener of listeners) listener();
}

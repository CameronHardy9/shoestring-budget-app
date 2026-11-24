// The lace loader's timing, shared by LaceLoader.tsx, the page loader session
// (page-loader.ts) and the CSS check (scripts/lace-loader-css.test.ts), which
// can't import a .tsx file.

/** One cycle of the draw / hold / fade animation; matches styles/index.css (3.2s). */
export const LACE_CYCLE_MS = 3200;

/**
 * A page load shows nothing for this long (owner ruling 2026-11-24): if
 * everything has loaded by then, no loader appears and nothing is delayed.
 */
export const LACE_GRACE_MS = 150;

/**
 * How far from a cycle boundary the page loader may still reveal the page (a
 * late timer, a busy main thread). The lace is invisible there: faded out
 * from 94% of the cycle (the CSS check holds this under the last 6%), and at
 * the start of the next cycle still off the tile's left edge.
 */
export const LACE_SEAM_MS = 100;

/**
 * A page load that starts within this long of the page loader revealing a page
 * joins the same session: shown again at once, in the same phase, with no
 * grace and no new announcement. Bridges the gap between two chained loads
 * (a redirect renders nothing for one commit).
 */
export const LACE_CHAIN_MS = 100;

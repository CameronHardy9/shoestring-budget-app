// The lace loader's timing, shared by LaceLoader.tsx and the CSS check
// (scripts/lace-loader-css.test.ts), which can't import a .tsx file.

/** One cycle of the draw / hold / fade animation; matches styles/index.css (3.2s). */
export const LACE_CYCLE_MS = 3200;

/**
 * A loader that replaces another within this long continues its animation
 * instead of restarting it.
 */
export const LACE_CONTINUE_MS = 400;

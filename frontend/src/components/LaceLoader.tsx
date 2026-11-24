// The lace loader ("Loader E", owner-approved 2026-11-24): on an ivory tile, a
// white lace with a dark edge draws itself into an S, led by its aglet tip,
// through two pairs of eyelets, over a shoe tongue whose two navy edge lines
// turn the S into a "$". Decorative only: the surrounding role="status"
// carries the meaning. Keyframes, colours (fixed --ss-lace-* tokens, the same
// in both themes) and the reduced-motion still frame live in styles/index.css.
// No style attributes (CSP): colours are classes, geometry is SVG attributes,
// and the one runtime value (the phase, below) is set through the CSSOM.
import { useLayoutEffect, useRef } from "react";
import { LACE_CONTINUE_MS, LACE_CYCLE_MS } from "./lace-timing.ts";

/** The lace, from off the left edge, through all four eyelets, off the right. */
const LACE =
  "M-4 36 C6 36 15 39 18 46 C22 55 42 55 46 46 C48.5 40.4 44 35 32 32 C20 29 15.5 23.6 18 18 C22 9 42 9 46 18 C49 25 58 28 68 28";

/** The tongue: hangs from the tile's top edge, rounded tip at the bottom. */
const TONGUE = "M27 0 L27 55 Q27 61 32 61 Q37 61 37 55 L37 0 Z";

/** The tongue's two edges, which the lace S crosses to make a "$". */
const TONGUE_LINES = "M27 7 L27 58 M37 7 L37 58";

/** Two pairs, like a shoe. */
const EYELETS: readonly (readonly [number, number])[] = [
  [18, 18],
  [46, 18],
  [18, 46],
  [46, 46],
];

/**
 * At this size and below only the tile, its border and the lace remain (the
 * lace drawn dark and thicker): no tongue, edge, eyelets or tip.
 */
export const LACE_SMALL_MAX = 24;

/** In-place loads (inside a sheet, or a section below loaded content). */
export const LACE_SIZE = 56;
/** The viewport-centred loader (every page-level load). */
export const LACE_SIZE_LARGE = 96;

// Shared phase. Every page-level loader sits in the same place (the middle of
// the viewport), and a cold start chains several (boot, budgets, the lazy
// route, the budget, the month): each new one picks up where the last one
// was, so the lace keeps drawing instead of snapping back. After a pause
// longer than LACE_CONTINUE_MS the next loader starts from the beginning.
let mounted = 0;
let epoch = 0;
let lastSeen = Number.NEGATIVE_INFINITY;

function startPhase(now: number): number {
  if (mounted === 0 && now - lastSeen > LACE_CONTINUE_MS) epoch = now;
  mounted += 1;
  return (((now - epoch) % LACE_CYCLE_MS) + LACE_CYCLE_MS) % LACE_CYCLE_MS;
}

function endPhase(now: number): void {
  mounted -= 1;
  lastSeen = now;
}

export function LaceLoader({ size = LACE_SIZE }: { size?: number }) {
  const small = size <= LACE_SMALL_MAX;
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const phase = startPhase(performance.now());
    // A negative delay starts the CSS animation `phase` ms in. CSSOM, not a
    // style attribute, so a strict style-src allows it.
    ref.current?.style.setProperty(
      "--ss-lace-delay",
      `${String(-Math.round(phase))}ms`,
    );
    return () => {
      endPhase(performance.now());
    };
  }, []);
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-testid="lace-loader"
      data-small={small ? "" : undefined}
    >
      {/* Inset half a unit so the 1 px border (non-scaling) isn't clipped. */}
      <rect
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx="14.5"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        className="ss-lace-tile"
      />
      {small ? (
        <path
          pathLength={1}
          d={LACE}
          fill="none"
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ss-lace-dark"
        />
      ) : (
        <>
          <path d={TONGUE} className="ss-lace-tongue" />
          <path
            d={TONGUE_LINES}
            fill="none"
            strokeWidth={3.2}
            strokeLinecap="round"
            className="ss-lace-tongue-line"
          />
          <path
            pathLength={1}
            d={LACE}
            fill="none"
            strokeWidth={7.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="ss-lace-dark"
          />
          <path
            pathLength={1}
            d={LACE}
            fill="none"
            strokeWidth={5.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="ss-lace-line"
          />
          <path
            pathLength={1}
            d={LACE}
            fill="none"
            strokeWidth={7}
            strokeLinecap="butt"
            className="ss-lace-tip"
          />
          {EYELETS.map(([cx, cy]) => (
            <g key={`${cx},${cy}`} data-eyelet="">
              <circle
                cx={cx}
                cy={cy}
                r={4.3}
                strokeWidth={0.8}
                className="ss-lace-eyelet"
              />
              <circle cx={cx} cy={cy} r={2.2} className="ss-lace-hole" />
            </g>
          ))}
        </>
      )}
    </svg>
  );
}

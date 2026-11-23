// The lace loader ("Loader D", owner-approved 2026-11-23): a white lace draws
// itself into an S across the brand tile, led by its aglet tip, through two
// pairs of eyelets. Decorative only: the surrounding role="status" carries the
// meaning. Keyframes, colours (fixed --ss-lace-* tokens, the same in both
// themes) and the reduced-motion still frame live in styles/index.css.

/** The lace, from off the left edge, through all four eyelets, off the right. */
const LACE =
  "M-4 36 C6 36 15 39 18 46 C22 55 42 55 46 46 C48.5 40.4 44 35 32 32 C20 29 15.5 23.6 18 18 C22 9 42 9 46 18 C49 25 58 28 68 28";

/** Two pairs, like a shoe. */
const EYELETS: readonly (readonly [number, number])[] = [
  [18, 18],
  [46, 18],
  [18, 46],
  [46, 46],
];

/** At this size and below, the eyelets and tip are dropped and the lace is thicker. */
export const LACE_SMALL_MAX = 24;

/** Content-area loads. */
export const LACE_SIZE = 56;
/** The full-screen boot state. */
export const LACE_SIZE_LARGE = 96;

export function LaceLoader({ size = LACE_SIZE }: { size?: number }) {
  const small = size <= LACE_SMALL_MAX;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-testid="lace-loader"
      data-small={small ? "" : undefined}
    >
      <rect width="64" height="64" rx="15" className="ss-lace-tile" />
      <path
        pathLength={1}
        d={LACE}
        fill="none"
        strokeWidth={small ? 7 : 5.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ss-lace-line"
      />
      {small ? null : (
        <>
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

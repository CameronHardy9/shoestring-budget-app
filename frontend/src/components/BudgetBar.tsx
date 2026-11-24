// Planned-vs-spent bar. Purely visual (aria-hidden): the numbers next to it are
// the accessible content, and the table view repeats them. Overspending fills
// the bar in the danger colour with diagonal stripes, and the caller always
// adds "Over by …" text, so colour is never the only signal (WCAG 1.4.1).
import { useId } from "react";
import { cx } from "./cx.ts";

export interface BudgetBarProps {
  plannedCents: number;
  actualCents: number;
  className?: string;
}

/** Share of the plan used, 0..1, for drawing only (never stored or summed). */
export function usedFraction(
  plannedCents: number,
  actualCents: number,
): number {
  if (actualCents <= 0) return 0;
  if (plannedCents <= 0) return 1;
  return Math.min(actualCents / plannedCents, 1);
}

export function BudgetBar({
  plannedCents,
  actualCents,
  className,
}: BudgetBarProps) {
  // useId output contains characters that are not safe inside url(#…).
  const stripes = `stripes-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const over = actualCents > plannedCents;
  const percent = `${(usedFraction(plannedCents, actualCents) * 100).toFixed(2)}%`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="100%"
      height="8"
      className={cx("block", className)}
      data-over={over ? "true" : undefined}
    >
      {over ? (
        <defs>
          <pattern
            id={stripes}
            width="6"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="3" height="8" className="fill-danger-stripe" />
          </pattern>
        </defs>
      ) : null}
      <rect width="100%" height="8" rx="4" className="fill-track" />
      {percent !== "0.00%" ? (
        <rect
          width={percent}
          height="8"
          rx="4"
          className={over ? "fill-danger" : "fill-brand"}
        />
      ) : null}
      {over ? (
        <rect width="100%" height="8" rx="4" fill={`url(#${stripes})`} />
      ) : null}
    </svg>
  );
}

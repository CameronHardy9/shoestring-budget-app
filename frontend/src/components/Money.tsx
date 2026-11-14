import { formatCents, type SignDisplay } from "../lib/money.ts";
import { cx } from "./cx.ts";

export interface MoneyProps {
  cents: number;
  sign?: SignDisplay;
  className?: string;
}

/** An amount in USD, tabular figures. Accepts integer cents only. */
export function Money({ cents, sign = "auto", className }: MoneyProps) {
  return (
    <span className={cx("tabular whitespace-nowrap", className)}>
      {formatCents(cents, sign)}
    </span>
  );
}

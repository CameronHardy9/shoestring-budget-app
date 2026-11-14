// Previous / next month with the month name. Links (not buttons): each month
// is its own URL (?month=YYYY-MM), so back/forward and reload keep it.
import { Link } from "react-aria-components";
import { useLocation, withSearch } from "../app/router.tsx";
import { monthLabel, shiftMonth } from "../lib/dates.ts";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

const FIRST = "2000-01";

function NavArrow({
  to,
  label,
  icon,
}: {
  to: string | null;
  label: string;
  icon: "chevronLeft" | "chevronRight";
}) {
  const location = useLocation();
  const cls = "flex size-touch items-center justify-center rounded-md text-fg";
  if (to === null) {
    return (
      <span aria-hidden="true" className={cx(cls, "opacity-40")}>
        <Icon name={icon} />
      </span>
    );
  }
  return (
    <Link
      href={withSearch(location, { month: to })}
      aria-label={`${label}, ${monthLabel(to)}`}
      className={cls}
    >
      <Icon name={icon} />
    </Link>
  );
}

export function MonthNav({
  month,
  currentMonth,
  showLabel = true,
}: {
  month: string;
  currentMonth: string;
  showLabel?: boolean;
}) {
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const last = shiftMonth(currentMonth, 12);
  return (
    <div className="flex items-center" role="group" aria-label="Month">
      <NavArrow
        to={prev >= FIRST ? prev : null}
        label="Previous month"
        icon="chevronLeft"
      />
      {showLabel ? (
        <span className="text-sm font-semibold text-fg">
          {monthLabel(month)}
        </span>
      ) : null}
      <NavArrow
        to={next <= last ? next : null}
        label="Next month"
        icon="chevronRight"
      />
    </div>
  );
}

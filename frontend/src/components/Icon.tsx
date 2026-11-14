// Inline SVG icons (no icon font, no third-party requests). Decorative by
// default: the control that holds an icon provides the accessible name.
import type { ReactElement, SVGProps } from "react";

const PATHS = {
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  overview: "M4 13h6V4H4v9zm10 7h6V11h-6v9zM4 20h6v-4H4v4zm10-16v4h6V4h-6z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  budgets: "M4 7h16v12H4zM4 7l2-3h12l2 3M9 12h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  alert:
    "M12 9v4m0 4h.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  calendar:
    "M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z",
  note: "M4 20h4l10.5-10.5a2.1 2.1 0 00-3-3L5 17v3zM14 7l3 3",
  split: "M6 4v5a3 3 0 003 3h6a3 3 0 013 3v5M18 4v5a3 3 0 01-3 3M6 20v-5",
  filter: "M4 6h16M7 12h10M10 18h4",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  key: "M15 7a3 3 0 11-3 3m3-3a3 3 0 00-3 3m3-3h.01M12 10l-8 8v2h3l1-1v-2h2v-2h2l1-1",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0",
  logout: "M15 17l5-5-5-5M20 12H9M12 20H5a1 1 0 01-1-1V5a1 1 0 011-1h7",
  backspace: "M9 5h11a1 1 0 011 1v12a1 1 0 01-1 1H9l-6-7 6-7zm3 4l6 6m0-6l-6 6",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Pixel size (square). */
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

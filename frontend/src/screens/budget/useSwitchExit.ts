import { useState } from "react";

/**
 * How the loader of a screen's month (and filter) leaves, for its PendingSlot's
 * `exit`. "loaded" once this screen has shown one: its data only goes missing
 * again because the person asked for another month or another category filter
 * (or retries one that failed), and that loader leaves as soon as the data is
 * there (owner rulings 2026-11-25). Until then (cold start, opening the tab,
 * retrying a first load that failed) "cycle". By cause, not by label: the
 * latch is this mount's, and another budget or tab is another mount.
 */
export function useSwitchExit(loaded: boolean): "loaded" | "cycle" {
  const [shown, setShown] = useState(false);
  if (loaded && !shown) setShown(true);
  return shown ? "loaded" : "cycle";
}

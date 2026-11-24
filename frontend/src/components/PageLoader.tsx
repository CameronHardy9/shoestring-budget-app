// The one page-level loader (owner rulings 2026-11-24), mounted once next to
// the routes. Every viewport LoadingState only registers a load
// (page-loader.ts); this draws the session: the 96 px lace in the middle of
// the viewport over an opaque cover, so the page beneath (inert meanwhile,
// through usePageCovered) can't be seen, tapped or read while the lace
// finishes its cycle. The cover sits under the tab bar and desktop rail
// (z-30), sheets (z-40), dialogs and toasts (z-50), so "+" always works.
import { useLayoutEffect, useRef } from "react";
import { LACE_SIZE_LARGE, LaceLoader } from "./LaceLoader.tsx";
import { takeUncoverWork, usePageLoader } from "./page-loader.ts";

/** Where focus goes when the cover is gone, if the cover took it. */
function restoreFocus(before: Element | null): void {
  const active = document.activeElement;
  // Focus moved on meanwhile (the tab bar, a sheet): leave it there.
  if (active && active !== document.body) return;
  if (!before || before === document.body) return;
  if (
    before instanceof HTMLElement &&
    before.isConnected &&
    !before.closest("[inert]")
  ) {
    before.focus({ preventScroll: true });
    return;
  }
  // The element was replaced by the loaded page: its heading, as after a
  // navigation (router.tsx).
  const heading = document.querySelector<HTMLElement>("main h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

export function PageLoader() {
  const { active, shown, epoch, label } = usePageLoader();
  const wasShown = useRef(false);
  useLayoutEffect(() => {
    if (shown) {
      wasShown.current = true;
      return;
    }
    if (!wasShown.current) return;
    wasShown.current = false;
    const work = takeUncoverWork();
    restoreFocus(work.focusBefore);
    for (const callback of work.callbacks) callback();
  }, [shown]);
  return (
    <>
      {shown && epoch !== null ? (
        <div
          className="fixed inset-0 z-20 flex touch-none items-center justify-center bg-canvas"
          data-testid="loading"
          data-placement="viewport"
        >
          <LaceLoader size={LACE_SIZE_LARGE} epoch={epoch} />
        </div>
      ) : null}
      {/* In the page from the session's start, empty, so the label is a
          change a screen reader announces; set once per session. */}
      {active ? (
        <div
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid="loading-status"
        >
          {label}
        </div>
      ) : null}
    </>
  );
}

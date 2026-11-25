// Records every time the main navigation (the tab bar, the rail, "+") appears
// in or leaves the page, or is hidden by React, after each batch of DOM changes.
// A MutationObserver reports in a microtask, after the page loader's own
// end-of-commit microtask and before any paint: what a frame could show.
import { screen } from "@testing-library/react";

export interface NavChange {
  nav: boolean;
  /** The page loader's cover (lace or plain) was up. */
  covered: boolean;
}

const NAV =
  'nav[aria-label="Main"], aside, [data-testid="quick-add-open"], [data-testid="quick-add-open-rail"]';

function hidden(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (e instanceof HTMLElement && e.style.display === "none") return true;
  return false;
}

export function recordNavigation() {
  const now = () =>
    [...document.querySelectorAll(NAV)].some((el) => !hidden(el));
  const changes: NavChange[] = [];
  let last = now();
  const sample = () => {
    const nav = now();
    if (nav === last) return;
    last = nav;
    changes.push({
      nav,
      covered:
        screen.queryByTestId("loading") !== null ||
        screen.queryByTestId("opening-cover") !== null,
    });
  };
  const observer = new MutationObserver(sample);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  return {
    changes,
    stop: () => {
      sample();
      observer.disconnect();
    },
  };
}

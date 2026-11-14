// A small history-API router. The app has a fixed set of routes (auth.md §15
// pins the email-link ones), so this avoids a router dependency and keeps the
// auth guard and return-after-sign-in rule in our own hands.
//
// - navigate() accepts only app-relative paths (safeReturnPath), so a value
//   from anywhere can never send the user off-site.
// - After each navigation, focus moves to the new page's <h1> so screen
//   readers announce the change, and the window scrolls to the top.
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RouterProvider } from "react-aria-components";
import { safeReturnPath } from "../lib/return-path.ts";

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("popstate", emit);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", emit);
  };
}

/** Called after every location change (used to check for app updates). */
export function onLocationChange(listener: () => void): () => void {
  return subscribe(listener);
}

function snapshot(): string {
  return window.location.pathname + window.location.search;
}

export interface Location {
  pathname: string;
  search: URLSearchParams;
  /** pathname + search */
  href: string;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const url = new URL(href, "https://app.invalid");
    return { pathname: url.pathname, search: url.searchParams, href };
  }, [href]);
}

let focusOnNextRender = false;

/** Client-side navigation to an app-relative path. Unsafe targets go to "/". */
export function navigate(
  to: string,
  options: { replace?: boolean } = {},
): void {
  const target = safeReturnPath(to) ?? "/";
  if (target === snapshot()) return;
  if (options.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  focusOnNextRender = !options.replace;
  emit();
}

/** Same path with some query parameters changed (null removes one). */
export function withSearch(
  location: Location,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${location.pathname}?${query}` : location.pathname;
}

/**
 * Matches "/budgets/:budgetId/transactions" against a pathname. Returns the
 * decoded params, or null. Segments must match exactly; no wildcards.
 */
export function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? "";
    const h = have[i] ?? "";
    if (w.startsWith(":")) {
      try {
        params[w.slice(1)] = decodeURIComponent(h);
      } catch {
        return null;
      }
    } else if (w !== h) {
      return null;
    }
  }
  return params;
}

/** Replaces the current entry on mount (for guards and default routes). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}

/** React Aria Links and buttons with href navigate client-side. */
export function AppRouter({ children }: { children: ReactNode }) {
  const { href } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    if (!focusOnNextRender) return;
    focusOnNextRender = false;
    // Wait for lazy screens to render their heading.
    const timer = window.setTimeout(() => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }, 50);
    return () => {
      window.clearTimeout(timer);
    };
  }, [href]);
  return (
    <RouterProvider
      navigate={(to) => {
        navigate(to);
      }}
    >
      {children}
    </RouterProvider>
  );
}

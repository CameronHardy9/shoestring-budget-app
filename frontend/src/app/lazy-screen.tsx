// Code-split screens (ARCHITECTURE JS budget: every screen is lazy) that can
// also be loaded ahead of time.
//
// React.lazy always suspends on its first render, even when the module is
// already loaded: the factory's promise settles on a later tick, so the
// Suspense fallback commits, and React then holds the fallback for its
// 300 ms reveal throttle before showing the screen. A screen whose module was
// preloaded here skips React.lazy altogether and renders on the first pass.
// Nothing in the app preloads today; the component tests do (src/test/
// preload-screens.ts), so they don't depend on timers and dynamic imports.
import { lazy, useState, type ComponentType } from "react";

export interface LazyScreen {
  (): React.JSX.Element;
  /** Loads the screen's module; later mounts render without suspending. */
  preload: () => Promise<void>;
}

const registry: LazyScreen[] = [];

export function lazyScreen(load: () => Promise<ComponentType>): LazyScreen {
  let loaded: ComponentType | undefined;
  let pending: Promise<void> | undefined;
  const preload = () =>
    (pending ??= load().then(
      (component) => {
        loaded = component;
      },
      (error: unknown) => {
        // A failed chunk load (offline) can be retried by a later preload.
        pending = undefined;
        throw error;
      },
    ));
  const Lazy = lazy(async () => {
    const component = loaded ?? (await load());
    loaded = component;
    return { default: component };
  });
  function Screen() {
    // Chosen once per mount, so a module that finishes loading while this
    // screen is up never swaps the component (and resets its state).
    const [Component] = useState<ComponentType>(() => loaded ?? Lazy);
    return <Component />;
  }
  const screen = Object.assign(Screen, { preload });
  registry.push(screen);
  return screen;
}

/** Loads every screen created with lazyScreen() so far. */
export async function preloadAllScreens(): Promise<void> {
  await Promise.all(registry.map((screen) => screen.preload()));
}

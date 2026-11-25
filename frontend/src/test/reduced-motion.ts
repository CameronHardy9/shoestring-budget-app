// For tests that wait for a page through the real App on real timers: with
// reduced motion the page loader (and the opening's missing navigation) ends
// as soon as loading does, so a slow machine never meets a 3.2 s lace cycle.
import { vi } from "vitest";

/** Call in beforeEach: Vitest unstubs globals after every test. */
export function stubReducedMotion(reduce = true): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

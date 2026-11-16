// For tests that render routes through <App />: load every lazy screen first
// (beforeAll(preloadScreens)), so a route renders on its first pass instead of
// suspending. Without this the first render of each screen waits on a dynamic
// import() (Vitest transforms the module graph on demand) and then on React's
// 300 ms Suspense reveal throttle, which under CPU load can outlast a findBy*
// timeout. See src/app/lazy-screen.tsx.
//
// Importing App registers every screen (routes.tsx and App.tsx create them at
// module load). The hook timeout, not each assertion, absorbs the load cost.
import "../App.tsx";
import { preloadAllScreens } from "../app/lazy-screen.tsx";

export function preloadScreens(): Promise<void> {
  return preloadAllScreens();
}

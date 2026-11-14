// Registers /sw.js in production builds only (the dev server and e2e run
// without a service worker). ADR-0002: check for a new version on navigation
// and offer "Reload to update"; never reload on the person's behalf while
// they may be typing.
import { useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
let waiting: ServiceWorker | null = null;

function setWaiting(worker: ServiceWorker | null): void {
  waiting = worker;
  for (const l of listeners) l();
}

/** True when a new version is installed and waiting. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting !== null,
  );
}

/** Activates the waiting worker; the page reloads when it takes control. */
export function applyUpdate(): void {
  waiting?.postMessage("skip-waiting");
}

const CHECK_EVERY_MS = 60_000;

export function registerServiceWorker(
  onNavigate: (listener: () => void) => () => void,
): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const start = async () => {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    const track = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const check = () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller)
          setWaiting(worker);
      };
      check();
      worker.addEventListener("statechange", check);
    };
    track(registration.waiting);
    registration.addEventListener("updatefound", () => {
      track(registration.installing);
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    let lastCheck = Date.now();
    onNavigate(() => {
      if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
      lastCheck = Date.now();
      void registration.update().catch(() => undefined);
    });
  };
  window.addEventListener("load", () => {
    void start().catch(() => undefined);
  });
}

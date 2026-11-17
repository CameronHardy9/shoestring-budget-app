// Entry. In production the link-token capture is NOT imported from here: it is
// its own first <script type="module"> (vite.config.ts bootScriptPlugin,
// F-50), so it runs before this file's whole module graph, shared chunks and
// error tracking included. The import below only orders it in dev, where
// modules are not bundled; in the build it is the same, already evaluated,
// module.
import "./boot/capture-link-token.ts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { onLocationChange } from "./app/router.tsx";
import { findRoute } from "./app/routes.tsx";
import { registerServiceWorker } from "./app/sw-register.ts";
import { applyTheme, getThemePreference } from "./lib/preferences.ts";
import {
  bufferEarlyErrors,
  startErrorTracking,
} from "./observability/report.ts";
import "./styles/index.css";

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
const stopBuffer = SENTRY_DSN ? bufferEarlyErrors(window) : undefined;

applyTheme(getThemePreference());
registerServiceWorker(onLocationChange);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Error tracking starts after the first render, from a lazy chunk (bundle
// budget), and only when a DSN was built in.
if (SENTRY_DSN) {
  const start = () => {
    setTimeout(() => {
      void startErrorTracking({
        dsn: SENTRY_DSN,
        release: import.meta.env.VITE_APP_RELEASE || "dev",
        routeOf: (pathname) => findRoute(pathname)?.route.pattern ?? "(none)",
        ...(stopBuffer ? { stopBuffer } : {}),
      }).then((started) => {
        // A stable hook for e2e: <html data-error-tracking="on">.
        if (started) document.documentElement.dataset.errorTracking = "on";
      });
    }, 0);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

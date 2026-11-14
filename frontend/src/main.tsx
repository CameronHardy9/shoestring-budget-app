// Must stay the first import: strips emailed-link tokens from the URL.
import "./boot/capture-link-token.ts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { onLocationChange } from "./app/router.tsx";
import { registerServiceWorker } from "./app/sw-register.ts";
import { applyTheme, getThemePreference } from "./lib/preferences.ts";
import "./styles/index.css";

applyTheme(getThemePreference());
registerServiceWorker(onLocationChange);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

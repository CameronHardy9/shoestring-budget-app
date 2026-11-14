// DEV PREVIEW ONLY (preview.html). Never a production entry: see vite.config.ts
// and scripts/check-dist.ts.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./preview.css";
import { DEV_PREVIEW_SENTINEL } from "./mock-data.ts";
import { PreviewApp, SCREENS, type Screen } from "./PreviewApp.tsx";

const params = new URLSearchParams(window.location.search);
const screenParam = params.get("screen");
const screen = SCREENS.find((s) => s === screenParam) ?? null;
const theme = params.get("theme") === "dark" ? "dark" : "light";
const view = params.get("view") === "table" ? "table" : "chart";

const root = document.documentElement;
root.dataset.theme = theme;
root.dataset.preview = DEV_PREVIEW_SENTINEL;

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <PreviewApp screen={screen satisfies Screen | null} view={view} />
  </StrictMode>,
);

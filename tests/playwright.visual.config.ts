// Visual baselines (owner decision, meeting 5: Playwright screenshots in a
// fixed Linux container, about 6 key screens at 2 phone sizes). `make e2e` runs
// this inside the pinned mcr.microsoft.com/playwright image (.github/scripts/
// e2e.sh "visual"), against the PRODUCTION build (ADR-0009) served by
// scripts/prod-server.mjs. Baselines are committed only from that container:
// on CI a missing baseline fails; locally (no CI) the container writes it.
import { defineConfig, devices } from "@playwright/test";
import { env } from "./support/env.ts";

const prodPort = Number(
  process.env.PROD_SERVER_PORT || Number(new URL(env.appOrigin).port) + 1,
);
const PROD_URL = `http://localhost:${prodPort}`;

const common = {
  locale: "en-US",
  timezoneId: "America/New_York",
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  baseURL: PROD_URL,
};

export default defineConfig({
  testDir: "./visual",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/visual" }],
  ],
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  updateSnapshots: process.env.CI ? "none" : "missing",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.002,
    },
  },
  use: common,
  webServer: {
    command: "node scripts/prod-server.mjs",
    env: {
      APP_ORIGIN: env.appOrigin,
      API_URL: env.apiUrl,
      PROD_SERVER_PORT: String(prodPort),
    },
    url: `${PROD_URL}/__prod-server`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "ignore",
  },
  projects: [
    // Two phone sizes: a small iPhone (WebKit) and a large Android (Chromium).
    { name: "iphone-se-webkit", use: { ...devices["iPhone SE"], ...common } },
    { name: "pixel-7-chromium", use: { ...devices["Pixel 7"], ...common } },
  ],
});

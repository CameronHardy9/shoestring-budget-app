// Playwright e2e (journeys J1-J6, axe, session checks) against the e2e stack.
//   journeys: the Vite dev server at BASE_URL (ADR-0009), on the three device
//             projects the owner chose: iPhone-sized WebKit, Pixel-sized
//             Chromium, desktop Chrome.
//   csp-prod: the PRODUCTION build with the backend's real CSP (C3.1 gate),
//             served by scripts/prod-server.mjs, on WebKit and Chromium phones.
// One worker: every test resets the single shared backend (tests/CLAUDE.md).
import { defineConfig, devices } from "@playwright/test";
import { env } from "./support/env.ts";

const prodPort = Number(
  process.env.PROD_SERVER_PORT || Number(new URL(env.appOrigin).port) + 1,
);
export const PROD_URL = `http://localhost:${prodPort}`;

const common = {
  locale: "en-US",
  timezoneId: "America/New_York",
  reducedMotion: "reduce" as const,
  // The service worker exists only in production builds. Blocked everywhere
  // except e2e/csp-prod/sw-first-visit.spec.ts, which runs the real /sw.js
  // (install, offline and update: the owner's phone check).
  serviceWorkers: "block" as const,
};

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  use: {
    ...common,
    baseURL: env.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/prod-server.mjs",
    env: { APP_ORIGIN: env.appOrigin, API_URL: env.apiUrl, PROD_SERVER_PORT: String(prodPort) },
    url: `${PROD_URL}/__prod-server`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "ignore",
  },
  projects: [
    {
      name: "iphone-webkit",
      testIgnore: /csp-prod\//,
      use: { ...devices["iPhone 13"], ...common },
    },
    {
      name: "pixel-chromium",
      testIgnore: /csp-prod\//,
      use: { ...devices["Pixel 7"], ...common },
    },
    {
      name: "desktop-chrome",
      testIgnore: /csp-prod\//,
      use: { ...devices["Desktop Chrome"], ...common },
    },
    {
      name: "csp-prod-webkit",
      testMatch: /csp-prod\/.*\.spec\.ts/,
      use: { ...devices["iPhone 13"], ...common, baseURL: PROD_URL },
    },
    {
      name: "csp-prod-chromium",
      testMatch: /csp-prod\/.*\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        ...common,
        baseURL: PROD_URL,
        // Back/forward cache ON, as in a real Chrome, so the F-32 test can
        // prove a bfcache restore (e2e/sign-out-back.ts). Playwright passes
        // --disable-back-forward-cache by default, and its headless shell never
        // caches, so this project runs full Chromium in new headless mode
        // (installed by `playwright install chromium`). A page.goBack() here
        // must wait for "commit": a restore fires no load event.
        channel: "chromium",
        launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
      },
    },
  ],
});

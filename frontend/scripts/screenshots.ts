// Renders the dev-only style preview and writes the proposal screenshots to
// design/style-proposal/. Not part of make check or CI.
//
//   pnpm --filter ./frontend screenshots
//
// Uses playwright-core with the locally installed Google Chrome (channel
// "chrome"), so nothing is downloaded. Set CHROME_PATH to use another binary.
// test-engineer owns e2e and visual baselines in tests/; this is only for the
// owner's style review.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { createServer } from "vite";

const OUT = fileURLToPath(
  new URL("../design/style-proposal/", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface Shot {
  file: string;
  query: string;
  width: number;
  height: number;
  fullPage?: boolean;
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const shots: Shot[] = [];
for (const theme of ["light", "dark"] as const) {
  shots.push(
    {
      file: `01-signin-${theme}.png`,
      query: `screen=signin&theme=${theme}`,
      ...PHONE,
    },
    {
      file: `02-overview-${theme}.png`,
      query: `screen=overview&theme=${theme}`,
      ...PHONE,
    },
    {
      file: `03-overview-full-${theme}.png`,
      query: `screen=overview&theme=${theme}`,
      ...PHONE,
      fullPage: true,
    },
    {
      file: `04-overview-table-${theme}.png`,
      query: `screen=overview&view=table&theme=${theme}`,
      ...PHONE,
      fullPage: true,
    },
    {
      file: `05-quick-add-${theme}.png`,
      query: `screen=quick-add&theme=${theme}`,
      ...PHONE,
    },
    {
      file: `06-quick-add-split-${theme}.png`,
      query: `screen=quick-add-split&theme=${theme}`,
      ...PHONE,
    },
    {
      file: `07-transactions-${theme}.png`,
      query: `screen=transactions&theme=${theme}`,
      ...PHONE,
    },
    {
      file: `08-overview-desktop-${theme}.png`,
      query: `screen=overview&theme=${theme}`,
      ...DESKTOP,
    },
  );
}
shots.push({
  file: "01-signin-error-light.png",
  query: "screen=signin-error&theme=light",
  ...PHONE,
});

async function launch(): Promise<Browser> {
  const options: LaunchOptions = { headless: true };
  const path = process.env.CHROME_PATH;
  return chromium.launch(
    path
      ? { ...options, executablePath: path }
      : { ...options, channel: "chrome" },
  );
}

mkdirSync(OUT, { recursive: true });
const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 5199, strictPort: true },
});
await server.listen();
const browser = await launch();
const problems: string[] = [];
try {
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 2,
      isMobile: shot.width < 600,
      hasTouch: shot.width < 600,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning")
        problems.push(`${shot.file}: ${msg.text()}`);
    });
    page.on("pageerror", (err) =>
      problems.push(`${shot.file}: ${err.message}`),
    );
    await page.goto(`http://127.0.0.1:5199/preview.html?${shot.query}`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => document.fonts.ready);
    // Screenshots show the resting state: no focus ring from autofocus.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    if (shot.fullPage) {
      // A full-page capture would paint the fixed tab bar mid-page; grow the
      // viewport to the document height instead so it sits at the bottom.
      const height = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      await page.setViewportSize({ width: shot.width, height });
    }
    await page.screenshot({ path: `${OUT}${shot.file}` });
    await context.close();
    process.stdout.write(`wrote ${shot.file}\n`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length > 0) {
  process.stderr.write(`console problems:\n${problems.join("\n")}\n`);
  process.exitCode = 1;
}

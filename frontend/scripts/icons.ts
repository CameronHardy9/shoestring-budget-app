// Renders the app icons (PNG) from the logo SVG with the installed Chrome.
// Run after changing the logo: pnpm --filter ./frontend icons
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const OUT = fileURLToPath(new URL("../public/icons/", import.meta.url));
const BRAND = "#4f46e5";
const S_PATH =
  "M21.5 10.5c-1.3-1.2-3.1-1.8-5.2-1.8-3.1 0-5.1 1.6-5.1 3.8 0 4.8 10.6 2.7 10.6 7.3 0 2.2-2.1 3.9-5.5 3.9-2.3 0-4.3-.7-5.8-2.1";

/** Standard icon: rounded square. Maskable: full bleed, mark inside the 80% safe zone. */
function svg(maskable: boolean): string {
  const bg = maskable
    ? `<rect width="32" height="32" fill="${BRAND}"/>`
    : `<rect width="32" height="32" rx="7" fill="${BRAND}"/>`;
  const mark = `<path d="${S_PATH}" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>`;
  const inner = maskable
    ? `<g transform="translate(16 16) scale(0.72) translate(-16 -16)">${mark}</g>`
    : mark;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${bg}${inner}</svg>`;
}

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: true },
];

writeFileSync(`${OUT}icon.svg`, svg(false));
const browser = await chromium.launch(
  process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" },
);
try {
  for (const t of targets) {
    const page = await browser.newPage({
      viewport: { width: t.size, height: t.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg(t.maskable).replace("<svg ", `<svg width="${String(t.size)}" height="${String(t.size)}" `)}</body></html>`,
    );
    await page.screenshot({ path: `${OUT}${t.file}`, omitBackground: true });
    await page.close();
    process.stdout.write(`wrote ${t.file}\n`);
  }
} finally {
  await browser.close();
}

// Runs after `vite build` (pnpm build). Fails the build if dist/ is not what
// the backend and the CSP expect:
// - no dev-only preview (preview.html or the preview sentinel string)
// - every asset name matches backend/src/http/static.ts cacheControlFor, so it
//   is served as immutable
// - index.html has no inline script or style (strict CSP), and source maps
//   are hidden (not referenced from the JS/CSS)
// - initial JS and CSS stay inside the ARCHITECTURE budget (gzip)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const SENTINEL = "__SHOESTRING_DEV_PREVIEW__";
const HASHED = /[-.][A-Za-z0-9_]{8,}\.(js|css|woff2|png|svg|webp|ico)$/;
const BUDGET = {
  js: 150 * 1024,
  css: 30 * 1024,
  fontFiles: 2,
  fontBytes: 60 * 1024,
};

const errors: string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

if (!existsSync(join(DIST, "index.html"))) {
  process.stderr.write(
    "check-dist: dist/index.html is missing (run vite build)\n",
  );
  process.exit(1);
}

const all = files(DIST);
for (const file of all) {
  const rel = relative(DIST, file);
  if (/preview/i.test(rel)) errors.push(`dev preview file in dist: ${rel}`);
  if (/\.(js|css|html)$/.test(rel)) {
    const text = readFileSync(file, "utf8");
    if (text.includes(SENTINEL))
      errors.push(`dev preview code in dist: ${rel}`);
    if (/sourceMappingURL=/.test(text))
      errors.push(`source map is referenced (should be hidden): ${rel}`);
  }
  // Source maps never reach the public image (the Dockerfile moves them to the
  // private sourcemaps stage), so only shipped assets need hashed names.
  if (rel.startsWith("assets/") && !rel.endsWith(".map") && !HASHED.test(rel)) {
    errors.push(
      `asset name does not match the backend's immutable cache rule: ${rel}`,
    );
  }
}

const html = readFileSync(join(DIST, "index.html"), "utf8");
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html))
  errors.push("index.html has an inline <script>");
if (/<style[\s>]/i.test(html) || /\sstyle=/i.test(html))
  errors.push("index.html has inline styles");

// Initial route = what index.html loads directly.
const initial = [
  ...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g),
].map((m) => m[1] ?? "");
const gz = (ext: string) =>
  initial
    .filter((f) => f.endsWith(ext))
    .reduce((sum, f) => sum + gzipSync(readFileSync(join(DIST, f))).length, 0);
const js = gz(".js");
const css = gz(".css");
if (js > BUDGET.js)
  errors.push(`initial JS ${js} B gzip exceeds ${BUDGET.js} B`);
if (css > BUDGET.css)
  errors.push(`initial CSS ${css} B gzip exceeds ${BUDGET.css} B`);

// PWA: the worker and manifest exist; the worker precaches no API path, no
// source map, and nothing outside this build.
const swPath = join(DIST, "sw.js");
if (!existsSync(swPath) || !existsSync(join(DIST, "manifest.webmanifest"))) {
  errors.push("sw.js or manifest.webmanifest missing");
} else {
  const precache = JSON.parse(
    /const PRECACHE = (\[[^\]]*\]);/.exec(readFileSync(swPath, "utf8"))?.[1] ??
      "[]",
  ) as string[];
  if (precache.length === 0) errors.push("sw.js has an empty precache list");
  for (const url of precache) {
    if (url.startsWith("/api") || url.endsWith(".map"))
      errors.push(`sw.js precaches ${url}`);
    else if (!existsSync(join(DIST, url)))
      errors.push(`sw.js precaches a missing file: ${url}`);
  }
}

// Self-hosted fonts (ARCHITECTURE: <= 2 woff2 files, <= 60 KB total).
const fonts = all.filter((f) => f.endsWith(".woff2"));
const fontBytes = fonts.reduce((sum, f) => sum + statSync(f).size, 0);
if (fonts.length > BUDGET.fontFiles)
  errors.push(
    `${String(fonts.length)} woff2 files (budget ${String(BUDGET.fontFiles)})`,
  );
if (fontBytes > BUDGET.fontBytes)
  errors.push(
    `fonts ${String(fontBytes)} B exceed ${String(BUDGET.fontBytes)} B`,
  );

process.stdout.write(
  `check-dist: ${all.length} files; initial JS ${(js / 1024).toFixed(1)} KB gzip (budget 150), ` +
    `CSS ${(css / 1024).toFixed(1)} KB gzip (budget 30), fonts ${String(fonts.length)} file(s) ${(fontBytes / 1024).toFixed(1)} KB (budget 2 / 60)\n`,
);
if (errors.length > 0) {
  process.stderr.write(`check-dist failed:\n  ${errors.join("\n  ")}\n`);
  process.exit(1);
}

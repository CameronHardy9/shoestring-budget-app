// Builds /sw.js from sw/service-worker.js with the precache list of this build.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const SW_TEMPLATE = fileURLToPath(
  new URL("../sw/service-worker.js", import.meta.url),
);

/** Files from public/ that belong to the app shell. */
export const PUBLIC_SHELL = [
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

export function renderServiceWorker(
  template: string,
  bundleFiles: readonly string[],
): string {
  const assets = bundleFiles
    .filter((f) => f.startsWith("assets/") && !f.endsWith(".map"))
    .map((f) => `/${f}`)
    .sort();
  const precache = [...assets, ...PUBLIC_SHELL];
  const version = createHash("sha256")
    .update(precache.join("\n"))
    .digest("hex")
    .slice(0, 12);
  const out = template
    .replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`)
    .replace(
      "const PRECACHE = __PRECACHE__;",
      `const PRECACHE = ${JSON.stringify(precache)};`,
    );
  if (
    !template.includes("const PRECACHE = __PRECACHE__;") ||
    !template.includes('const VERSION = "__VERSION__";')
  ) {
    throw new Error("service worker template placeholders not found");
  }
  return out;
}

export function serviceWorkerPlugin(): Plugin {
  return {
    name: "shoestring-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: renderServiceWorker(
          readFileSync(SW_TEMPLATE, "utf8"),
          Object.keys(bundle),
        ),
      });
    },
  };
}

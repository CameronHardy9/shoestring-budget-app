// Vite config for the Shoestring SPA.
//
// Dev (`pnpm dev`, `make dev`, `make e2e`): the browser talks only to this
// server, which proxies /api to API_PROXY_TARGET. The proxy must forward the
// browser's Host header unchanged (no changeOrigin): the backend compares Host
// with APP_ORIGIN, port included (auth.md §3), and rejects anything else.
//
// Build (`pnpm build`): only index.html is an entry, so the dev-only style
// preview (preview.html, src/preview/) never reaches dist/. scripts/check-dist.ts
// asserts that, plus the asset naming the backend's cache rules expect.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions, type UserConfig } from "vite";
import { serviceWorkerPlugin } from "./scripts/service-worker.ts";

export const DEFAULT_API_PROXY_TARGET = "http://localhost:3000";

export function apiProxy(
  env: Record<string, string | undefined>,
): Record<string, ProxyOptions> {
  return {
    "/api": {
      target: env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET,
      // Never true: see the header comment.
      changeOrigin: false,
      // Plain HTTP API, no websockets.
      ws: false,
    },
  };
}

export function buildConfig(
  env: Record<string, string | undefined>,
): UserConfig {
  return {
    plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
    server: {
      // make dev sets HOST=0.0.0.0 inside the container; default to loopback.
      host: env.HOST || "127.0.0.1",
      port: Number(env.PORT || 5173),
      strictPort: true,
      proxy: apiProxy(env),
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: apiProxy(env),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Maps are written but not referenced; the Dockerfile moves them out of
      // the public image for a private Sentry upload.
      sourcemap: "hidden",
      // Safari 16.4 is the floor (ARCHITECTURE "Browsers").
      target: ["es2022", "safari16.4", "chrome111", "firefox114"],
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: {
          index: fileURLToPath(new URL("./index.html", import.meta.url)),
        },
        output: {
          // Hex hashes match backend/src/http/static.ts cacheControlFor
          // ([-.][A-Za-z0-9_]{8,}), so every asset is cached as immutable.
          hashCharacters: "hex",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
}

export default defineConfig(() => buildConfig(process.env));

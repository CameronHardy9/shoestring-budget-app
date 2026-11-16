// Serves the PRODUCTION frontend build (tests/.prod-build, from
// build-prod-frontend.mjs) the way the production image does, for the CSP
// violation gate (C3.1) and the visual baselines (ADR-0009):
//   - every document and asset carries the backend's own security headers,
//     copied byte for byte from a live backend response at startup (so the
//     CSP is the real one; contract tests pin it to ARCHITECTURE.md and the
//     frontend's STYLE_SRC);
//   - non-/api GETs that accept text/html fall back to index.html;
//   - /api is proxied to the e2e stack with Host and Origin set to APP_ORIGIN,
//     because the backend only accepts its own origin (the Vite dev server
//     stays the origin for the journeys, ADR-0009).
// Plain JavaScript (no type stripping) so it also runs in the pinned Playwright
// container. Never used for anything but tests.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../.prod-build/", import.meta.url));
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "").replace(/\/$/, "");
if (!APP_ORIGIN) throw new Error("prod-server: APP_ORIGIN is not set");
const UPSTREAM = new URL(process.env.API_URL || (process.env.BACKEND_PORT ? `http://127.0.0.1:${process.env.BACKEND_PORT}` : process.env.BASE_URL || APP_ORIGIN));
export const PORT = Number(process.env.PROD_SERVER_PORT || Number(new URL(APP_ORIGIN).port) + 1);
const SELF = `http://localhost:${PORT}`;
const APP_HOST = new URL(APP_ORIGIN).host;

if (!existsSync(join(ROOT, "index.html")))
  throw new Error("prod-server: tests/.prod-build is missing. Run: node tests/scripts/build-prod-frontend.mjs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
const SECURITY = [
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "x-frame-options",
  "permissions-policy",
  "reporting-endpoints",
];

function upstream(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: UPSTREAM.hostname, port: UPSTREAM.port, method, path, headers, setHost: false },
      resolve,
    );
    req.on("error", reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

async function securityHeaders() {
  const res = await upstream("GET", "/api/healthz", { host: APP_HOST });
  res.resume();
  const out = {};
  for (const name of SECURITY) if (res.headers[name]) out[name] = res.headers[name];
  if (!out["content-security-policy"]) throw new Error("prod-server: the backend sent no CSP");
  return out;
}

const headers = await securityHeaders();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", SELF);
    if (url.pathname === "/__prod-server") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const h = { ...req.headers, host: APP_HOST };
      if (h.origin === SELF) h.origin = APP_ORIGIN;
      delete h.referer;
      const up = await upstream(req.method ?? "GET", req.url ?? "/", h, req);
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      return;
    }
    // Static files (never source maps: the production image moves them out).
    let file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    const isFile = file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile() && extname(file) !== ".map";
    if (!isFile) {
      const wantsHtml = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
      if (!wantsHtml) {
        res.writeHead(404, { ...headers, "content-type": "text/plain" }).end("not found");
        return;
      }
      file = join(ROOT, "index.html");
    }
    res.writeHead(200, {
      ...headers,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" }).end(`prod-server: ${e instanceof Error ? e.message : String(e)}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`prod-server: production build on ${SELF}, /api → ${UPSTREAM.origin}\n`);
});

// Shoestring service worker (ADR-0002: installable, online to save). The build
// (vite.config.ts) fills in __VERSION__ and __PRECACHE__ and writes /sw.js.
//
// - App shell only: index.html, hashed JS/CSS, the font, icons, manifest.
// - /api/* is never intercepted: requests go to the network and nothing from
//   the API is ever stored (no financial data on the device).
// - Navigations are network-first, so an online visit always gets the current
//   deploy's index.html (and its CSP and asset names). Only when the network
//   fails does it fall back to the index.html precached with THIS worker's
//   assets, which always match each other.
// - A new build has a new version: it installs alongside, the app offers
//   "Reload to update", and on activation old caches are deleted.

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `shoestring-shell-${VERSION}`;
const SHELL = "/index.html";

function isApi(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([SHELL, ...PRECACHE])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

async function navigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(SHELL, {
      cacheName: CACHE,
      ignoreVary: true,
    });
    return cached ?? Response.error();
  }
}

// Matched by path with ignoreVary: module scripts are requested with an
// Origin header (crossorigin) while the precache was filled without one, and
// a Vary header on the response would otherwise make every lookup miss
// (offline: a blank page). Hashed shell files never vary.
async function shellAsset(request) {
  const cached = await caches.match(new URL(request.url).pathname, {
    cacheName: CACHE,
    ignoreVary: true,
  });
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  if (PRECACHE.includes(url.pathname)) event.respondWith(shellAsset(request));
});

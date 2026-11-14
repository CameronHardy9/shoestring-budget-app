// The built SPA at / (ARCHITECTURE "Same origin"): hashed assets are
// immutable; index.html, manifest.webmanifest and sw.js are no-cache; any
// non-/api GET that accepts text/html falls back to index.html.
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { basename } from "node:path";

const NO_CACHE = new Set(["index.html", "manifest.webmanifest", "sw.js"]);

export function cacheControlFor(path: string): string {
  const name = basename(path);
  if (NO_CACHE.has(name)) return "no-cache";
  // Vite emits content-hashed names such as index-3f2a9c1b.js.
  if (/[-.][A-Za-z0-9_]{8,}\.(js|css|woff2|png|svg|webp|ico|map)$/.test(name))
    return "public, max-age=31536000, immutable";
  return "no-cache";
}

export async function registerStatic(
  app: FastifyInstance,
  root: string,
): Promise<boolean> {
  if (!existsSync(root)) return false;
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    wildcard: false, // one route per file at startup: /api/* can never match a file
    index: false,
    dotfiles: "deny",
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      res.header("cache-control", cacheControlFor(path));
    },
  });
  return true;
}

export function wantsSpaFallback(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0] ?? "";
  return (
    req.method === "GET" &&
    !path.startsWith("/api/") &&
    path !== "/api" &&
    (req.headers.accept ?? "").includes("text/html")
  );
}

export function sendIndex(reply: FastifyReply): FastifyReply {
  reply.header("cache-control", "no-cache");
  return reply.sendFile("index.html");
}

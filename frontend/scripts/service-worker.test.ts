// @vitest-environment node
// Runs the real service worker (as built) in a sandbox with fake caches and
// fetch, and checks the rules from ADR-0002: app shell only, /api never
// touched, navigations network-first with an offline fallback.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SHELL,
  renderServiceWorker,
  SW_TEMPLATE,
} from "./service-worker.ts";

const BUNDLE = [
  "assets/index-0123abcd.js",
  "assets/index-0123abcd.js.map",
  "assets/index-4567ef01.css",
  "assets/inter-latin-89abcdef.woff2",
  "index.html",
  "sw.js",
];

type Handler = (event: Record<string, unknown>) => void;

function load(fetchImpl: (req: unknown) => Promise<unknown>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, string>>([
    ["shoestring-shell-old", new Map()],
  ]);
  const caches = {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        addAll: async (urls: string[]) => {
          urls.forEach((u) => store.set(u, `cached:${u}`));
        },
      };
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (
      req: string | { url: string },
      opts: { cacheName: string },
    ) => {
      const path = typeof req === "string" ? req : new URL(req.url).pathname;
      return stores.get(opts.cacheName)?.get(path);
    },
  };
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
  };
  const source = renderServiceWorker(readFileSync(SW_TEMPLATE, "utf8"), BUNDLE);
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchImpl,
    Response: { error: () => "network-error" },
    URL,
    Promise,
    JSON,
  });
  const run = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<unknown> | undefined;
    handlers.get(type)!({
      ...event,
      waitUntil: (p: Promise<unknown>) => (waited = p),
      respondWith: (p: Promise<unknown>) => (responded = p),
    });
    await waited;
    return responded === undefined ? undefined : await responded;
  };
  const fetchEvent = (
    url: string,
    init: { method?: string; mode?: string } = {},
  ) =>
    run("fetch", {
      request: {
        url,
        method: init.method ?? "GET",
        mode: init.mode ?? "no-cors",
      },
    });
  return { source, stores, self, run, fetchEvent };
}

describe("service worker", () => {
  it("precaches the hashed app shell and public files, never maps or the worker itself", () => {
    const { source } = load(async () => "net");
    const precache = JSON.parse(
      /const PRECACHE = (\[.*\]);/.exec(source)![1]!,
    ) as string[];
    expect(precache).toEqual([
      "/assets/index-0123abcd.js",
      "/assets/index-4567ef01.css",
      "/assets/inter-latin-89abcdef.woff2",
      ...PUBLIC_SHELL,
    ]);
    expect(source).toMatch(/const VERSION = "[0-9a-f]{12}";/);
    const template = readFileSync(SW_TEMPLATE, "utf8");
    expect(renderServiceWorker(template, ["assets/a-11111111.js"])).not.toBe(
      renderServiceWorker(template, ["assets/a-22222222.js"]),
    );
    expect(() => renderServiceWorker("no placeholders", [])).toThrow();
  });

  it("caches the shell on install and drops old caches on activate", async () => {
    const sw = load(async () => "net");
    await sw.run("install", {});
    await sw.run("activate", {});
    expect([...sw.stores.keys()]).toHaveLength(1);
    const [name] = [...sw.stores.keys()];
    expect(name).toMatch(/^shoestring-shell-/);
    expect(sw.stores.get(name!)!.has("/index.html")).toBe(true);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it("never handles API requests, writes, or other origins", async () => {
    const fetchSpy = vi.fn(async () => "net");
    const sw = load(fetchSpy);
    await sw.run("install", {});
    expect(await sw.fetchEvent("https://app.test/api/budgets")).toBeUndefined();
    expect(
      await sw.fetchEvent("https://app.test/api/auth/session", {
        mode: "navigate",
      }),
    ).toBeUndefined();
    expect(
      await sw.fetchEvent("https://app.test/assets/index-0123abcd.js", {
        method: "POST",
      }),
    ).toBeUndefined();
    expect(
      await sw.fetchEvent("https://elsewhere.test/assets/index-0123abcd.js"),
    ).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves navigations from the network, and the cached shell only when offline", async () => {
    let online = true;
    const sw = load(async () => {
      if (!online) throw new TypeError("offline");
      return "fresh index";
    });
    await sw.run("install", {});
    expect(
      await sw.fetchEvent("https://app.test/budgets/x", { mode: "navigate" }),
    ).toBe("fresh index");
    online = false;
    expect(
      await sw.fetchEvent("https://app.test/budgets/x", { mode: "navigate" }),
    ).toBe("cached:/index.html");
  });

  it("serves precached assets from the cache and leaves unknown files to the network", async () => {
    const sw = load(async () => "net");
    await sw.run("install", {});
    expect(
      await sw.fetchEvent("https://app.test/assets/index-0123abcd.js"),
    ).toBe("cached:/assets/index-0123abcd.js");
    expect(
      await sw.fetchEvent("https://app.test/assets/other-99999999.js"),
    ).toBeUndefined();
  });

  it("activates a waiting update only when asked", async () => {
    const sw = load(async () => "net");
    await sw.run("message", { data: "something else" });
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    await sw.run("message", { data: "skip-waiting" });
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });
});

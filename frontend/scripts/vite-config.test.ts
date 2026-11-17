// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  apiProxy,
  buildConfig,
  DEFAULT_API_PROXY_TARGET,
} from "../vite.config.ts";

describe("dev proxy", () => {
  it("proxies /api to API_PROXY_TARGET without changeOrigin (auth.md §3 Host check)", () => {
    const proxy = apiProxy({ API_PROXY_TARGET: "http://backend:3000" })["/api"];
    expect(proxy).toMatchObject({
      target: "http://backend:3000",
      changeOrigin: false,
      ws: false,
    });
  });

  it("defaults the target for a host-only setup", () => {
    expect(apiProxy({})["/api"]?.target).toBe(DEFAULT_API_PROXY_TARGET);
  });

  it("listens where make dev says", () => {
    const config = buildConfig({ HOST: "0.0.0.0", PORT: "5999" });
    expect(config.server).toMatchObject({
      host: "0.0.0.0",
      port: 5999,
      strictPort: true,
    });
    expect(buildConfig({}).server).toMatchObject({
      host: "127.0.0.1",
      port: 5173,
    });
  });
});

describe("production build", () => {
  it("has index.html and the boot script as its only entries, so the dev preview is never built", () => {
    const input = buildConfig({}).build?.rolldownOptions?.input;
    expect(Object.keys(input as Record<string, string>)).toEqual([
      "index",
      "boot",
    ]);
    expect(String((input as Record<string, string>).index)).toMatch(
      /frontend\/index\.html$/,
    );
  });

  it("writes hidden source maps", () => {
    expect(buildConfig({}).build?.sourcemap).toBe("hidden");
  });
});

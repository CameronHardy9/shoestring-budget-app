import { describe, expect, it } from "vitest";
import { createLogger } from "../logging.ts";
import { parseDevice } from "./device.ts";
import {
  HashQueue,
  PasswordService,
  createBreachChecker,
  inBundledList,
} from "./passwords.ts";

const silent = createLogger({ logLevel: "silent", release: "t" });

describe("argon2id", () => {
  it("hashes with argon2id m=19456 t=2 p=1 and verifies", async () => {
    const p = new PasswordService({ isBreached: () => Promise.resolve(false) });
    const h = await p.hash("correct horse battery");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await p.verify(h, "correct horse battery")).toBe(true);
    expect(await p.verify(h, "wrong")).toBe(false);
    expect(await p.verify("not a hash", "x")).toBe(false);
    expect(await p.verifyDummy("anything")).toBe(false);
    expect(p.needsRehash(h)).toBe(false);
    expect(p.needsRehash("$argon2id$v=19$m=4096,t=2,p=1$c29tZXNhbHQ$abc")).toBe(
      true,
    );
    expect(p.needsRehash("$2b$10$bcrypt")).toBe(true);
  }, 20_000);
});

describe("hashing queue (F-15)", () => {
  it("runs at most N at once and answers 503 UNAVAILABLE (Retry-After 2) after the wait limit", async () => {
    const q = new HashQueue(2, 50);
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const job = () =>
      q.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running--;
        return "done";
      });
    const a = job();
    const b = job();
    await expect(job()).rejects.toMatchObject({ code: "UNAVAILABLE", retryAfterSeconds: 2 });
    expect(peak).toBe(2);
    const waiting = job(); // queued behind a and b
    gates.shift()!();
    expect(await a).toBe("done");
    await new Promise((r) => setTimeout(r, 0));
    gates.splice(0).forEach((g) => g());
    expect(await b).toBe("done");
    await new Promise((r) => setTimeout(r, 0));
    gates.splice(0).forEach((g) => g());
    expect(await waiting).toBe("done");
    expect(peak).toBe(2);
  });
});

describe("password policy", () => {
  it("refuses the email as password and breached passwords", async () => {
    const p = new PasswordService({
      isBreached: (x) => Promise.resolve(x === "breached one!!"),
    });
    await expect(
      p.assertAcceptable("Pat@Example.test", "pat@example.test", {
        in: "body",
        field: "password",
      }),
    ).rejects.toMatchObject({
      details: [{ field: "password", issue: "invalid_value" }],
    });
    await expect(
      p.assertAcceptable("breached one!!", "pat@example.test", {
        in: "body",
        field: "newPassword",
      }),
    ).rejects.toMatchObject({
      details: [{ field: "newPassword", issue: "breached_password" }],
    });
    await expect(
      p.assertAcceptable("fine password!", "pat@example.test", {
        in: "body",
        field: "password",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("breached-password check (HIBP range API)", () => {
  const sha1Suffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"; // SHA-1("password") minus "5BAA6"

  it("sends only the 5-character prefix, with Add-Padding, and matches the suffix", async () => {
    const urls: string[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["Add-Padding"]).toBe(
        "true",
      );
      return Promise.resolve(
        new Response(
          `0000000000000000000000000000000000A:0\r\n${sha1Suffix}:3861493\r\n`,
        ),
      );
    }) as typeof fetch;
    const check = createBreachChecker({
      enabled: true,
      logger: silent,
      fetch: fakeFetch,
    });
    expect(await check("password")).toBe(true);
    expect(urls).toEqual(["https://api.pwnedpasswords.com/range/5BAA6"]);
  });

  it("ignores padding rows with count 0", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(`${sha1Suffix}:0\r\n`),
      )) as unknown as typeof fetch;
    expect(
      await createBreachChecker({
        enabled: true,
        logger: silent,
        fetch: fakeFetch,
      })("password"),
    ).toBe(false);
  });

  it("falls back to the bundled list when the API fails, is too large, or is disabled", async () => {
    const failing = (() =>
      Promise.reject(new Error("down"))) as unknown as typeof fetch;
    const huge = (() =>
      Promise.resolve(
        new Response("A".repeat(1024 * 1024 + 10)),
      )) as unknown as typeof fetch;
    for (const f of [failing, huge]) {
      const check = createBreachChecker({
        enabled: true,
        logger: silent,
        fetch: f,
      });
      expect(await check("password1234")).toBe(true);
      expect(await check("a perfectly fine passphrase")).toBe(false);
    }
    const off = createBreachChecker({
      enabled: false,
      logger: silent,
      fetch: failing,
    });
    expect(await off("Password1234")).toBe(true);
    expect(inBundledList("QWERTYUIOP12")).toBe(true);
  });
});

describe("device vocabulary (F-20)", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "safari",
      "ios",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
      "chrome",
      "ipados",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
      "chrome",
      "android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36",
      "samsung_internet",
      "android",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
      "edge",
      "windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:120.0) Gecko/20100101 Firefox/120.0",
      "firefox",
      "macos",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "chrome",
      "chromeos",
    ],
    ["curl/8.4.0", "other", "other"],
    ["", "unknown", "unknown"],
  ])("%s", (ua, browser, os) => {
    expect(parseDevice(ua)).toEqual({ browser, os });
  });
});

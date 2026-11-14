import { describe, expect, it } from "vitest";
import { createAppClock } from "../clock.ts";
import { parseKeyring } from "../crypto/keyring.ts";
import { Throttles } from "../http/rate-limit.ts";
import { createLogger } from "../logging.ts";
import {
  fakeThrottles,
  strictDal,
  testKeyring,
} from "../test-support/harness.ts";
import { Mailer } from "./mailer.ts";
import { Notifications, safeUserText } from "./notifications.ts";
import { ConsoleTransport, Outbox, ResendTransport } from "./transports.ts";
import type { EmailTransport, OutgoingEmail } from "./transports.ts";

const n = new Notifications("https://app.test");
const silent = createLogger({ logLevel: "silent", release: "t" });

function mailer(transport: EmailTransport, quota = 10) {
  const clock = createAppClock();
  const t = fakeThrottles();
  const throttles = new Throttles(
    strictDal({ throttles: t.dal }),
    parseKeyring(testKeyring()),
    clock,
  );
  return new Mailer({
    transport,
    throttles,
    clock,
    logger: silent,
    dailyQuota: quota,
    timeoutMs: 50,
  });
}

const msg = (priority: boolean): OutgoingEmail => ({
  to: "a@example.test",
  subject: "s",
  text: "t",
  kind: "new_sign_in",
  priority,
  links: [],
});

describe("daily email budget (F-09)", () => {
  it("past 60% only priority mail goes out; at 100% nothing", async () => {
    const out = new Outbox(() => new Date());
    const m = mailer(out, 10);
    const results: string[] = [];
    for (let i = 0; i < 6; i++) results.push(await m.send(msg(false)));
    results.push(await m.send(msg(false)));
    for (let i = 0; i < 4; i++) results.push(await m.send(msg(true)));
    results.push(await m.send(msg(true)));
    expect(results).toEqual([
      ...Array<string>(6).fill("sent"),
      "dropped",
      ...Array<string>(4).fill("sent"),
      "dropped",
    ]);
    expect(out.list()).toHaveLength(10);
  });

  it("a failing or slow provider never throws into the request", async () => {
    const failing: EmailTransport = {
      name: "provider",
      send: () => Promise.reject(new Error("boom")),
    };
    expect(await mailer(failing).send(msg(true))).toBe("failed");
    const slow: EmailTransport = {
      name: "provider",
      send: (_m, signal) =>
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    };
    expect(await mailer(slow).send(msg(true))).toBe("failed");
  });
});

describe("Resend transport", () => {
  it("posts plain text with the API key, and maps HTTP errors", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const f = ((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(new Response("{}", { status }));
    }) as typeof fetch;
    const t = new ResendTransport(
      "re_key",
      "Shoestring <x@mail.example.com>",
      f,
    );
    await t.send(msg(true), AbortSignal.timeout(1000));
    expect(seen[0]!.url).toBe("https://api.resend.com/emails");
    expect(
      (seen[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer re_key");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      from: "Shoestring <x@mail.example.com>",
      to: ["a@example.test"],
      subject: "s",
      text: "t",
    });
    status = 422;
    await expect(
      t.send(msg(true), AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("notification content (F-29)", () => {
  it("F-48: NFKC first, dot look-alikes defanged, bidi controls stripped; output never parses as a host", () => {
    const evil = safeUserText("Verify at shoestring-help。com", 60);
    expect(evil).toBe("Verify at shoestring-help⸱com");
    for (const dot of ["。", "．", "｡", "﹒", "."]) {
      const out = safeUserText(`evil${dot}com`, 60);
      expect([dot, out]).toEqual([dot, "evil⸱com"]);
      // Neither the browser URL parser nor NFKC turns the result back into a dot.
      let host: string | null;
      try {
        host = new URL(`http://${out}/`).hostname;
      } catch {
        host = null;
      }
      expect(host === null || !host.includes(".")).toBe(true);
      expect(out.normalize("NFKC")).not.toContain(".");
    }
    expect(safeUserText("Ａｂｃ＠x", 60)).toBe("Abc(at)x"); // full-width forms
    expect(safeUserText("Ali\u202eecnalab\u202c", 60)).toBe("Aliecnalab"); // a U+202E name
    for (const b of ["\u061c", "\u200e", "\u200f", "\u202a", "\u202d", "\u2066", "\u2069"])
      expect(safeUserText(`a${b}b`, 60)).toBe("ab");
    expect(safeUserText("http://x:1", 60)).not.toMatch(/[:/]/);
  });

  it("defangs and caps user text: no links, no line breaks", () => {
    const s = safeUserText("evil.com/x\nBcc: a@b.c http://x", 60);
    expect(s).not.toMatch(/[.\n/@:]/);
    expect(safeUserText("x".repeat(80), 60)).toHaveLength(60);
  });

  it("builds every link from APP_ORIGIN and keeps tokens in the fragment", () => {
    const m = n.signupInvite(
      "a@example.test",
      "TOKEN123",
      new Date("2026-11-20T00:00:00Z"),
    );
    expect(m.links).toEqual(["https://app.test/signup#token=TOKEN123"]);
    expect(m.text).toContain(m.links[0]);
    expect(m.priority).toBe(true);
  });

  it("budget mail carries the escaped budget name and no amounts", () => {
    const m = n.budgetInvitation(
      "b@example.test",
      "Olive",
      "Smith.Family/Budget",
    );
    expect(m.text).toContain("Smith\u2e31Family\u2215Budget");
    expect(m.priority).toBe(false);
  });

  it("the console transport writes the message to stderr, not the JSON log", async () => {
    const out: string[] = [];
    await new ConsoleTransport((s) => out.push(s)).send(msg(false));
    expect(out.join("")).toContain("To: a@example.test");
  });
});

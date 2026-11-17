import { describe, expect, it } from "vitest";
import { createAppClock } from "../clock.ts";
import type { AppClock } from "../clock.ts";
import { parseKeyring } from "../crypto/keyring.ts";
import { Throttles } from "../http/rate-limit.ts";
import { createLogger } from "../logging.ts";
import {
  fakeThrottles,
  slowThrottles,
  strictDal,
  testKeyring,
} from "../test-support/harness.ts";
import { Mailer } from "./mailer.ts";
import type { MailerOptions } from "./mailer.ts";
import { ALERTS } from "../observability/error-tracker.ts";
import type { Alert } from "../observability/error-tracker.ts";
import { Notifications, safeUserText } from "./notifications.ts";
import { ConsoleTransport, Outbox, ResendTransport } from "./transports.ts";
import type { EmailTransport, OutgoingEmail } from "./transports.ts";

const n = new Notifications("https://app.test");
const silent = createLogger({ logLevel: "silent", release: "t" });

function mailer(
  transport: EmailTransport,
  quota = 10,
  t: { dal: ReturnType<typeof fakeThrottles>["dal"] } = fakeThrottles(),
  o: { alerts?: MailerOptions["alerts"]; clock?: AppClock } = {},
) {
  const clock = o.clock ?? createAppClock();
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
    ...(o.alerts ? { alerts: o.alerts } : {}),
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

describe("daily email budget under concurrency (reserve-first)", () => {
  const sentCount = (rs: string[]) => rs.filter((r) => r === "sent").length;
  const total = (rows: Map<string, number>) =>
    [...rows.values()].reduce((a, b) => a + b, 0);

  it("a burst of bulk mail stops at 60%, and priority mail still gets the rest up to 100%", async () => {
    const out = new Outbox(() => new Date());
    const t = slowThrottles();
    const m = mailer(out, 10, t);
    const bulk = await Promise.all(
      Array.from({ length: 20 }, () => m.send(msg(false))),
    );
    expect(sentCount(bulk)).toBe(6);
    expect(bulk.filter((r) => r !== "sent").every((r) => r === "dropped")).toBe(true);
    expect(total(t.rows)).toBe(6); // dropped mail holds no slot
    const priority = await Promise.all(
      Array.from({ length: 20 }, () => m.send(msg(true))),
    );
    expect(sentCount(priority)).toBe(4);
    expect(out.list()).toHaveLength(10);
    expect(total(t.rows)).toBe(10);
  });

  it("mixed bursts never exceed the quota, and bulk never exceeds 60%", async () => {
    const out = new Outbox(() => new Date());
    const t = slowThrottles();
    const m = mailer(out, 10, t);
    const sends = Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0));
    const rs = await Promise.all(sends.map((s) => m.send(s)));
    expect(sentCount(rs)).toBeLessThanOrEqual(10);
    expect(
      rs.filter((r, i) => r === "sent" && !sends[i]!.priority).length,
    ).toBeLessThanOrEqual(6);
    expect(out.list()).toHaveLength(sentCount(rs));
    expect(total(t.rows)).toBe(sentCount(rs));
    expect([...t.rows.values()].every((n) => n >= 0)).toBe(true);
  });

  it("a send the provider fails keeps its slot (the quota errs on the safe side)", async () => {
    let calls = 0;
    const flaky: EmailTransport = {
      name: "provider",
      send: () =>
        ++calls <= 2 ? Promise.reject(new Error("boom")) : Promise.resolve(),
    };
    const t = fakeThrottles();
    const m = mailer(flaky, 3, t);
    expect(await m.send(msg(true))).toBe("failed");
    expect(await m.send(msg(true))).toBe("failed");
    expect(await m.send(msg(true))).toBe("sent");
    expect(await m.send(msg(true))).toBe("dropped");
    expect(calls).toBe(3);
  });

  it("an unavailable budget store fails closed without sending", async () => {
    let sent = 0;
    const out: EmailTransport = {
      name: "provider",
      send: () => {
        sent++;
        return Promise.resolve();
      },
    };
    const broken = fakeThrottles();
    broken.dal.hitThrottle = () => Promise.reject(new Error("db down"));
    expect(await mailer(out, 10, broken).send(msg(true))).toBe("failed");
    const unreadable = fakeThrottles();
    unreadable.dal.sumThrottle = () => Promise.reject(new Error("db down"));
    expect(await mailer(out, 10, unreadable).send(msg(true))).toBe("failed");
    expect(sent).toBe(0);
  });
});

describe("A6 email quota alerts (one-shot per UTC day)", () => {
  const recorder = () => {
    const seen: Alert[] = [];
    return { seen, alerts: { enabled: true, alert: (a: Alert) => seen.push(a) } };
  };

  it("a concurrent burst raises exactly one warning at 80% and one error at 100%", async () => {
    const out = new Outbox(() => new Date());
    const r = recorder();
    const m = mailer(out, 10, slowThrottles(), { alerts: r.alerts });
    const rs = await Promise.all(Array.from({ length: 25 }, () => m.send(msg(true))));
    expect(rs.filter((x) => x === "sent")).toHaveLength(10);
    expect(r.seen).toEqual([ALERTS.emailQuotaWarning, ALERTS.emailQuotaReached]);
  });

  it("fires on the send that reaches the line, never before, and never twice the same day", async () => {
    const r = recorder();
    const m = mailer(new Outbox(() => new Date()), 10, fakeThrottles(), { alerts: r.alerts });
    for (let i = 0; i < 7; i++) await m.send(msg(true));
    expect(r.seen).toEqual([]);
    await m.send(msg(true)); // 8th of 10 = 80%
    expect(r.seen).toEqual([ALERTS.emailQuotaWarning]);
    await m.send(msg(true));
    expect(r.seen).toHaveLength(1);
    await m.send(msg(true)); // 10th = 100%
    expect(r.seen).toEqual([ALERTS.emailQuotaWarning, ALERTS.emailQuotaReached]);
    expect(await m.send(msg(true))).toBe("dropped");
    expect(r.seen).toHaveLength(2);
  });

  it("a send the provider fails still counts toward the thresholds", async () => {
    const r = recorder();
    const failing: EmailTransport = { name: "provider", send: () => Promise.reject(new Error("boom")) };
    const m = mailer(failing, 5, fakeThrottles(), { alerts: r.alerts });
    for (let i = 0; i < 4; i++) expect(await m.send(msg(true))).toBe("failed");
    expect(r.seen).toEqual([ALERTS.emailQuotaWarning]); // ceil(0.8 * 5) = 4
  });

  it("the next UTC day alerts again", async () => {
    const r = recorder();
    const clock = createAppClock();
    clock.freeze(new Date("2026-11-16T23:00:00.000Z"));
    const m = mailer(new Outbox(() => new Date()), 5, fakeThrottles(), { alerts: r.alerts, clock });
    for (let i = 0; i < 5; i++) await m.send(msg(true));
    expect(r.seen).toHaveLength(2);
    clock.freeze(new Date("2026-11-17T01:00:00.000Z"));
    for (let i = 0; i < 5; i++) await m.send(msg(true));
    expect(r.seen).toEqual([
      ALERTS.emailQuotaWarning,
      ALERTS.emailQuotaReached,
      ALERTS.emailQuotaWarning,
      ALERTS.emailQuotaReached,
    ]);
  });

  it("with tracking off no one-shot slot is spent, so a later tracked send still alerts", async () => {
    const t = fakeThrottles();
    const clock = createAppClock();
    clock.freeze(new Date("2026-11-16T12:00:00.000Z"));
    const off = mailer(new Outbox(() => new Date()), 10, t, { alerts: { enabled: false, alert: () => { throw new Error("must not be called"); } }, clock });
    for (let i = 0; i < 9; i++) await off.send(msg(true));
    expect(t.rows.size).toBe(1); // only email:daily
    const r = recorder();
    const on = mailer(new Outbox(() => new Date()), 10, t, { alerts: r.alerts, clock });
    await on.send(msg(true));
    expect(r.seen).toEqual([ALERTS.emailQuotaWarning, ALERTS.emailQuotaReached]);
  });

  it("an unavailable alert store never breaks the send", async () => {
    const r = recorder();
    const t = fakeThrottles();
    const real = t.dal.hitThrottle;
    let calls = 0;
    t.dal.hitThrottle = (...a: Parameters<typeof real>) =>
      ++calls > 1 ? Promise.reject(new Error("db down")) : real(...a);
    const m = mailer(new Outbox(() => new Date()), 1, t, { alerts: r.alerts });
    expect(await m.send(msg(true))).toBe("sent");
    expect(r.seen).toEqual([]);
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

// F-09 regression (auth.md §14 password-reset-request rows): reset mails per
// ADDRESS are capped at 3 per hour and 5 per rolling 24 h, silently (the answer
// stays 202, so nothing is revealed), whichever IP asks; and each IP may ask 5
// times an hour (429). Together they keep an attacker who rotates IPs from
// draining the email quota through one victim's address.
// Every request here answers at a fixed 1 s (F-22), so the calls are few. The
// per-address rows reserve first (count, compare, refund a refused attempt;
// F-57), so they hold under concurrency too; the per-address test still runs
// sequentially because it checks the limits, not that race. Owner of a
// failure: backend-engineer.
import { describe, expect, it } from "vitest";
import { createUser } from "../../support/factories.ts";
import { ApiClient, codeOf } from "../../support/http.ts";
import { advanceClock, emails, HOUR } from "../../support/hooks.ts";

let ipCounter = 0;
/** A request from a fresh client IP each time (via the e2e edge), as an IP-rotating attacker would send. */
async function resetFromNewIp(email: string) {
  const ip = `198.51.100.${String(++ipCounter)}`;
  const res = await new ApiClient(`ip-${ip}`, { clientIp: ip }).post(
    "/auth/password-reset/request",
    { email },
  );
  return res;
}

async function resetMails(email: string): Promise<number> {
  return (await emails(email)).filter((e) => e.kind === "password_reset")
    .length;
}

describe("F-09: password-reset requests are limited per address and per IP", () => {
  it("per address: 3 mails an hour and 5 per 24 h, from any IP, then silent 202s that look the same", async () => {
    const victim = await createUser({ prefix: "victim" });
    const answers: string[] = [];
    const ask = async () => {
      const res = await resetFromNewIp(victim.email);
      expect(res.status, res.describe).toBe(202);
      answers.push(res.text);
    };

    for (let i = 0; i < 4; i++) await ask();
    expect(await resetMails(victim.email), "3 per hour, from 4 IPs").toBe(3);

    await advanceClock(HOUR);
    for (let i = 0; i < 2; i++) await ask();
    expect(
      await resetMails(victim.email),
      "the hour row opened again: 2 more",
    ).toBe(5);

    await advanceClock(HOUR);
    await ask();
    expect(
      await resetMails(victim.email),
      "5 per rolling 24 h: the 6th mail is dropped although the hour row is open",
    ).toBe(5);

    // 24 h after the first burst its hour bucket has left the rolling window.
    await advanceClock(22 * HOUR);
    await ask();
    expect(await resetMails(victim.email)).toBe(6);

    expect(
      new Set(answers).size,
      "a silent (limited) answer must be indistinguishable from a sent one",
    ).toBe(1);
  });

  it("per IP: the 6th request in an hour is 429 with Retry-After; another IP is not limited", async () => {
    const ip = new ApiClient("one-ip", { clientIp: "203.0.113.50" });
    // Different, unknown addresses, so only the IP row can trip. The IP row
    // is an atomic counter, so these may run together.
    const first = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        ip.post("/auth/password-reset/request", {
          email: `probe-${String(i)}@example.test`,
        }),
      ),
    );
    expect(first.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    const sixth = await ip.post("/auth/password-reset/request", {
      email: "probe-6@example.test",
    });
    expect([sixth.status, codeOf(sixth)]).toEqual([429, "RATE_LIMITED"]);
    const retryAfter = Number(sixth.header("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    const other = await new ApiClient("other-ip", {
      clientIp: "203.0.113.51",
    }).post("/auth/password-reset/request", {
      email: "probe-6@example.test",
    });
    expect(other.status).toBe(202);

    // The window is the app clock's hour.
    await advanceClock(HOUR);
    expect(
      (
        await ip.post("/auth/password-reset/request", {
          email: "probe-7@example.test",
        })
      ).status,
    ).toBe(202);
  });
});

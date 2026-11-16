// F-21 regression (auth.md §14 login rows): failed logins lock the (email, IP)
// pair, IPv6 by /64, so an attacker cannot lock the owner out from another
// network; the per-email ceiling (100 / 24 h) is the only email-wide lock; and
// a successful password reset clears the email counter and the pair counter
// of the IP that completed it.
// Different client IPs come from the e2e edge (support/http.ts `clientIp`);
// the stack trusts exactly that one hop (F-08). Owner of a failure:
// backend-engineer (or ci-engineer if every IP-dependent test fails at once:
// the edge or TRUST_PROXY_HOPS changed).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser } from "../../support/factories.ts";
import type { TestUser } from "../../support/factories.ts";
import { ApiClient, codeOf } from "../../support/http.ts";
import { emails, lastEmail, tokenFromLink } from "../../support/hooks.ts";

const PAIR_FAILURES = 10; // per (email, IP) / 15 min
const EMAIL_FAILURES = 100; // per email / rolling 24 h

const from = (ip: string) => new ApiClient(`ip-${ip}`, { clientIp: ip });

async function login(ip: string, email: string, password: string) {
  return from(ip).post("/auth/login", { email, password });
}

async function failFrom(ip: string, user: TestUser, times: number) {
  for (let i = 0; i < times; i++) {
    const r = await login(ip, user.email, "definitely wrong");
    expect(codeOf(r), `${ip} failure ${String(i + 1)}`).toBe(
      "INVALID_CREDENTIALS",
    );
  }
}

/** Password reset requested and completed from `ip`; returns the new password. */
async function resetFrom(ip: string, user: TestUser): Promise<string> {
  const c = from(ip);
  expect(
    (await c.post("/auth/password-reset/request", { email: user.email }))
      .status,
  ).toBe(202);
  const token = tokenFromLink(
    (await lastEmail(user.email, "password_reset")).links[0]!,
  );
  const newPassword = `pw-${randomUUID()}`;
  const done = await c.post("/auth/password-reset/complete", {
    token,
    newPassword,
  });
  expect(done.status, done.describe).toBe(204);
  return newPassword;
}

describe("F-21: login lockout is keyed on (email, IP), and a reset clears it", () => {
  it("10 failures from one IP lock only that pair: the owner still signs in from another IP", async () => {
    const victim = await createUser({ prefix: "victim" });
    await failFrom("203.0.113.66", victim, PAIR_FAILURES);
    const locked = await login("203.0.113.66", victim.email, victim.password);
    expect(
      [locked.status, codeOf(locked)],
      "the attacker's pair is locked even with the right password",
    ).toEqual([429, "RATE_LIMITED"]);

    const owner = await login("192.0.2.10", victim.email, victim.password);
    expect(owner.status, `the owner on another IP: ${owner.describe}`).toBe(
      200,
    );
  });

  it("an IPv6 pair is keyed by the /64: rotating inside it stays locked, the next /64 is not", async () => {
    const victim = await createUser({ prefix: "victim6" });
    for (let i = 0; i < PAIR_FAILURES; i++)
      expect(
        codeOf(
          await login(
            `2001:db8:66:1::${(i + 1).toString(16)}`,
            victim.email,
            "definitely wrong",
          ),
        ),
      ).toBe("INVALID_CREDENTIALS");
    const sameNet = await login(
      "2001:db8:66:1:ffff::1",
      victim.email,
      victim.password,
    );
    expect([sameNet.status, codeOf(sameNet)]).toEqual([429, "RATE_LIMITED"]);
    const nextNet = await login(
      "2001:db8:66:2::1",
      victim.email,
      victim.password,
    );
    expect(nextNet.status, nextNet.describe).toBe(200);
  });

  it("a successful reset clears the pair counter of the IP that completed it", async () => {
    const user = await createUser({ prefix: "forgetful" });
    const ip = "203.0.113.70";
    await failFrom(ip, user, PAIR_FAILURES);
    expect(codeOf(await login(ip, user.email, user.password))).toBe(
      "RATE_LIMITED",
    );

    const newPassword = await resetFrom(ip, user);
    const after = await login(ip, user.email, newPassword);
    expect(
      after.status,
      `the same IP signs in at once after the reset (same frozen 15-minute window): ${after.describe}`,
    ).toBe(200);
  });

  it("100 failures from many IPs lock the email everywhere (login_throttled); a successful reset clears that counter", async () => {
    const user = await createUser({ prefix: "besieged" });
    // 10 IPs × 10 failures: no pair is ever over its limit, so only the
    // per-email ceiling can lock the account.
    for (let n = 0; n < EMAIL_FAILURES / PAIR_FAILURES; n++)
      await failFrom(`198.51.100.${String(n + 1)}`, user, PAIR_FAILURES);
    expect(
      (await emails(user.email)).filter((e) => e.kind === "login_throttled"),
    ).toHaveLength(1);

    const fresh = "192.0.2.77";
    const blocked = await login(fresh, user.email, user.password);
    expect(
      [blocked.status, codeOf(blocked)],
      "a fresh IP is locked out too once the email ceiling is reached",
    ).toEqual([429, "RATE_LIMITED"]);

    const newPassword = await resetFrom(fresh, user);
    const after = await login("192.0.2.78", user.email, newPassword);
    expect(
      after.status,
      `the email counter is cleared, so any IP signs in: ${after.describe}`,
    ).toBe(200);
  });
});

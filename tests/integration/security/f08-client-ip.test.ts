// F-08 regression (auth.md §14 "Client IP"): the client IP is the address the
// platform edge appends to X-Forwarded-For. The backend trusts exactly one hop
// (TRUST_PROXY_HOPS=1 in the e2e stack), so a client-supplied, leftmost
// X-Forwarded-For entry never changes the derived IP: not the rate-limit
// bucket, not security_events.ip. IPv4 keys are the full address, IPv6 keys
// the /64 prefix.
//
// The e2e edge (.github/scripts/e2e-edge.mjs) plays the platform's front end:
// it appends either the TCP peer or, when a test sends X-E2E-Client-IP, that
// address (support/http.ts `clientIp`). Everything a test puts in
// X-Forwarded-For stays to the left of the edge's entry.
// A failure here means the backend's proxy trust (backend-engineer) or the
// e2e topology (ci-engineer: docker-compose.test.yml, the edge) changed.
import { describe, expect, it } from "vitest";
import { adminQuery } from "../../support/db-locks.ts";
import { createUser } from "../../support/factories.ts";
import { ApiClient, codeOf } from "../../support/http.ts";

const LOGIN_IP_LIMIT = 20; // auth.md §14 login row: 20 attempts / 15 min per IP
const GLOBAL_LIMIT = 300; // auth.md §14 global row: 300 requests / minute per IP

/** A different forged X-Forwarded-For for every attempt, as an attacker rotating IPs would send. */
const forged = (i: number) => ({
  "x-forwarded-for": `198.51.100.${String(i % 250)}, 10.${String(i % 250)}.0.1`,
});

async function failedLogin(c: ApiClient, i: number, ip?: string) {
  return c.post(
    "/auth/login",
    { email: `nobody-${String(i)}@example.test`, password: "wrong password" },
    { headers: forged(i), ...(ip ? { clientIp: ip } : {}) },
  );
}

async function eventIps(userId: string, type: string): Promise<string[]> {
  const rows = await adminQuery<{ ip: string | null }>(
    "select host(ip) as ip from security_events where user_id = $1 and type = $2 order by created_at, id",
    [userId, type],
  );
  return rows.map((r) => r.ip ?? "(null)");
}

describe("F-08: a forged X-Forwarded-For never changes the derived client IP", () => {
  it("the login limit (20 attempts / 15 min per IP) trips although every attempt forges a new leftmost X-Forwarded-For", async () => {
    const attacker = new ApiClient("attacker", { clientIp: "203.0.113.10" });
    for (let i = 0; i < LOGIN_IP_LIMIT; i++)
      expect(
        codeOf(await failedLogin(attacker, i)),
        `attempt ${String(i + 1)}`,
      ).toBe("INVALID_CREDENTIALS");
    const limited = await failedLogin(attacker, 99);
    expect(
      [limited.status, codeOf(limited)],
      "the 21st attempt from the same edge address must be limited; if it is not, the backend keys on a forged X-Forwarded-For entry",
    ).toEqual([429, "RATE_LIMITED"]);

    // The bucket is the edge's address: a neighbour is not limited, even when
    // it forges the limited address in X-Forwarded-For.
    const neighbour = await new ApiClient("neighbour", {
      clientIp: "203.0.113.11",
    }).post(
      "/auth/login",
      { email: "someone@example.test", password: "wrong password" },
      { headers: { "x-forwarded-for": "203.0.113.10" } },
    );
    expect(codeOf(neighbour)).toBe("INVALID_CREDENTIALS");
  });

  it("the in-memory global limit (300 / minute per IP) trips although every request forges X-Forwarded-For", async () => {
    const c = new ApiClient("flooder", { clientIp: "203.0.113.30" });
    let n = 0;
    while ((await c.get("/healthz", { headers: forged(n) })).status !== 429) {
      n++;
      expect(
        n,
        "never limited: the global limiter keys on a forged entry",
      ).toBeLessThanOrEqual(GLOBAL_LIMIT);
    }
    expect(n).toBe(GLOBAL_LIMIT);
    const other = await new ApiClient("other", {
      clientIp: "203.0.113.31",
    }).get("/healthz");
    expect(other.status).toBe(200);
  });

  it("security_events.ip is the edge's entry (IPv4 and IPv6), never a forged one", async () => {
    const user = await createUser({ prefix: "traced" });
    const lie = { "x-forwarded-for": "198.51.100.66, 10.9.8.7" };

    const v6 = new ApiClient("v6", { clientIp: "2001:db8:1:2::abcd" });
    const failed = await v6.post(
      "/auth/login",
      { email: user.email, password: "wrong password" },
      { headers: lie },
    );
    expect(codeOf(failed)).toBe("INVALID_CREDENTIALS");

    const v4 = new ApiClient("v4", { clientIp: "203.0.113.20" });
    const ok = await v4.post(
      "/auth/login",
      { email: user.email, password: user.password },
      { headers: lie },
    );
    expect(ok.status, ok.describe).toBe(200);

    // Without an override the edge appends its TCP peer (the Docker gateway,
    // which differs between machines, so it is not hard-coded here).
    const plain = await new ApiClient("plain").post(
      "/auth/login",
      { email: user.email, password: "wrong again" },
      { headers: lie },
    );
    expect(codeOf(plain)).toBe("INVALID_CREDENTIALS");

    expect(await eventIps(user.userId, "login_succeeded")).toEqual([
      "203.0.113.20",
    ]);
    const failures = await eventIps(user.userId, "login_failed");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe("2001:db8:1:2::abcd");
    expect(failures[1]).not.toBe("(null)");
    const forgedRows = await adminQuery<{ n: number }>(
      "select count(*)::int as n from security_events where ip in ('198.51.100.66', '10.9.8.7')",
    );
    expect(
      forgedRows[0]!.n,
      "a forged X-Forwarded-For entry reached security_events",
    ).toBe(0);
  });

  it("IPv6 clients share one bucket per /64: the login limit trips across addresses in one /64, not in the next", async () => {
    const inPrefix = [
      "2001:db8:a:b::1",
      "2001:db8:a:b:ffff:ffff:ffff:fffe",
      "2001:db8:a:b:1234::42",
    ];
    const c = new ApiClient("v6-rotator");
    for (let i = 0; i < LOGIN_IP_LIMIT; i++)
      expect(
        codeOf(await failedLogin(c, i, inPrefix[i % inPrefix.length])),
        `attempt ${String(i + 1)}`,
      ).toBe("INVALID_CREDENTIALS");
    const limited = await failedLogin(c, 98, "2001:db8:a:b::99");
    expect(
      [limited.status, codeOf(limited)],
      "a new address in the same /64 must share the bucket",
    ).toEqual([429, "RATE_LIMITED"]);
    expect(codeOf(await failedLogin(c, 97, "2001:db8:a:c::1"))).toBe(
      "INVALID_CREDENTIALS",
    );
  });
});

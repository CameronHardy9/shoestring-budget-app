// F-22 regression (auth.md §14 "Enumeration timing"): password-reset request
// and email-change request answer at a fixed 1 s measured from the start of
// the request, whether or not the address has an account. (Budget-invitation
// create is timed in integration/invitations.test.ts.)
//
// Made robust rather than precise:
//   - every sample must take at least ~1 s (the pad is a floor, whatever the
//     load), which is what catches a missing pad;
//   - the MEDIANS of the known and unknown groups must be within 250 ms, a
//     generous bound against the known path's extra work (token, event, mail);
//   - each group is several samples launched together and interleaved, so
//     machine noise hits both groups alike and the test costs ~1 s, not 12;
//   - the extra work is proven to have happened (the mails were sent), so a
//     fast "known" path cannot pass by skipping it.
// Owner of a failure: backend-engineer (routes/common.ts padUntil).
import { describe, expect, it } from "vitest";
import { createUser, uniqueEmail } from "../../support/factories.ts";
import type { TestUser } from "../../support/factories.ts";
import { ApiClient } from "../../support/http.ts";
import type { ApiResponse } from "../../support/http.ts";
import { emails, testLogin } from "../../support/hooks.ts";

const SAMPLES = 6; // per group
const PAD_FLOOR_MS = 950; // the 1 s pad, less clock granularity
const MAX_MEDIAN_GAP_MS = 250;
const MAX_MEDIAN_MS = 2_000; // "fixed 1 s", generously

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function timed(call: () => Promise<ApiResponse>): Promise<number> {
  const t = performance.now();
  const res = await call();
  const ms = performance.now() - t;
  expect(res.status, res.describe).toBe(202);
  return ms;
}

/** Runs both groups together, interleaved, and checks floor, ceiling and median gap. */
async function expectSameTiming(
  known: (() => Promise<ApiResponse>)[],
  unknown: (() => Promise<ApiResponse>)[],
): Promise<void> {
  const order = known.flatMap((k, i) => [
    { group: "known", call: k },
    { group: "unknown", call: unknown[i]! },
  ]);
  const results = await Promise.all(
    order.map(async (o) => ({ group: o.group, ms: await timed(o.call) })),
  );
  const k = results.filter((r) => r.group === "known").map((r) => r.ms);
  const u = results.filter((r) => r.group === "unknown").map((r) => r.ms);
  const summary = `known ${k.map(Math.round).join("/")} ms, unknown ${u.map(Math.round).join("/")} ms`;
  for (const ms of [...k, ...u])
    expect(
      ms,
      `every answer waits for the 1 s pad (${summary})`,
    ).toBeGreaterThanOrEqual(PAD_FLOOR_MS);
  expect(
    Math.abs(median(k) - median(u)),
    `median gap between known and unknown addresses (${summary})`,
  ).toBeLessThan(MAX_MEDIAN_GAP_MS);
  expect(Math.max(median(k), median(u)), summary).toBeLessThan(MAX_MEDIAN_MS);
}

const users = (prefix: string) =>
  Promise.all(
    Array.from({ length: SAMPLES }, (_, i) =>
      createUser({ prefix: `${prefix}${String(i)}` }),
    ),
  );

describe("F-22: no timing difference between known and unknown addresses", () => {
  it("password-reset request: an existing account and an unknown address both answer at the fixed 1 s", async () => {
    const known: TestUser[] = await users("known");
    const unknown = known.map((_, i) => uniqueEmail(`unknown${String(i)}`));
    // One client IP per sample: the per-IP row (5 / hour) must not answer 429.
    const ask = (email: string, n: number) => () =>
      new ApiClient(`ip-${String(n)}`, {
        clientIp: `198.51.100.${String(n)}`,
      }).post("/auth/password-reset/request", { email });

    await expectSameTiming(
      known.map((u, i) => ask(u.email, i + 1)),
      unknown.map((e, i) => ask(e, i + 101)),
    );

    for (const u of known)
      expect(
        (await emails(u.email)).map((e) => e.kind),
        "the known path did its work",
      ).toEqual(["password_reset"]);
    for (const e of unknown) expect(await emails(e)).toEqual([]);
  });

  it("email-change request: a taken address and a free one both answer at the fixed 1 s", async () => {
    // One change per user per 24 h (F-33), so every sample is its own user:
    // SAMPLES ask for a taken address, SAMPLES for a free one.
    const [askTaken, askFree, taken] = await Promise.all([
      users("mover"),
      users("drifter"),
      users("taken"),
    ]);
    const free = askFree.map((_, i) => uniqueEmail(`free${String(i)}`));
    const signedIn = (list: TestUser[]) =>
      Promise.all(list.map((u) => testLogin(u.email)));
    const [takenClients, freeClients] = await Promise.all([
      signedIn(askTaken),
      signedIn(askFree),
    ]);
    const changeTo = (c: ApiClient, newEmail: string) => () =>
      c.post("/me/email-change", { newEmail });

    await expectSameTiming(
      takenClients.map((c, i) => changeTo(c, taken[i]!.email)),
      freeClients.map((c, i) => changeTo(c, free[i]!)),
    );

    for (const t of taken)
      expect(
        (await emails(t.email)).map((e) => e.kind),
        "the taken-address path did its work",
      ).toEqual(["email_change_exists"]);
    for (const f of free)
      expect((await emails(f)).map((e) => e.kind)).toEqual([
        "email_change_confirm",
      ]);
  });
});

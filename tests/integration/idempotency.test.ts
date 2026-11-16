// Idempotency keys (D4 "retries are safe", data-model.md idempotency_keys,
// errors.md step 12): a retry with the same key and body replays the created
// resource's CURRENT state; the same key with another request is 422; keys are
// per user and live 24 h; concurrent duplicates create exactly one resource.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codeOf, detailsOf } from "../support/http.ts";
import { advanceClock, dal, HOUR } from "../support/hooks.ts";
import type { World } from "../support/world.ts";
import { seedWorld } from "../support/world.ts";

interface Tx {
  id: string;
  amountCents: number;
  version: number;
  memo: string | null;
}

const bodyFor = (w: World, amountCents = 4_200) => ({
  date: w.today,
  direction: "outflow",
  amountCents,
  payee: "Retry shop",
  splits: [{ categoryId: w.budget.categories.Groceries!, amountCents }],
});

async function count(w: World): Promise<number> {
  return (
    await dal().transactions.listTransactions(w.budget.scope, { limit: 100 })
  ).items.length;
}

describe("transaction create retries", () => {
  it("the same key and body replays 201 with Idempotent-Replayed: true and the same transaction, once", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const first = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.header("idempotent-replayed")).toBeUndefined();
    const again = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    expect(again.status).toBe(201);
    expect(again.header("idempotent-replayed")).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    expect(await count(w)).toBe(2); // the world's transaction + this one
  });

  it("a replay returns the transaction's current state, not the original response", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const first = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    await w.member.client.put(`${path}/${first.body.id}`, {
      ...bodyFor(w, 5_000),
      memo: "fixed",
      version: first.body.version,
    });
    const replay = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    expect(replay.body).toMatchObject({
      id: first.body.id,
      amountCents: 5_000,
      memo: "fixed",
      version: 2,
    });
  });

  it("the same key with a different body → 422 IDEMPOTENCY_KEY_REUSED (header, Idempotency-Key)", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    await w.owner.client.post(path, bodyFor(w), { idempotencyKey: key });
    const res = await w.owner.client.post(path, bodyFor(w, 4_201), {
      idempotencyKey: key,
    });
    expect([res.status, codeOf(res)]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({ in: "header", field: "Idempotency-Key" }),
    );
  });

  it("the same key reused for a budget create → 422 (method and path are part of the request)", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    await w.owner.client.post(
      `/budgets/${w.budget.id}/transactions`,
      bodyFor(w),
      { idempotencyKey: key },
    );
    const res = await w.owner.client.post(
      "/budgets",
      { name: "Other", timezone: "UTC" },
      { idempotencyKey: key },
    );
    expect([res.status, codeOf(res)]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
  });

  it("a replay of a since-deleted transaction is 404 NOT_FOUND", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const first = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    await w.owner.client.delete(`${path}/${first.body.id}`, {
      query: { version: 1 },
    });
    const res = await w.owner.client.post(path, bodyFor(w), {
      idempotencyKey: key,
    });
    expect([res.status, codeOf(res)]).toEqual([404, "NOT_FOUND"]);
  });

  it("keys are per user: another member using the same key creates their own transaction", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const a = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    const b = await w.member.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.header("idempotent-replayed")).toBeUndefined();
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("keys are kept 24 h: after that the same key with a new body creates a new transaction", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const first = await w.owner.client.post<Tx>(path, bodyFor(w), {
      idempotencyKey: key,
    });
    await advanceClock(23 * HOUR);
    expect(
      codeOf(
        await w.owner.client.post(path, bodyFor(w, 1), { idempotencyKey: key }),
      ),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    await advanceClock(HOUR + 1_000);
    const later = await w.owner.client.post<Tx>(path, bodyFor(w, 1), {
      idempotencyKey: key,
    });
    expect(later.status).toBe(201);
    expect(later.body.id).not.toBe(first.body.id);
  });

  it("a refused create (422) does not use up the key: the corrected retry succeeds", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const bad = await w.owner.client.post(
      path,
      { ...bodyFor(w), amountCents: 1 },
      { idempotencyKey: key },
    );
    expect(codeOf(bad)).toBe("SPLITS_DO_NOT_SUM");
    expect(
      (await w.owner.client.post(path, bodyFor(w), { idempotencyKey: key }))
        .status,
    ).toBe(201);
  });

  it("a missing or malformed Idempotency-Key → 400 (header, Idempotency-Key)", async () => {
    const w = await seedWorld();
    const path = `/budgets/${w.budget.id}/transactions`;
    const missing = await w.owner.client.post(path, bodyFor(w));
    expect([missing.status, codeOf(missing)]).toEqual([
      400,
      "VALIDATION_FAILED",
    ]);
    expect(detailsOf(missing)).toContainEqual(
      expect.objectContaining({
        in: "header",
        field: "Idempotency-Key",
        issue: "required",
      }),
    );
    const bad = await w.owner.client.post(path, bodyFor(w), {
      idempotencyKey: "not-a-uuid",
    });
    expect(detailsOf(bad)).toContainEqual(
      expect.objectContaining({ in: "header", field: "Idempotency-Key" }),
    );
  });

  it("ten concurrent submits with one key create exactly one transaction, and all answer it", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const path = `/budgets/${w.budget.id}/transactions`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        w.owner.client.post<Tx>(path, bodyFor(w), { idempotencyKey: key }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(
      results.filter((r) => r.header("idempotent-replayed") === "true"),
    ).toHaveLength(9);
    expect(await count(w)).toBe(2);
  });
});

describe("budget create retries", () => {
  it("replays the same budget, and concurrent duplicates create one budget", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const body = { name: "Trip", timezone: "Europe/Lisbon" };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        w.outsider.client.post<{ id: string }>("/budgets", body, {
          idempotencyKey: key,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const list = await w.outsider.client.get<{ items: { name: string }[] }>(
      "/budgets",
    );
    expect(list.body.items.filter((b) => b.name === "Trip")).toHaveLength(1);
  });
});

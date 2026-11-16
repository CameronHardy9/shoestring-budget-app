// F-48 regression (data-model.md "Text", owner ruling build round 2): Unicode
// bidirectional controls are refused at input in every user-text field with
// 400 VALIDATION_FAILED (issue invalid_value); U+200D (emoji ZWJ) stays allowed.
// (The email defanging half of F-48 is unit-tested in the backend: the test
// outbox does not expose message bodies.)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codeOf, detailsOf } from "../../support/http.ts";
import type { ApiResponse } from "../../support/http.ts";
import { seedWorld } from "../../support/world.ts";
import type { World } from "../../support/world.ts";

// Built from code points: the source file itself must never contain bidi
// controls (Trojan Source; Semgrep flags them), and formatters may unescape "\u" literals.
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((cp) =>
  String.fromCodePoint(cp),
);
const ZWJ = String.fromCodePoint(0x200d);
const hex = (c: string) =>
  `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

type Field = [
  label: string,
  field: string,
  send: (w: World, text: string) => Promise<ApiResponse>,
];

const FIELDS: Field[] = [
  [
    "transaction payee",
    "payee",
    (w, text) =>
      w.owner.client.post(
        `/budgets/${w.budget.id}/transactions`,
        {
          date: w.today,
          direction: "outflow",
          amountCents: 100,
          payee: text,
          splits: [
            { categoryId: w.budget.categories.Groceries!, amountCents: 100 },
          ],
        },
        { idempotencyKey: randomUUID() },
      ),
  ],
  [
    "transaction memo",
    "memo",
    (w, text) =>
      w.owner.client.post(
        `/budgets/${w.budget.id}/transactions`,
        {
          date: w.today,
          direction: "outflow",
          amountCents: 100,
          memo: text,
          splits: [
            { categoryId: w.budget.categories.Groceries!, amountCents: 100 },
          ],
        },
        { idempotencyKey: randomUUID() },
      ),
  ],
  [
    "display name",
    "displayName",
    (w, text) => w.owner.client.patch("/me", { displayName: text }),
  ],
  [
    "budget name (create)",
    "name",
    (w, text) =>
      w.owner.client.post(
        "/budgets",
        { name: text, timezone: "UTC" },
        { idempotencyKey: randomUUID() },
      ),
  ],
  [
    "budget name (rename)",
    "name",
    (w, text) =>
      w.owner.client.patch(`/budgets/${w.budget.id}`, {
        name: text,
        version: w.budget.record.version,
      }),
  ],
  [
    "category name",
    "name",
    (w, text) =>
      w.owner.client.post(`/budgets/${w.budget.id}/categories`, {
        name: text,
        kind: "expense",
      }),
  ],
];

describe("F-48: bidi controls are refused in every user-text field", () => {
  const cases = FIELDS.flatMap(([label, field, send]) =>
    BIDI.map((c) => [`${label} with ${hex(c)}`, field, send, c] as const),
  );
  it.each(cases)(
    "%s → 400 VALIDATION_FAILED (invalid_value)",
    async (_l, field, send, c) => {
      const w = await seedWorld();
      const res = await send(w, `Pay ${c}moc.evil${c} now`);
      expect([res.status, codeOf(res)], res.describe).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
      expect(detailsOf(res)).toContainEqual(
        expect.objectContaining({ in: "body", field, issue: "invalid_value" }),
      );
    },
  );

  it.each(FIELDS)("%s keeps emoji joined with U+200D", async (_l, _f, send) => {
    const w = await seedWorld();
    const res = await send(w, "Family " + ["\u{1F469}", "\u{1F469}", "\u{1F467}"].join(ZWJ));
    expect(res.status, res.describe).toBeLessThan(300);
  });
});

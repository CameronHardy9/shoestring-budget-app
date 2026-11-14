// The database Text rule (data-model.md "Text", F-48): is_clean_text rejects
// Unicode bidi controls in every user-text column; ZWJ emoji stay allowed.
import { describe, expect, it } from "vitest";
import {
  expectPgError,
  hash32,
  newBudget,
  newUser,
} from "./test-support/fixtures.ts";
import { useTestDb } from "./test-support/harness.ts";

const t = useTestDb();

// Each forbidden range by its first and last code point (and the middle of the wider ones).
const BIDI = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202c, 0x202e, 0x2066, 0x2067, 0x2069,
].map((cp) => String.fromCodePoint(cp));
// Neighbours and other format characters that must stay allowed.
const ALLOWED = [
  0x061b, 0x200c, 0x200d, 0x2029, 0x202f, 0x2065, 0x206a, 0x200b,
].map((cp) => String.fromCodePoint(cp));
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // ZWJ sequence
const hex = (s: string) => s.codePointAt(0)?.toString(16) ?? "";

const clean = async (s: string): Promise<boolean> =>
  (
    await t.app.query<{ ok: boolean }>(
      "select is_clean_text($1, 1, 100) as ok",
      [s],
    )
  ).rows[0]?.ok === true;

describe("is_clean_text (F-48)", () => {
  it("rejects every bidi control, at the start, inside and at the end", async () => {
    for (const c of BIDI) {
      for (const s of [`${c}abc`, `ab${c}c`, `abc${c}`])
        expect(await clean(s), `U+${hex(c)} in ${JSON.stringify(s)}`).toBe(
          false,
        );
    }
  });

  it("accepts ZWJ emoji sequences and the neighbouring format characters inside text", async () => {
    expect(await clean(FAMILY)).toBe(true);
    expect(await clean(`Fun ${FAMILY} money`)).toBe(true);
    for (const c of ALLOWED)
      expect(await clean(`ab${c}c`), `U+${hex(c)}`).toBe(true);
    // Unchanged rules still hold.
    expect(await clean("bell\u0007")).toBe(false);
    expect(await clean(" padded")).toBe(false);
  });

  it("is enforced on every user-text column", async () => {
    const { userId } = await newUser(t.dal);
    const f = await newBudget(t.dal, userId);
    const categoryId = Object.values(f.categories)[0] ?? "";
    const { passkeyId } = await t.dal.mfa.addPasskey(userId, {
      credentialId: hash32(),
      publicKey: hash32(),
      signCount: 0,
      transports: [],
      name: "Phone",
      recoveryCodes: { keyId: "k1", hashes: [hash32()] },
    });
    const { value: tx } = await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-12",
      direction: "outflow",
      amountCents: 10,
      splits: [{ categoryId, amountCents: 10 }],
    });
    const columns: [table: string, column: string, id: string][] = [
      ["users", "display_name", userId],
      ["budgets", "name", f.budget.id],
      ["categories", "name", categoryId],
      ["webauthn_credentials", "name", passkeyId],
      ["transactions", "payee", tx.id],
      ["transactions", "memo", tx.id],
    ];
    for (const [table, column, id] of columns) {
      // Identifiers come from the fixed list above; values are bound.
      const update = `update ${table} set ${column} = $2 where id = $1`;
      for (const c of [BIDI[0], BIDI[3], BIDI[8]])
        await expectPgError(
          t.app.query(update, [id, `Name${c ?? ""}x`]),
          "23514",
        );
      const ok = await t.app.query(update, [id, `Fam ${FAMILY}`]);
      expect(ok.rowCount, `${table}.${column}`).toBe(1);
    }
  });
});

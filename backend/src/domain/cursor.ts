// Opaque, MAC'd keyset cursors for the transaction list (auth.md §12, F-18).
// Layout (base64url): version(1) | date "YYYY-MM-DD"(10) | id uuid(16) | mac(16).
// The MAC (cursor-v1 subkey of the current key) covers the budget ID, the
// filters and the position, so a cursor from another budget, other filters, or
// a tampered one fails. Rotating the keyring invalidates outstanding cursors.
import { isCalendarDate } from "@shoestring/db";
import type { TransactionPosition } from "@shoestring/db";
import { timingSafeEqual } from "node:crypto";
import { hmacSha256 } from "../crypto/keyring.ts";
import type { Keyring } from "../crypto/keyring.ts";
import { fieldError, validationFailed } from "../errors.ts";

const VERSION = 1;
const LEN = 1 + 10 + 16 + 16;

export interface CursorFilters {
  month?: string | undefined;
  categoryId?: string | undefined;
}

function macInput(
  budgetId: string,
  f: CursorFilters,
  p: TransactionPosition,
): string {
  return ["v1", budgetId, f.month ?? "", f.categoryId ?? "", p.date, p.id].join(
    "|",
  );
}

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function uuidString(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const invalidCursor = () =>
  validationFailed([fieldError("query", "cursor", "invalid_value")]);

export class CursorCodec {
  private readonly keyring: Keyring;
  constructor(
    keyring: Keyring,
  ) {
    this.keyring = keyring;
  }

  private mac(
    budgetId: string,
    f: CursorFilters,
    p: TransactionPosition,
  ): Buffer {
    return hmacSha256(
      this.keyring.subkey("cursor-v1"),
      macInput(budgetId, f, p),
    ).subarray(0, 16);
  }

  encode(
    budgetId: string,
    filters: CursorFilters,
    pos: TransactionPosition,
  ): string {
    return Buffer.concat([
      Buffer.from([VERSION]),
      Buffer.from(pos.date, "ascii"),
      uuidBytes(pos.id.toLowerCase()),
      this.mac(budgetId, filters, { date: pos.date, id: pos.id.toLowerCase() }),
    ]).toString("base64url");
  }

  /** Throws 400 VALIDATION_FAILED (query.cursor, invalid_value) for any bad cursor. */
  decode(
    budgetId: string,
    filters: CursorFilters,
    cursor: string,
  ): TransactionPosition {
    const raw = Buffer.from(cursor, "base64url");
    if (
      raw.length !== LEN ||
      raw[0] !== VERSION ||
      raw.toString("base64url") !== cursor
    )
      throw invalidCursor();
    const date = raw.subarray(1, 11).toString("ascii");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCalendarDate(date))
      throw invalidCursor();
    const pos = { date, id: uuidString(raw.subarray(11, 27)) };
    const expected = this.mac(budgetId, filters, pos);
    if (!timingSafeEqual(expected, raw.subarray(27))) throw invalidCursor();
    return pos;
  }
}

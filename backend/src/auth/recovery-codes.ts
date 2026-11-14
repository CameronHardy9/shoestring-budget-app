// Recovery codes (auth.md §6, F-04): 10 codes `xxxxx-xxxxx` (36^10, about
// 51.7 bits each), shown once. Stored as HMAC-SHA-256 under the
// `recovery-code-v1` subkey of the current keyring key over the normalized
// code (lowercase, hyphen removed); compared in constant time.
import { randomInt, timingSafeEqual } from "node:crypto";
import type { RecoveryCodeHashes } from "@shoestring/db";
import { hmacSha256 } from "../crypto/keyring.ts";
import type { Keyring } from "../crypto/keyring.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace("-", "");
}

export function generateRecoveryCodes(keyring: Keyring): {
  codes: string[];
  hashes: RecoveryCodeHashes;
} {
  const unique = new Set<string>();
  while (unique.size < 10) {
    let raw = "";
    for (let i = 0; i < 10; i++) raw += ALPHABET.charAt(randomInt(ALPHABET.length));
    unique.add(raw);
  }
  const codes = [...unique].map((raw) => `${raw.slice(0, 5)}-${raw.slice(5)}`);
  const keyId = keyring.currentKeyId;
  const key = keyring.subkeyFor(keyId, "recovery-code-v1");
  return {
    codes,
    hashes: {
      keyId,
      hashes: codes.map((c) => hmacSha256(key, normalizeRecoveryCode(c))),
    },
  };
}

/** The ID of the unused code matching `code`, comparing against every row (no early exit). */
export function matchRecoveryCode(
  keyring: Keyring,
  code: string,
  rows: readonly { id: string; keyId: string; codeHash: Buffer }[],
): string | null {
  const normalized = normalizeRecoveryCode(code);
  let match: string | null = null;
  for (const row of rows) {
    if (!keyring.keyIds.includes(row.keyId)) continue;
    const h = hmacSha256(
      keyring.subkeyFor(row.keyId, "recovery-code-v1"),
      normalized,
    );
    if (h.length === row.codeHash.length && timingSafeEqual(h, row.codeHash))
      match ??= row.id;
  }
  return match;
}

// TOTP (auth.md §6, F-24): RFC 6238, SHA-1, 6 digits, 30 s step, +-1 step,
// 160-bit secret. At rest: AES-256-GCM with the `totp-v1` subkey of the row's
// keyring key, a random 96-bit nonce and AAD = user ID; stored as
// nonce || ciphertext || tag. No third-party library.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Keyring } from "../crypto/keyring.ts";

export const TOTP_STEP_SECONDS = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP value for one counter (RFC 6238 uses counter = step). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * The matching step within +-1 of now, or null. The caller rejects any step at
 * or below the stored last_used_step (replay) through the DAL's useTotpStep.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  now: Date,
): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const current = stepAt(now);
  let found: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    // Compare every candidate (no early exit) in constant time.
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code)))
      found ??= step;
  }
  return found;
}

export function otpauthUri(secretB32: string, accountEmail: string): string {
  const label = encodeURIComponent(`Shoestring:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=Shoestring&algorithm=SHA1&digits=6&period=30`;
}

export function encryptTotpSecret(
  keyring: Keyring,
  userId: string,
  secret: Buffer,
): { keyId: string; ciphertext: Buffer } {
  const keyId = keyring.currentKeyId;
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyring.subkeyFor(keyId, "totp-v1"),
    nonce,
    { authTagLength: 16 },
  );
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    keyId,
    ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]),
  };
}

/** Throws if the key ID is unknown or authentication fails (wrong user, tampering). */
export function decryptTotpSecret(
  keyring: Keyring,
  keyId: string,
  userId: string,
  blob: Buffer,
): Buffer {
  if (blob.length < 12 + 16 + 1) throw new Error("ciphertext too short");
  // Explicit 16-byte tag length: a truncated tag is never accepted.
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyring.subkeyFor(keyId, "totp-v1"),
    blob.subarray(0, 12),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(userId, "utf8"));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([
    decipher.update(blob.subarray(12, blob.length - 16)),
    decipher.final(),
  ]);
}

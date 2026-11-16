// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), written independently of the backend
// so a test proves the server agrees with the standard, not with itself.
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32 in TOTP secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The TOTP code at `at` (the server's frozen clock) with an optional step offset. */
export function totp(secretBase32: string, at: Date, stepOffset = 0): string {
  const step = Math.floor(at.getTime() / 30_000) + stepOffset;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretBase32))
    .update(counter)
    .digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[off]! & 0x7f) << 24) |
    (mac[off + 1]! << 16) |
    (mac[off + 2]! << 8) |
    mac[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** A 6-digit code guaranteed wrong for every accepted step (±1) at `at`. */
export function wrongTotp(secretBase32: string, at: Date): string {
  const valid = new Set([-1, 0, 1].map((o) => totp(secretBase32, at, o)));
  for (let n = 0; ; n++) {
    const c = String((123456 + n * 7919) % 1_000_000).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
}

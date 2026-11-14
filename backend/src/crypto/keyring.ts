// APP_KEYRING (data-model.md "Application keyring", F-24) and the small set of
// crypto primitives the backend needs. Raw keys are never used directly: every
// use derives an HKDF-SHA-256 subkey (salt "shoestring", info "<use>-v1").
import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type SubkeyUse =
  "totp-v1" | "recovery-code-v1" | "throttle-v1" | "cursor-v1";

export interface Keyring {
  readonly currentKeyId: string;
  readonly keyIds: readonly string[];
  /** Subkey of the current key. */
  subkey(use: SubkeyUse): Buffer;
  /** Subkey of a given key (versioned uses); throws for an unknown id. */
  subkeyFor(keyId: string, use: SubkeyUse): Buffer;
}

const KEY_ID_RE = /^k[0-9]{1,4}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates the JSON keyring (shape, ids, 32-byte keys). Throws without echoing values. */
export function parseKeyring(json: string): Keyring {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("keyring is not JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("keyring shape");
  const { current, keys } = raw as { current?: unknown; keys?: unknown };
  if (typeof current !== "string" || typeof keys !== "object" || keys === null)
    throw new Error("keyring shape");
  const extra = Object.keys(raw).filter((k) => k !== "current" && k !== "keys");
  if (extra.length > 0) throw new Error("keyring shape");
  const material = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(keys)) {
    if (!KEY_ID_RE.test(id) || typeof value !== "string" || !B64_RE.test(value))
      throw new Error("keyring entry");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32) throw new Error("keyring key length");
    material.set(id, bytes);
  }
  if (!material.has(current)) throw new Error("keyring current");
  const cache = new Map<string, Buffer>();
  const subkeyFor = (keyId: string, use: SubkeyUse): Buffer => {
    const k = material.get(keyId);
    if (!k) throw new Error("unknown key id");
    const cacheKey = `${keyId}:${use}`;
    let sub = cache.get(cacheKey);
    if (!sub) {
      sub = Buffer.from(hkdfSync("sha256", k, "shoestring", use, 32));
      cache.set(cacheKey, sub);
    }
    return sub;
  };
  return Object.freeze({
    currentKeyId: current,
    keyIds: Object.freeze([...material.keys()]),
    subkey: (use: SubkeyUse) => subkeyFor(current, use),
    subkeyFor,
  });
}

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hmacSha256(key: Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** 32 random bytes, base64url (43 characters): session and one-time tokens, CSRF tokens. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time string comparison (different lengths compare unequal). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

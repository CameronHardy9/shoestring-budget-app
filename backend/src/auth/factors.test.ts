import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseKeyring } from "../crypto/keyring.ts";
import {
  generateRecoveryCodes,
  matchRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-codes.ts";
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  matchTotp,
  otpauthUri,
  stepAt,
  totpCode,
} from "./totp.ts";
import {
  authenticationOptions,
  newChallenge,
  registrationOptions,
  verifyAssertion,
  verifyRegistration,
} from "./webauthn.ts";
import { SoftAuthenticator } from "../test-support/authenticator.ts";

const ring = (current = "k1", extra: Record<string, string> = {}) =>
  parseKeyring(
    JSON.stringify({
      current,
      keys: { [current]: randomBytes(32).toString("base64"), ...extra },
    }),
  );

describe("TOTP (RFC 6238)", () => {
  const secret = Buffer.from("12345678901234567890");
  it("matches the RFC 6238 SHA-1 test vectors (6 digits)", () => {
    expect(totpCode(secret, stepAt(new Date(59_000)))).toBe("287082");
    expect(totpCode(secret, stepAt(new Date(1_111_111_109_000)))).toBe(
      "081804",
    );
    expect(totpCode(secret, stepAt(new Date(2_000_000_000_000)))).toBe(
      "279037",
    );
  });

  it("accepts +-1 step and nothing further", () => {
    const now = new Date(1_700_000_000_000);
    const s = stepAt(now);
    expect(matchTotp(secret, totpCode(secret, s - 1), now)).toBe(s - 1);
    expect(matchTotp(secret, totpCode(secret, s + 1), now)).toBe(s + 1);
    expect(matchTotp(secret, totpCode(secret, s - 2), now)).toBeNull();
    expect(matchTotp(secret, "12345", now)).toBeNull();
  });

  it("base32 round-trips a 160-bit secret; the otpauth URI follows the contract", () => {
    const b = randomBytes(20);
    const s = base32Encode(b);
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s).equals(b)).toBe(true);
    expect(otpauthUri(s, "pat@example.test")).toBe(
      `otpauth://totp/Shoestring%3Apat%40example.test?secret=${s}&issuer=Shoestring&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it("base32 handles every tail length, padding and lowercase; rejects junk", () => {
    for (let n = 0; n <= 6; n++) {
      const b = randomBytes(n);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(base32Decode("mzxw6===").toString()).toBe("foo");
    expect(() => base32Decode("ABC1")).toThrow();
    expect(() => decryptTotpSecret(ring(), "k1", "u", Buffer.alloc(10))).toThrow(/too short/);
  });

  it("encrypts with AES-256-GCM bound to the user (AAD) and the key ID", () => {
    const k = ring();
    const s = randomBytes(20);
    const enc = encryptTotpSecret(k, "user-a", s);
    expect(enc.keyId).toBe("k1");
    expect(enc.ciphertext.includes(s)).toBe(false);
    expect(decryptTotpSecret(k, "k1", "user-a", enc.ciphertext).equals(s)).toBe(
      true,
    );
    expect(() =>
      decryptTotpSecret(k, "k1", "user-b", enc.ciphertext),
    ).toThrow();
    const tampered = Buffer.from(enc.ciphertext);
    tampered[14] = tampered[14]! ^ 1;
    expect(() => decryptTotpSecret(k, "k1", "user-a", tampered)).toThrow();
    expect(() =>
      decryptTotpSecret(ring(), "k1", "user-a", enc.ciphertext),
    ).toThrow();
  });
});

describe("recovery codes (F-04)", () => {
  it("skips rows under unknown keys or with malformed hashes; the first match wins", () => {
    const k = ring();
    const { codes, hashes } = generateRecoveryCodes(k);
    const h0 = hashes.hashes[0]!;
    const rows = [
      { id: "gone", keyId: "k7", codeHash: h0 },
      { id: "short", keyId: "k1", codeHash: h0.subarray(0, 16) },
      { id: "a", keyId: "k1", codeHash: h0 },
      { id: "b", keyId: "k1", codeHash: h0 },
    ];
    expect(matchRecoveryCode(k, codes[0]!, rows)).toBe("a");
  });

  it("10 distinct codes in the contract format, HMAC'd under the current key", () => {
    const k = ring("k2", { k1: randomBytes(32).toString("base64") });
    const { codes, hashes } = generateRecoveryCodes(k);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    expect(hashes.keyId).toBe("k2");
    expect(hashes.hashes.every((h) => h.length === 32)).toBe(true);
  });

  it("matches case-insensitively with or without the hyphen, and never across keyrings", () => {
    const k = ring();
    const { codes, hashes } = generateRecoveryCodes(k);
    const rows = hashes.hashes.map((h, i) => ({
      id: `r${i}`,
      keyId: hashes.keyId,
      codeHash: h,
    }));
    expect(
      matchRecoveryCode(k, codes[3]!.toUpperCase().replace("-", ""), rows),
    ).toBe("r3");
    expect(normalizeRecoveryCode("AbCdE-12345")).toBe("abcde12345");
    expect(matchRecoveryCode(k, "zzzzz-zzzzz", rows)).toBeNull();
    expect(matchRecoveryCode(ring(), codes[3]!, rows)).toBeNull();
  });
});

describe("WebAuthn (real verification with a software authenticator)", () => {
  const rp = { id: "app.test", name: "Shoestring", origin: "https://app.test" };

  async function registered() {
    const auth = new SoftAuthenticator();
    const challenge = newChallenge();
    const opts = await registrationOptions(
      rp,
      {
        id: "01a1d7ab-0000-7000-8000-000000000001",
        email: "p@example.test",
        displayName: "Pat",
      },
      [],
      challenge,
    );
    expect(opts).toMatchObject({
      attestation: "none",
      authenticatorSelection: {
        residentKey: "discouraged",
        userVerification: "preferred",
      },
    });
    const v = await verifyRegistration(
      rp,
      auth.register(opts, rp.origin),
      challenge,
    );
    expect(v).not.toBeNull();
    return {
      auth,
      cred: {
        id: "pk1",
        credentialId: v!.credentialId,
        publicKey: v!.publicKey,
        signCount: v!.signCount,
        transports: v!.transports,
      },
    };
  }

  it("registers and verifies an assertion; rejects a wrong challenge, origin or credential", async () => {
    const { auth, cred } = await registered();
    const challenge = newChallenge();
    const opts = await authenticationOptions(rp, [cred], challenge);
    expect(opts).toMatchObject({
      rpId: "app.test",
      userVerification: "preferred",
      allowCredentials: [{ id: cred.credentialId.toString("base64url") }],
    });
    const ok = await verifyAssertion(
      rp,
      auth.assert(opts, rp.origin),
      challenge,
      [cred],
    );
    expect(ok).toMatchObject({ ok: true, passkeyId: "pk1", newCounter: 1 });
    expect(
      await verifyAssertion(rp, auth.assert(opts, rp.origin), newChallenge(), [
        cred,
      ]),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await verifyAssertion(
        rp,
        auth.assert(opts, "https://evil.test"),
        challenge,
        [cred],
      ),
    ).toMatchObject({ ok: false });
    expect(
      await verifyAssertion(
        rp,
        new SoftAuthenticator().assert(opts, rp.origin),
        challenge,
        [cred],
      ),
    ).toMatchObject({ ok: false, reason: "unknown_credential" });
  });

  it("rejects a counter regression unless the stored count is 0", async () => {
    const { auth, cred } = await registered();
    const challenge = newChallenge();
    const opts = await authenticationOptions(rp, [cred], challenge);
    expect(
      await verifyAssertion(rp, auth.assert(opts, rp.origin, 5), challenge, [
        { ...cred, signCount: 7 },
      ]),
    ).toMatchObject({ ok: false, reason: "counter_regression" });
    expect(
      await verifyAssertion(rp, auth.assert(opts, rp.origin, 0), challenge, [
        { ...cred, signCount: 0 },
      ]),
    ).toMatchObject({ ok: true });
  });

  it("registration fails for a wrong challenge or garbage", async () => {
    const auth = new SoftAuthenticator();
    const opts = await registrationOptions(
      rp,
      {
        id: "01a1d7ab-0000-7000-8000-000000000001",
        email: "p@example.test",
        displayName: "Pat",
      },
      [],
      newChallenge(),
    );
    expect(
      await verifyRegistration(
        rp,
        auth.register(opts, rp.origin),
        newChallenge(),
      ),
    ).toBeNull();
    expect(
      await verifyRegistration(rp, { id: "x" }, newChallenge()),
    ).toBeNull();
  });
});

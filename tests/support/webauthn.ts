// A software WebAuthn authenticator (ES256 / P-256, "none" attestation,
// hand-encoded CBOR) so passkey registration and passkey assertions can run
// through the real API with real signatures. Independent of the backend's own
// test helper on purpose.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { expect } from "vitest";
import { env } from "./env.ts";
import type { ApiClient } from "./http.ts";

const b64u = (b: Buffer): string => b.toString("base64url");
const sha256 = (b: Buffer | string): Buffer =>
  createHash("sha256").update(b).digest();

function cborBytes(b: Buffer): Buffer {
  if (b.length < 24) return Buffer.concat([Buffer.from([0x40 | b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
  return Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 255]), b]);
}
function cborText(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;

  constructor() {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" });
    // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
      cborBytes(Buffer.from(jwk.x ?? "", "base64url")),
      Buffer.from([0x22]),
      cborBytes(Buffer.from(jwk.y ?? "", "base64url")),
    ]);
  }

  private authData(rpId: string, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [
      sha256(rpId),
      Buffer.from([attested ? 0x41 : 0x01]),
      counter,
    ];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: env.appOrigin,
        crossOrigin: false,
      }),
    );
  }

  register(options: {
    challenge: string;
    rp: { id?: string };
  }): Record<string, unknown> {
    const rpId = options.rp.id ?? new URL(env.appOrigin).hostname;
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText("fmt"),
      cborText("none"),
      cborText("attStmt"),
      Buffer.from([0xa0]),
      cborText("authData"),
      cborBytes(this.authData(rpId, true)),
    ]);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64u(
          this.clientData("webauthn.create", options.challenge),
        ),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  assert(options: {
    challenge: string;
    rpId?: string;
  }): Record<string, unknown> {
    this.counter += 1;
    const authData = this.authData(
      options.rpId ?? new URL(env.appOrigin).hostname,
      false,
    );
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
}

/** Registers a passkey through the API (needs a fresh re-auth window). */
export async function enrollPasskey(
  client: ApiClient,
  name = "Test key",
): Promise<{
  authenticator: SoftAuthenticator;
  passkeyId: string;
  recoveryCodes: string[] | null;
}> {
  const authenticator = new SoftAuthenticator();
  const options = await client.post<{ challenge: string; rp: { id?: string } }>(
    "/me/mfa/passkeys/options",
  );
  expect(options.status, options.describe).toBe(200);
  const res = await client.post<{
    passkey: { id: string };
    recoveryCodes: string[] | null;
  }>("/me/mfa/passkeys", {
    name,
    credential: authenticator.register(options.body),
  });
  expect(res.status, res.describe).toBe(201);
  return {
    authenticator,
    passkeyId: res.body.passkey.id,
    recoveryCodes: res.body.recoveryCodes,
  };
}

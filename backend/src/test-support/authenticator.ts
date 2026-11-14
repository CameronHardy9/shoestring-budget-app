// A minimal software WebAuthn authenticator for tests: ES256 (P-256) key,
// "none" attestation, hand-encoded CBOR. Produces RegistrationResponseJSON and
// AuthenticationResponseJSON that @simplewebauthn/server verifies for real.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

const b64u = (b: Buffer): string => b.toString("base64url");
const sha = (b: Buffer | string): Buffer =>
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
    const x = Buffer.from(jwk.x ?? "", "base64url");
    const y = Buffer.from(jwk.y ?? "", "base64url");
    // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
      cborBytes(x),
      Buffer.from([0x22]),
      cborBytes(y),
    ]);
  }

  private authData(rpId: string, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = Buffer.from([attested ? 0x41 : 0x01]); // UP (+ AT)
    const parts = [sha(rpId), flags, counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  register(
    options: { challenge: string; rp: { id?: string } },
    origin: string,
  ) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const authData = this.authData(rpId, true);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText("fmt"),
      cborText("none"),
      cborText("attStmt"),
      Buffer.from([0xa0]),
      cborText("authData"),
      cborBytes(authData),
    ]);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(
          this.clientData("webauthn.create", options.challenge, origin),
        ),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** An assertion; `counter` defaults to the next value. */
  assert(
    options: { challenge: string; rpId?: string },
    origin: string,
    counter?: number,
  ) {
    this.counter = counter ?? this.counter + 1;
    const authData = this.authData(
      options.rpId ?? new URL(origin).hostname,
      false,
    );
    const clientDataJSON = this.clientData(
      "webauthn.get",
      options.challenge,
      origin,
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key" as const,
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

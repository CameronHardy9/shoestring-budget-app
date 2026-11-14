// Passkeys as a second factor (auth.md §6) via @simplewebauthn/server.
// RP ID = host of APP_ORIGIN, expected origin = APP_ORIGIN, attestation none,
// userVerification preferred, residentKey discouraged, explicit
// allowCredentials. Challenges are generated here, stored by the DAL (single
// use, 5 minutes) and bound to a session or a reset token.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeyCredential } from "@shoestring/db";
import { randomBytes } from "node:crypto";

export const WEBAUTHN_TIMEOUT_MS = 5 * 60_000;

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

const b64u = (b: Buffer): string => b.toString("base64url");

export function newChallenge(): Buffer {
  return randomBytes(32);
}

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ""), "hex"));
}

export async function registrationOptions(
  rp: RelyingParty,
  user: { id: string; email: string; displayName: string },
  existing: readonly PasskeyCredential[],
  challenge: Buffer,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: uuidBytes(user.id),
    userName: user.email,
    userDisplayName: user.displayName,
    challenge: new Uint8Array(challenge),
    timeout: WEBAUTHN_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: b64u(c.credentialId),
      transports: c.transports,
    })),
    authenticatorSelection: {
      residentKey: "discouraged",
      userVerification: "preferred",
    },
  });
}

export async function authenticationOptions(
  rp: RelyingParty,
  credentials: readonly PasskeyCredential[],
  challenge: Buffer,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.id,
    challenge: new Uint8Array(challenge),
    timeout: WEBAUTHN_TIMEOUT_MS,
    userVerification: "preferred",
    allowCredentials: credentials.map((c) => ({
      id: b64u(c.credentialId),
      transports: c.transports,
    })),
  });
}

export interface VerifiedRegistration {
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
}

/** Null when the response does not verify (any library error counts as a failure). */
export async function verifyRegistration(
  rp: RelyingParty,
  response: unknown,
  challenge: Buffer,
): Promise<VerifiedRegistration | null> {
  try {
    const r = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: b64u(challenge),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
    if (!r.verified) return null;
    const c = r.registrationInfo.credential;
    return {
      credentialId: Buffer.from(c.id, "base64url"),
      publicKey: Buffer.from(c.publicKey),
      signCount: c.counter,
      transports: (c.transports ?? []).slice(0, 10),
    };
  } catch {
    return null;
  }
}

export type AssertionResult =
  | { ok: true; passkeyId: string; newCounter: number }
  | {
      ok: false;
      reason: "unknown_credential" | "invalid" | "counter_regression";
      passkeyId?: string;
    };

/**
 * Verifies an assertion against the user's own credentials. The counter rule
 * is ours (auth.md §6): a regression is rejected unless the stored count is 0,
 * and reported so the caller can record `passkey_counter_regression`.
 */
export async function verifyAssertion(
  rp: RelyingParty,
  response: unknown,
  challenge: Buffer,
  credentials: readonly PasskeyCredential[],
): Promise<AssertionResult> {
  const r = response as Partial<AuthenticationResponseJSON>;
  const cred = credentials.find(
    (c) => b64u(c.credentialId) === r.rawId || b64u(c.credentialId) === r.id,
  );
  if (!cred) return { ok: false, reason: "unknown_credential" };
  try {
    const v = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: b64u(challenge),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      // Counter 0 here: the library's own counter check is replaced by ours below.
      credential: {
        id: b64u(cred.credentialId),
        publicKey: new Uint8Array(cred.publicKey),
        counter: 0,
        transports: cred.transports,
      },
      requireUserVerification: false,
    });
    if (!v.verified)
      return { ok: false, reason: "invalid", passkeyId: cred.id };
    const next = v.authenticationInfo.newCounter;
    if (cred.signCount > 0 && next <= cred.signCount)
      return { ok: false, reason: "counter_regression", passkeyId: cred.id };
    return { ok: true, passkeyId: cred.id, newCounter: next };
  } catch {
    return { ok: false, reason: "invalid", passkeyId: cred.id };
  }
}

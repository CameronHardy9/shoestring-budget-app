// Passkeys through @simplewebauthn/browser, loaded only when needed
// (ARCHITECTURE JS budget: WebAuthn code is lazy).
import type { Schemas } from "../api/types.ts";

export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function";
}

/** Runs the browser's passkey prompt for an assertion (sign-in, re-auth, reset). */
export async function getAssertion(
  options: Schemas["WebAuthnRequestOptions"],
): Promise<Schemas["WebAuthnAssertion"]> {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const result = await startAuthentication({
    optionsJSON: options as unknown as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  });
  return result as unknown as Schemas["WebAuthnAssertion"];
}

/** Runs the browser's passkey creation prompt. */
export async function createCredential(
  options: Schemas["WebAuthnCreationOptions"],
): Promise<Schemas["WebAuthnRegistrationResponse"]> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const result = await startRegistration({
    optionsJSON: options as unknown as Parameters<
      typeof startRegistration
    >[0]["optionsJSON"],
  });
  return result as unknown as Schemas["WebAuthnRegistrationResponse"];
}

/** Passkey prompt cancelled or not allowed: not an error worth a red banner. */
export function isPasskeyCancel(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

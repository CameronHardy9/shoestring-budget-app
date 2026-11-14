// Second-factor input shared by MFA sign-in, re-authentication and password
// reset (auth.md §5, §8, §10): authenticator code, passkey, or recovery code.
import { useState } from "react";
import type { Schemas } from "../api/types.ts";
import {
  getAssertion,
  isPasskeyCancel,
  passkeysSupported,
} from "../app/webauthn.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { TextField } from "./TextField.tsx";

type Method = Schemas["MfaMethod"];
export type MfaProof = Schemas["MfaProof"];

export interface SecondFactorProps {
  methods: readonly Method[];
  /** Sends the proof; throws on failure (the caller shows the error). */
  onProof: (proof: MfaProof) => Promise<void>;
  /** Fetches passkey assertion options for this flow. */
  getPasskeyOptions?: () => Promise<Schemas["WebAuthnRequestOptions"]>;
  submitLabel?: string;
  /** Error handling for the passkey path (prompt failures). */
  onError: (error: unknown) => void;
}

const TOTP = /^\d{6}$/;
const RECOVERY = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

export function SecondFactor({
  methods,
  onProof,
  getPasskeyOptions,
  submitLabel = "Verify",
  onError,
}: SecondFactorProps) {
  const canTotp = methods.includes("totp");
  const canPasskey =
    methods.includes("passkey") &&
    getPasskeyOptions !== undefined &&
    passkeysSupported();
  const canRecovery = methods.includes("recovery_code");
  const [mode, setMode] = useState<"totp" | "recovery_code">(
    canTotp ? "totp" : "recovery_code",
  );
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const run = async (make: () => Promise<MfaProof>) => {
    setBusy(true);
    try {
      await onProof(await make());
    } catch (error) {
      if (!isPasskeyCancel(error)) onError(error);
    } finally {
      setBusy(false);
    }
  };

  const showCodeForm =
    (mode === "totp" && canTotp) || (mode === "recovery_code" && canRecovery);

  return (
    <div className="flex flex-col gap-4">
      {canPasskey ? (
        <Button
          size="lg"
          variant={canTotp ? "secondary" : "primary"}
          className="w-full"
          isPending={busy}
          onPress={() => {
            void run(async () => ({
              method: "passkey" as const,
              assertion: await getAssertion(await getPasskeyOptions()),
            }));
          }}
        >
          <Icon name="key" /> Use a passkey
        </Button>
      ) : null}

      {showCodeForm ? (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const value = code.trim();
            const ok =
              mode === "totp" ? TOTP.test(value) : RECOVERY.test(value);
            setInvalid(!ok);
            if (!ok) return;
            void run(() =>
              Promise.resolve<MfaProof>(
                mode === "totp"
                  ? { method: "totp", code: value }
                  : { method: "recovery_code", code: value },
              ),
            );
          }}
        >
          {mode === "totp" ? (
            <TextField
              label="6-digit code from your authenticator app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
              {...(invalid
                ? { errorMessage: "Enter the 6 digits from your app." }
                : {})}
              data-testid="mfa-code"
            />
          ) : (
            <TextField
              label="Recovery code"
              name="recovery-code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              placeholder="xxxxx-xxxxx"
              value={code}
              onChange={setCode}
              {...(invalid
                ? { errorMessage: "Recovery codes look like abcde-12345." }
                : {})}
            />
          )}
          <Button type="submit" size="lg" className="w-full" isPending={busy}>
            {submitLabel}
          </Button>
        </form>
      ) : null}

      {canTotp && canRecovery ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onPress={() => {
            setMode(mode === "totp" ? "recovery_code" : "totp");
            setCode("");
            setInvalid(false);
          }}
        >
          {mode === "totp"
            ? "Use a recovery code instead"
            : "Use your authenticator app instead"}
        </Button>
      ) : null}
    </div>
  );
}

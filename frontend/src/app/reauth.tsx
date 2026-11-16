// Re-authentication for sensitive actions (auth.md §10, errors.md "Client
// handling"): run the action; on 403 REAUTH_REQUIRED ask for the password
// (plus a second factor when the user has MFA), POST /auth/reauth, then retry
// the original action once. Cancelling rejects with ReauthCancelled.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { api, unwrap } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { Schemas } from "../api/types.ts";
import { Button } from "../components/Button.tsx";
import { SecondFactor, type MfaProof } from "../components/SecondFactor.tsx";
import { FormError } from "../components/States.tsx";
import { TextField } from "../components/TextField.tsx";
import { useAuth } from "./auth.tsx";

export class ReauthCancelled extends Error {
  constructor() {
    super("Re-authentication cancelled");
    this.name = "ReauthCancelled";
  }
}

type Run = <T>(action: () => Promise<T>) => Promise<T>;

const ReauthContext = createContext<Run | null>(null);

/** Wraps a sensitive call so REAUTH_REQUIRED prompts and retries once. */
export function useReauth(): Run {
  const run = useContext(ReauthContext);
  if (!run) throw new Error("useReauth outside ReauthProvider");
  return run;
}

interface Pending {
  resolve: () => void;
  reject: (error: unknown) => void;
}

function methodsFor(mfa: Schemas["MfaSummary"]): Schemas["MfaMethod"][] {
  const methods: Schemas["MfaMethod"][] = [];
  if (mfa.totp) methods.push("totp");
  if (mfa.passkeyCount > 0) methods.push("passkey");
  if (mfa.recoveryCodesRemaining > 0) methods.push("recovery_code");
  return methods;
}

function ReauthDialog({
  pending,
  onDone,
}: {
  pending: Pending;
  onDone: () => void;
}) {
  const { status } = useAuth();
  const mfa = status.kind === "signedIn" ? status.me.mfa : null;
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (proof?: MfaProof) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/auth/reauth", {
          body: proof ? { password, mfa: proof } : { password },
        }),
      );
      pending.resolve();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "MFA_REQUIRED") setStep("mfa");
      else setError(e);
      if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS")
        setStep("password");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) {
          pending.reject(new ReauthCancelled());
          onDone();
        }
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center"
    >
      <Modal className="w-full max-w-md rounded-t-xl bg-surface p-5 shadow-3 sm:rounded-xl">
        <Dialog
          className="flex flex-col gap-4 outline-none"
          data-testid="reauth-dialog"
        >
          <Heading slot="title" className="text-lg font-semibold text-fg">
            Confirm it's you
          </Heading>
          <p className="text-sm text-fg-muted">
            For your security, enter your password to continue. You won't be
            asked again for 10 minutes.
          </p>
          <FormError error={error} />
          {step === "password" ? (
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (password === "") return;
                // When MFA is on, collect the factor next instead of a round trip.
                if (mfa?.enabled) setStep("mfa");
                else void submit().catch(() => undefined);
              }}
            >
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
              />
              <div className="flex gap-2">
                <Button variant="secondary" slot="close" className="flex-1">
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" isPending={busy}>
                  Continue
                </Button>
              </div>
            </form>
          ) : (
            <SecondFactor
              methods={mfa ? methodsFor(mfa) : ["totp", "recovery_code"]}
              submitLabel="Confirm"
              onProof={(proof) => submit(proof)}
              getPasskeyOptions={() =>
                unwrap(
                  api.POST("/auth/webauthn/challenge", {
                    body: { purpose: "reauth" },
                  }),
                )
              }
              onError={setError}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // One prompt at a time: a second REAUTH_REQUIRED while the dialog is open
  // waits for the same answer instead of replacing it (which would leave the
  // first caller's promise, and its spinner, hanging forever).
  const askingRef = useRef<Promise<void> | null>(null);

  const ask = useCallback(() => {
    if (askingRef.current) return askingRef.current;
    const asking = new Promise<void>((resolve, reject) => {
      setPending({ resolve, reject });
    });
    askingRef.current = asking;
    return asking;
  }, []);

  const run = useCallback<Run>(
    async (action) => {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "REAUTH_REQUIRED")
          throw error;
        await ask();
        return action();
      }
    },
    [ask],
  );

  const value = useMemo(() => run, [run]);
  return (
    <ReauthContext.Provider value={value}>
      {children}
      {pending ? (
        <ReauthDialog
          pending={pending}
          onDone={() => {
            askingRef.current = null;
            setPending(null);
          }}
        />
      ) : null}
    </ReauthContext.Provider>
  );
}

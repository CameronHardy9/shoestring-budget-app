// The one Sign out control (More, pending deletion). Honest about failure
// (F-51): if the server didn't confirm the sign-out, the person stays on this
// screen, still signed in, with a message and the same button to retry.
import { useState } from "react";
import { isClientError, NetworkError } from "../api/errors.ts";
import { SignOutError, useAuth } from "../app/auth.tsx";
import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
import { Diagnostics } from "./States.tsx";

export const SIGN_OUT_OFFLINE =
  "Couldn't sign out. Check your connection and try again.";
export const SIGN_OUT_FAILED =
  "Couldn't sign out, so you're still signed in. Try again, or reload the page if it keeps happening.";

function requestIdOf(error: unknown): string | null {
  return isClientError(error) && error.kind !== "network"
    ? error.requestId
    : null;
}

export function SignOutButton({ className }: { className?: string }) {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SignOutError | null>(null);
  const requestId = failure ? requestIdOf(failure.cause) : null;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {failure ? (
        <div data-testid="sign-out-error">
          <Alert
            tone="danger"
            detail={requestId ? <Diagnostics requestId={requestId} /> : null}
          >
            {failure.cause instanceof NetworkError
              ? SIGN_OUT_OFFLINE
              : SIGN_OUT_FAILED}
          </Alert>
        </div>
      ) : null}
      <Button
        variant="secondary"
        className="w-full"
        isPending={busy}
        onPress={() => {
          setBusy(true);
          setFailure(null);
          // On success the page is replaced, so `busy` stays on until then.
          signOut().catch((error: unknown) => {
            setBusy(false);
            setFailure(
              error instanceof SignOutError
                ? error
                : new SignOutError({ cause: error }),
            );
          });
        }}
        data-testid="sign-out"
      >
        <Icon name="logout" /> Sign out
      </Button>
    </div>
  );
}

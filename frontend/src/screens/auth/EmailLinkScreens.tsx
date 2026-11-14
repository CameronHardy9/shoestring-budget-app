// /confirm-email#token=… (needs the same user signed in; the token waits in
// memory through sign-in) and /cancel-email-change#token=… ("this wasn't me",
// public). auth.md §9.
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { useAuth } from "../../app/auth.tsx";
import { Alert } from "../../components/Alert.tsx";
import { Button } from "../../components/Button.tsx";
import { FormError } from "../../components/States.tsx";
import { clearLinkToken, peekLinkToken } from "../../lib/link-token.ts";
import { AuthLayout } from "./AuthLayout.tsx";

function useAction() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => {
        clearLinkToken();
        setDone(true);
        after?.();
      })
      .catch(setError)
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, done, error, run };
}

const tokenInvalid = (error: unknown) =>
  error instanceof ApiError && error.code === "TOKEN_INVALID";

export function ConfirmEmailScreen() {
  const { refresh, status } = useAuth();
  const [token] = useState(() => peekLinkToken("/confirm-email"));
  const { busy, done, error, run } = useAction();
  if (done) {
    return (
      <AuthLayout title="Email changed">
        <Alert tone="success">
          Your sign-in email is now{" "}
          {status.kind === "signedIn" ? status.me.email : "updated"}. Other
          devices were signed out.
        </Alert>
        <Link
          href="/"
          className="flex min-h-touch items-center font-semibold text-brand"
        >
          Continue to Shoestring
        </Link>
      </AuthLayout>
    );
  }
  if (!token || tokenInvalid(error)) {
    return (
      <AuthLayout
        title="Link not valid"
        intro="This confirmation link has expired, was already used, or belongs to another account. Request the change again from Settings."
      >
        <Link href="/settings/security" className="font-semibold text-brand">
          Go to security settings
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Confirm your new email"
      intro="Use this address to sign in from now on."
    >
      <FormError error={error} />
      <Button
        size="lg"
        className="w-full"
        isPending={busy}
        onPress={() => {
          run(
            () =>
              unwrap(
                api.POST("/auth/email-change/confirm", { body: { token } }),
              ),
            () => void refresh(),
          );
        }}
      >
        Confirm new email
      </Button>
    </AuthLayout>
  );
}

export function CancelEmailChangeScreen() {
  const { forget, status } = useAuth();
  const [token] = useState(() => peekLinkToken("/cancel-email-change"));
  const { busy, done, error, run } = useAction();
  if (done) {
    return (
      <AuthLayout title="Email change undone">
        <Alert tone="success">
          The account's email is back to the address this link was sent to, and
          every device was signed out.
        </Alert>
        <p className="text-sm text-fg">
          If you didn't ask for this change, someone may know your password.
          Reset it now and check your two-step verification.
        </p>
        <Link
          href="/reset-password"
          className="flex min-h-touch items-center font-semibold text-brand"
        >
          Reset your password
        </Link>
      </AuthLayout>
    );
  }
  if (!token || tokenInvalid(error)) {
    return (
      <AuthLayout
        title="Link not valid"
        intro="This link has expired (they work for 24 hours) or was already used. If you still see a change you didn't make, reset your password."
      >
        <Link href="/reset-password" className="font-semibold text-brand">
          Reset your password
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="This wasn't me"
      intro="Undo the email change on your Shoestring account. Every device will be signed out."
    >
      <FormError error={error} />
      <Button
        size="lg"
        variant="danger"
        className="w-full"
        isPending={busy}
        onPress={() => {
          run(
            () =>
              unwrap(
                api.POST("/auth/email-change/cancel", { body: { token } }),
              ),
            () => {
              if (status.kind !== "signedOut") forget();
            },
          );
        }}
      >
        Undo the email change
      </Button>
    </AuthLayout>
  );
}

// /reset-password (auth.md §8). Without a token: ask for a link (always the
// same answer, so it never reveals whether an account exists). With
// #token=…: verify it, collect the new password and, when the account has MFA,
// a second factor. Success revokes every session; the person signs in again.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import { useAuth } from "../../app/auth.tsx";
import { shouldRetry } from "../../app/query.ts";
import { Alert } from "../../components/Alert.tsx";
import { Button } from "../../components/Button.tsx";
import { SecondFactor, type MfaProof } from "../../components/SecondFactor.tsx";
import {
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { clearLinkToken, peekLinkToken } from "../../lib/link-token.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { PASSWORD_COPY } from "./SignupScreen.tsx";

function RequestLink() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (sent) {
    return (
      <AuthLayout title="Check your email">
        <Alert tone="success">
          If an account exists for that address, we've sent a link to reset the
          password. It works for 30 minutes.
        </Alert>
        <Link href="/signin" className="font-semibold text-brand">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Reset your password"
      intro="We'll email you a link to choose a new one."
    >
      <FormError error={error} />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          unwrap(
            api.POST("/auth/password-reset/request", {
              body: { email: email.trim() },
            }),
          )
            .then(() => {
              setSent(true);
            })
            .catch(setError)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          isRequired
          value={email}
          onChange={setEmail}
        />
        <Button type="submit" size="lg" className="w-full" isPending={busy}>
          Send reset link
        </Button>
      </form>
      <Link href="/signin" className="font-semibold text-brand">
        Back to sign in
      </Link>
    </AuthLayout>
  );
}

function ChooseNewPassword({ token }: { token: string }) {
  const { forget, status } = useAuth();
  const check = useQuery({
    // A fixed key: the token stays in one place (F-50), never in the query
    // cache. gcTime 0 drops the result as soon as the screen unmounts.
    queryKey: ["reset-verify"],
    staleTime: Infinity,
    gcTime: 0,
    retry: shouldRetry,
    queryFn: () =>
      unwrap(api.POST("/auth/password-reset/verify", { body: { token } })),
  });
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const complete = async (mfa?: MfaProof) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/auth/password-reset/complete", {
          body: mfa
            ? { token, newPassword: password, mfa }
            : { token, newPassword: password },
        }),
      );
      clearLinkToken();
      // Every session was revoked, this one included.
      if (status.kind !== "signedOut") forget();
      setDone(true);
    } catch (e) {
      if (!mfa && e instanceof ApiError && e.code === "MFA_REQUIRED") {
        // MFA was turned on after the link was checked (errors.md: show the
        // MFA step). Re-check the link for the methods, then ask for one.
        const fresh = await check.refetch();
        if (fresh.data?.mfaRequired && fresh.data.mfaMethods.length > 0) {
          setStep("mfa");
          return;
        }
      }
      setError(e);
      if (e instanceof ApiError && e.code === "VALIDATION_FAILED")
        setStep("password");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout title="Password changed">
        <Alert tone="success">
          Your password is changed and you've been signed out everywhere.
        </Alert>
        <Link
          href="/signin"
          className="flex min-h-touch items-center font-semibold text-brand"
        >
          Sign in with your new password
        </Link>
      </AuthLayout>
    );
  }
  const expired =
    (check.error instanceof ApiError && check.error.code === "TOKEN_INVALID") ||
    (error instanceof ApiError && error.code === "TOKEN_INVALID");
  if (expired) {
    return (
      <AuthLayout
        title="Link expired"
        intro="This reset link has expired or was already used."
      >
        <Link
          href="/reset-password"
          onPress={clearLinkToken}
          className="flex min-h-touch items-center font-semibold text-brand"
        >
          Request a new link
        </Link>
      </AuthLayout>
    );
  }
  if (check.isPending) {
    return (
      <AuthLayout title="Choose a new password">
        <LoadingState rows={2} label="Checking your link…" />
      </AuthLayout>
    );
  }
  if (check.isError) {
    return (
      <AuthLayout title="Choose a new password">
        <ErrorState error={check.error} onRetry={() => void check.refetch()} />
      </AuthLayout>
    );
  }

  const fields =
    error instanceof ApiError
      ? mapFieldErrors(error.details, ["newPassword"], PASSWORD_COPY).fields
      : {};
  return (
    <AuthLayout title="Choose a new password">
      <FormError error={Object.keys(fields).length > 0 ? null : error} />
      {step === "password" ? (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (check.data.mfaRequired) setStep("mfa");
            else void complete().catch(() => undefined);
          }}
        >
          <TextField
            label="New password"
            description="At least 12 characters."
            type="password"
            autoComplete="new-password"
            isRequired
            value={password}
            onChange={setPassword}
            {...(fields.newPassword
              ? { errorMessage: fields.newPassword }
              : {})}
          />
          <Button type="submit" size="lg" className="w-full" isPending={busy}>
            {check.data.mfaRequired ? "Continue" : "Change password"}
          </Button>
        </form>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            Your account uses two-step verification. Confirm it's you.
          </p>
          <SecondFactor
            methods={check.data.mfaMethods}
            submitLabel="Change password"
            onProof={(proof) => complete(proof)}
            getPasskeyOptions={() =>
              unwrap(
                api.POST("/auth/password-reset/webauthn-challenge", {
                  body: { token },
                }),
              )
            }
            onError={setError}
          />
        </>
      )}
    </AuthLayout>
  );
}

export default function ResetPasswordScreen() {
  const [token] = useState(() => peekLinkToken("/reset-password"));
  return token ? <ChooseNewPassword token={token} /> : <RequestLink />;
}

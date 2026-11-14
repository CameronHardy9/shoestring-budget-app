// /signin (auth.md §5): email + password, then the second factor when the
// account has MFA. Success applies the AuthState; the router guard then
// returns to the remembered path (memory only) or the home route.
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import { useAuth } from "../../app/auth.tsx";
import { Button } from "../../components/Button.tsx";
import { SecondFactor } from "../../components/SecondFactor.tsx";
import { FormError } from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { AuthLayout } from "./AuthLayout.tsx";

function MfaStep() {
  const { status, applyAuthState, forget } = useAuth();
  const [error, setError] = useState<unknown>(null);
  if (status.kind !== "mfa") return null;
  return (
    <AuthLayout
      title="Two-step verification"
      intro="Confirm it's you to finish signing in."
    >
      <FormError error={error} />
      <SecondFactor
        methods={status.methods}
        onProof={async (proof) => {
          setError(null);
          try {
            applyAuthState(
              await unwrap(api.POST("/auth/mfa/verify", { body: proof })),
            );
          } catch (e) {
            setError(e);
            throw e;
          }
        }}
        getPasskeyOptions={() =>
          unwrap(
            api.POST("/auth/webauthn/challenge", { body: { purpose: "mfa" } }),
          )
        }
        onError={setError}
      />
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onPress={() => {
          void unwrap(api.POST("/auth/logout")).finally(forget);
        }}
      >
        Cancel and start over
      </Button>
    </AuthLayout>
  );
}

export default function SignInScreen() {
  const { status, applyAuthState } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status.kind === "mfa") return <MfaStep />;

  const fields =
    error instanceof ApiError
      ? mapFieldErrors(error.details, ["email", "password"]).fields
      : {};

  return (
    <AuthLayout
      title="Sign in"
      intro="Your budget, a few taps away."
      footer="Shoestring is invite-only. Ask the person who runs it for an invitation."
    >
      {/* Field-level validation shows on the fields; everything else here. */}
      <FormError error={Object.keys(fields).length > 0 ? null : error} />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          unwrap(
            api.POST("/auth/login", {
              body: { email: email.trim(), password },
            }),
          )
            .then(applyAuthState)
            .catch(setError)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <TextField
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          isRequired
          value={email}
          onChange={setEmail}
          {...(fields.email ? { errorMessage: fields.email } : {})}
        />
        <TextField
          label="Password"
          name="password"
          type={reveal ? "text" : "password"}
          autoComplete="current-password"
          isRequired
          value={password}
          onChange={setPassword}
          {...(fields.password ? { errorMessage: fields.password } : {})}
          trailing={
            <Button
              variant="ghost"
              size="sm"
              aria-label={reveal ? "Hide password" : "Show password"}
              onPress={() => {
                setReveal((v) => !v);
              }}
            >
              {reveal ? "Hide" : "Show"}
            </Button>
          }
        />
        <Link
          href="/reset-password"
          className="flex min-h-touch items-center self-end text-sm font-semibold text-brand"
        >
          Forgot password?
        </Link>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          isPending={busy}
          data-testid="sign-in-submit"
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

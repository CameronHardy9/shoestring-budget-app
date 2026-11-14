// /signup#token=… (auth.md §4, J1): check the invite, then name + password.
// The email comes from the invite. Success signs the person in and goes to
// onboarding (create the first budget).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import { useAuth } from "../../app/auth.tsx";
import { shouldRetry } from "../../app/query.ts";
import { navigate } from "../../app/router.tsx";
import { Button } from "../../components/Button.tsx";
import {
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { clearLinkToken, peekLinkToken } from "../../lib/link-token.ts";
import { AuthLayout } from "./AuthLayout.tsx";

export const PASSWORD_COPY = {
  too_short: "Use at least 12 characters.",
  too_long: "Use at most 128 characters.",
};

export default function SignupScreen() {
  const { applyAuthState } = useAuth();
  const [token] = useState(() => peekLinkToken("/signup"));
  const preview = useQuery({
    queryKey: ["signup-preview", token],
    enabled: token !== null,
    staleTime: Infinity,
    retry: shouldRetry,
    queryFn: () =>
      unwrap(
        api.POST("/auth/signup/preview", { body: { token: token ?? "" } }),
      ),
  });
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (
    token === null ||
    (preview.error instanceof ApiError &&
      preview.error.code === "INVITATION_INVALID")
  ) {
    return (
      <AuthLayout
        title="Invitation not valid"
        intro="This invitation link has expired, was already used, or is incomplete. Ask the person who invited you for a new one."
      >
        <Link href="/signin" className="font-semibold text-brand">
          Already have an account? Sign in
        </Link>
      </AuthLayout>
    );
  }
  if (preview.isPending) {
    return (
      <AuthLayout title="Create your account">
        <LoadingState rows={2} label="Checking your invitation…" />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    return (
      <AuthLayout title="Create your account">
        <ErrorState
          error={preview.error}
          onRetry={() => void preview.refetch()}
        />
      </AuthLayout>
    );
  }

  const mapped =
    error instanceof ApiError
      ? mapFieldErrors(
          error.details,
          ["displayName", "password"],
          PASSWORD_COPY,
        )
      : null;
  const fields = mapped?.fields ?? {};

  return (
    <AuthLayout
      title="Create your account"
      intro={
        <>
          You're invited as{" "}
          <span className="font-semibold text-fg">{preview.data.email}</span>.
        </>
      }
    >
      <FormError error={Object.keys(fields).length > 0 ? null : error} />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          unwrap(
            api.POST("/auth/signup", {
              body: { token, displayName: displayName.trim(), password },
            }),
          )
            .then((state) => {
              clearLinkToken();
              applyAuthState(state);
              navigate("/budgets/new", { replace: true });
            })
            .catch(setError)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <TextField
          label="Your name"
          description="Shown to people you share a budget with."
          name="name"
          autoComplete="name"
          maxLength={50}
          isRequired
          value={displayName}
          onChange={setDisplayName}
          {...(fields.displayName ? { errorMessage: fields.displayName } : {})}
        />
        <TextField
          label="Password"
          description="At least 12 characters. A short sentence works well."
          name="new-password"
          type={reveal ? "text" : "password"}
          autoComplete="new-password"
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
        <Button
          type="submit"
          size="lg"
          className="w-full"
          isPending={busy}
          data-testid="sign-up-submit"
        >
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

// DEV PREVIEW ONLY: sign-in, static. The real screen arrives in task 6.
import { useState } from "react";
import { ERROR_COPY } from "../api/messages.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { TextField } from "../components/TextField.tsx";
import { LogoMark } from "./LogoMark.tsx";

export function SignInScreen({ showError }: { showError: boolean }) {
  const [reveal, setReveal] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col px-6 pt-14 pb-8">
      <div className="flex items-center gap-2.5 text-xl font-bold text-fg">
        <LogoMark />
        Shoestring
      </div>
      <h1 className="mt-12 text-3xl font-semibold text-fg">Sign in</h1>
      <p className="mt-1 text-base text-fg-muted">
        Your budget, a few taps away.
      </p>

      {showError ? (
        <Alert tone="danger" className="mt-6">
          {ERROR_COPY.INVALID_CREDENTIALS.message}
        </Alert>
      ) : null}

      <form
        className="mt-6 flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <TextField
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          defaultValue="alex@example.com"
        />
        <TextField
          label="Password"
          name="password"
          type={reveal ? "text" : "password"}
          autoComplete="current-password"
          defaultValue="correct horse battery"
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
        <a
          href="/reset-password"
          className="flex min-h-touch items-center self-end text-sm font-semibold text-brand"
        >
          Forgot password?
        </a>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          data-testid="sign-in-submit"
        >
          Sign in
        </Button>
      </form>

      <p className="mt-auto pt-10 text-center text-sm text-fg-muted">
        Shoestring is invite-only. Ask the person who runs it for an invitation.
      </p>
    </main>
  );
}

// /settings/account (task 12): name, email change, password change, CSV
// export and account deletion. Email, password, export and deletion need a
// recent re-authentication (useReauth).
import { useState } from "react";
import { Link } from "react-aria-components";
import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { mapFieldErrors } from "../../api/messages.ts";
import { useAuth, useMe } from "../../app/auth.tsx";
import { useReauth } from "../../app/reauth.tsx";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { Alert } from "../../components/Alert.tsx";
import { AppShell } from "../../components/AppShell.tsx";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { PageColumn, Section } from "../../components/Section.tsx";
import { FormError } from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { getLastBudgetId } from "../../lib/preferences.ts";
import { PASSWORD_COPY } from "../auth/SignupScreen.tsx";

function fieldsOf(error: unknown, names: string[], copy = {}) {
  return error instanceof ApiError
    ? mapFieldErrors(error.details, names, copy).fields
    : {};
}

function NameForm() {
  const me = useMe();
  const { setMe } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me.displayName);
  const action = useAction();
  const fields = fieldsOf(action.error, ["displayName"]);
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === "" || name.trim() === me.displayName) return;
        void action.run(async () => {
          setMe(
            await unwrap(
              api.PATCH("/me", { body: { displayName: name.trim() } }),
            ),
          );
          toast("Name updated");
        });
      }}
    >
      <TextField
        label="Your name"
        description="Shown to people you share a budget with."
        maxLength={50}
        value={name}
        onChange={setName}
        errorMessage={fields.displayName}
      />
      <FormError error={Object.keys(fields).length > 0 ? null : action.error} />
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        isPending={action.busy}
      >
        Save name
      </Button>
    </form>
  );
}

function EmailForm() {
  const me = useMe();
  const reauth = useReauth();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const action = useAction();
  const fields = fieldsOf(action.error, ["newEmail"], {
    invalid_value: "That's already your email.",
  });
  if (sentTo) {
    return (
      <Alert tone="success">
        Check {sentTo} for a confirmation link (it works for 24 hours). Until
        you confirm, you still sign in with {me.email}. We also told your
        current address.
      </Alert>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const next = email.trim();
        if (next === "") return;
        void action.run(async () => {
          await reauth(() =>
            unwrap(api.POST("/me/email-change", { body: { newEmail: next } })),
          );
          setSentTo(next);
        });
      }}
    >
      <p className="text-sm text-fg">
        Signed in as <span className="font-semibold">{me.email}</span>
      </p>
      <TextField
        label="New email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        value={email}
        onChange={setEmail}
        errorMessage={fields.newEmail}
      />
      <FormError error={Object.keys(fields).length > 0 ? null : action.error} />
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        isPending={action.busy}
        data-testid="change-email"
      >
        Send confirmation link
      </Button>
    </form>
  );
}

function PasswordForm() {
  const reauth = useReauth();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const action = useAction();
  const fields = fieldsOf(action.error, ["newPassword"], PASSWORD_COPY);
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setMismatch(password !== again);
        if (password !== again || password === "") return;
        void action.run(async () => {
          await reauth(() =>
            unwrap(
              api.POST("/me/password", { body: { newPassword: password } }),
            ),
          );
          setPassword("");
          setAgain("");
          toast("Password changed. Other devices were signed out.");
        });
      }}
    >
      <TextField
        label="New password"
        description="At least 12 characters."
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        errorMessage={fields.newPassword}
      />
      <TextField
        label="New password again"
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={setAgain}
        errorMessage={mismatch ? "The passwords don't match." : undefined}
      />
      <FormError error={Object.keys(fields).length > 0 ? null : action.error} />
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        isPending={action.busy}
        data-testid="change-password"
      >
        Change password
      </Button>
    </form>
  );
}

function ExportButtons() {
  const reauth = useReauth();
  const action = useAction();
  const download = (kind: "transactions" | "plans") =>
    void action.run(async () => {
      const blob = await reauth(() =>
        unwrap(
          api.POST("/me/export", {
            body: { kind },
            parseAs: "blob",
            headers: { Accept: "text/csv" },
          }),
        ),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `shoestring-${kind}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        A spreadsheet file of every budget you're in. It stays on this device
        once downloaded, so keep it somewhere private.
      </p>
      <FormError error={action.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          isPending={action.busy}
          onPress={() => {
            download("transactions");
          }}
          data-testid="export-transactions"
        >
          Transactions (CSV)
        </Button>
        <Button
          variant="secondary"
          isPending={action.busy}
          onPress={() => {
            download("plans");
          }}
        >
          Monthly limits (CSV)
        </Button>
      </div>
    </div>
  );
}

function DeleteAccount() {
  const reauth = useReauth();
  const toast = useToast();
  const { forget } = useAuth();
  const [open, setOpen] = useState(false);
  const action = useAction();
  const blocked =
    action.error instanceof ApiError &&
    action.error.code === "OWNS_SHARED_BUDGET";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        Your account is deleted after 30 days. Sign in before then to change
        your mind. Every budget you own, including deleted ones you could still
        restore, is deleted with it. You'll be signed out everywhere.
      </p>
      {blocked ? (
        <p
          role="alert"
          className="rounded-md bg-danger-soft p-3 text-sm text-fg"
        >
          You own a budget other people use. Make someone else its owner, remove
          its members, or delete it first, from its Members &amp; settings page.
        </p>
      ) : null}
      <Button
        variant="danger"
        className="self-start"
        onPress={() => {
          action.setError(null);
          setOpen(true);
        }}
        data-testid="delete-account"
      >
        Delete my account
      </Button>
      <ConfirmDialog
        isOpen={open}
        title="Delete your account?"
        confirmLabel="Delete account"
        busy={action.busy}
        error={blocked ? null : action.error}
        onCancel={() => {
          setOpen(false);
        }}
        onConfirm={() =>
          void action.run(async () => {
            try {
              await reauth(() => unwrap(api.POST("/me/deletion")));
            } catch (e) {
              setOpen(false);
              throw e;
            }
            setOpen(false);
            toast(
              "Account deletion scheduled. Sign in within 30 days to cancel it.",
            );
            // Every session was revoked, this one included.
            forget();
          })
        }
      >
        This can be undone for 30 days by signing in again.
      </ConfirmDialog>
    </div>
  );
}

export default function AccountScreen() {
  return (
    <AppShell active="more" budgetId={getLastBudgetId()}>
      <PageColumn title="Account">
        <Section title="Profile" id="profile-heading">
          <NameForm />
        </Section>
        <Section title="Email" id="email-heading">
          <EmailForm />
        </Section>
        <Section title="Password" id="password-heading">
          <PasswordForm />
        </Section>
        <Section title="Export your data" id="export-heading">
          <ExportButtons />
        </Section>
        <Section title="Delete account" id="delete-account-heading">
          <DeleteAccount />
        </Section>
        <Link
          href="/settings/security"
          className="flex min-h-touch items-center font-semibold text-brand"
        >
          Two-step verification settings
        </Link>
      </PageColumn>
    </AppShell>
  );
}

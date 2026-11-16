// Shown instead of any signed-in screen while the account is pending
// deletion (auth.md §11, §15): keep the account, export the data, or sign out.
import { useState } from "react";
import { api, unwrap } from "../../api/client.ts";
import { useAuth } from "../../app/auth.tsx";
import { Button } from "../../components/Button.tsx";
import { ExportButtons } from "../../components/ExportButtons.tsx";
import { SignOutButton } from "../../components/SignOutButton.tsx";
import { FormError } from "../../components/States.tsx";
import { AuthLayout } from "./AuthLayout.tsx";

export default function PendingDeletionScreen() {
  const { status, setMe } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const deletion = status.kind === "signedIn" ? status.me.deletion : null;
  const when = deletion
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(
        new Date(deletion.purgeAfter),
      )
    : "";
  return (
    <AuthLayout
      title="Account scheduled for deletion"
      intro={`Your account and every budget you own will be permanently deleted on ${when}.`}
    >
      <FormError error={error} />
      <Button
        size="lg"
        className="w-full"
        isPending={busy}
        onPress={() => {
          setBusy(true);
          unwrap(api.DELETE("/me/deletion"))
            .then(setMe)
            .catch(setError)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        Keep my account
      </Button>
      <section aria-labelledby="export-heading" className="flex flex-col gap-2">
        <h2 id="export-heading" className="text-base font-semibold text-fg">
          Export your data
        </h2>
        <ExportButtons />
      </section>
      <SignOutButton />
    </AuthLayout>
  );
}

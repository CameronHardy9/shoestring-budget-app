// CSV export of every budget the person is in (POST /me/export, x-reauth).
// Shared by Account settings and the pending-deletion screen (auth.md §11,
// §15: an account scheduled for deletion can still export).
import { api, unwrap } from "../api/client.ts";
import { useReauth } from "../app/reauth.tsx";
import { useAction } from "../app/useAction.ts";
import { saveBlob } from "../lib/download.ts";
import { Button } from "./Button.tsx";
import { FormError } from "./States.tsx";

export function ExportButtons() {
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
      saveBlob(blob, `shoestring-${kind}.csv`);
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

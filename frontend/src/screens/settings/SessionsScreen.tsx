// /settings/sessions (email link for new_sign_in, login_throttled): where I'm
// signed in. Revoke one device, or every device but this one. Revoking this
// device signs out here.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../../api/client.ts";
import type { Schemas } from "../../api/types.ts";
import { useAuth } from "../../app/auth.tsx";
import { moreKeys, useSessions } from "../../app/data.ts";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { AppShell } from "../../components/AppShell.tsx";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { PageColumn } from "../../components/Section.tsx";
import {
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { getLastBudgetId } from "../../lib/preferences.ts";

type Session = Schemas["SessionInfo"];

const BROWSER: Record<Schemas["DeviceBrowser"], string> = {
  safari: "Safari",
  chrome: "Chrome",
  firefox: "Firefox",
  edge: "Edge",
  samsung_internet: "Samsung Internet",
  other: "A browser",
  unknown: "Unknown browser",
};
const OS: Record<Schemas["DeviceOs"], string> = {
  ios: "iPhone",
  ipados: "iPad",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  other: "another device",
  unknown: "an unknown device",
};

export function deviceLabel(s: Pick<Session, "browser" | "os">): string {
  return `${BROWSER[s.browser]} on ${OS[s.os]}`;
}

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

export default function SessionsScreen() {
  const client = useQueryClient();
  const toast = useToast();
  const { signOut } = useAuth();
  const sessions = useSessions();
  const [revoking, setRevoking] = useState<Session | "others" | null>(null);
  const action = useAction();

  const confirm = () =>
    void action.run(async () => {
      if (revoking === "others") {
        await unwrap(api.POST("/me/sessions/revoke-others"));
        toast("Signed out everywhere else");
      } else if (revoking) {
        await unwrap(
          api.DELETE("/me/sessions/{sessionId}", {
            params: { path: { sessionId: revoking.id } },
          }),
        );
        if (revoking.current) {
          // Already revoked by the DELETE: a failed logout call can't leave
          // this session live, so leave even if it fails (F-51).
          await signOut({ revoked: true });
          return;
        }
        toast(`Signed out ${deviceLabel(revoking)}`);
      }
      setRevoking(null);
      await client.invalidateQueries({ queryKey: moreKeys.sessions });
    });

  const items = sessions.data?.items ?? [];
  return (
    <AppShell active="more" budgetId={getLastBudgetId()}>
      <PageColumn
        title="Signed-in devices"
        intro="If you don't recognize a device, sign it out and change your password."
      >
        <FormError error={revoking ? null : action.error} />
        {sessions.isPending ? (
          <LoadingState rows={2} />
        ) : sessions.isError ? (
          <ErrorState
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          />
        ) : (
          <>
            <ul
              className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1"
              data-testid="session-list"
            >
              {[...items]
                .sort(
                  (a, b) =>
                    Number(b.current) - Number(a.current) ||
                    b.lastSeenAt.localeCompare(a.lastSeenAt),
                )
                .map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium text-fg">
                        {deviceLabel(s)}
                        {s.current ? (
                          <span className="text-sm font-semibold text-success">
                            {" "}
                            · This device
                          </span>
                        ) : null}
                      </span>
                      <span className="text-sm text-fg-muted">
                        Signed in {when(s.createdAt)} · last active{" "}
                        {when(s.lastSeenAt)}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Sign out ${deviceLabel(s)}${s.current ? " (this device)" : ""}`}
                      onPress={() => {
                        action.setError(null);
                        setRevoking(s);
                      }}
                    >
                      Sign out
                    </Button>
                  </li>
                ))}
            </ul>
            {items.length > 1 ? (
              <Button
                variant="secondary"
                onPress={() => {
                  action.setError(null);
                  setRevoking("others");
                }}
                data-testid="revoke-others"
              >
                Sign out everywhere else
              </Button>
            ) : null}
          </>
        )}
      </PageColumn>
      <ConfirmDialog
        isOpen={revoking !== null}
        title={
          revoking === "others"
            ? "Sign out every other device?"
            : revoking?.current
              ? "Sign out of this device?"
              : `Sign out ${revoking ? deviceLabel(revoking) : ""}?`
        }
        confirmLabel="Sign out"
        busy={action.busy}
        error={action.error}
        onCancel={() => {
          setRevoking(null);
        }}
        onConfirm={confirm}
      >
        {revoking === "others"
          ? "Every device except this one will need to sign in again."
          : "That device will need to sign in again."}
      </ConfirmDialog>
    </AppShell>
  );
}

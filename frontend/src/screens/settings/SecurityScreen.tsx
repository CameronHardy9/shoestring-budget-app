// /settings/security (email link for MFA notices): two-step verification.
// Add an authenticator app (TOTP, QR drawn on the device, no third-party
// service) or a passkey, remove factors, and make new recovery codes (shown
// once). Every change needs a recent re-authentication (useReauth).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { encode } from "uqr";
import { Link } from "react-aria-components";
import { useToast } from "../../app/toast.tsx";
import { useAction } from "../../app/useAction.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";

import { api, unwrap } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import type { Schemas } from "../../api/types.ts";
import { useAuth } from "../../app/auth.tsx";
import { keys } from "../../app/data.ts";
import { ReauthCancelled, useReauth } from "../../app/reauth.tsx";
import {
  createCredential,
  isPasskeyCancel,
  passkeysSupported,
} from "../../app/webauthn.ts";
import { Alert } from "../../components/Alert.tsx";
import { AppShell } from "../../components/AppShell.tsx";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import {
  ErrorState,
  FormError,
  LoadingState,
} from "../../components/States.tsx";
import { TextField } from "../../components/TextField.tsx";
import { saveBlob } from "../../lib/download.ts";
import { getLastBudgetId } from "../../lib/preferences.ts";

/** QR code drawn as SVG rectangles from uqr's module matrix. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  const cells: string[] = [];
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) cells.push(`M${String(x)} ${String(y)}h1v1h-1z`);
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className="size-52 rounded-md"
      shapeRendering="crispEdges"
    >
      {/* Literal black on white in both themes: scanners need the contrast. */}
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.join("")} fill="#000000" />
    </svg>
  );
}

export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const text = `Shoestring recovery codes (each works once):\n${codes.join("\n")}\n`;
  return (
    <div className="flex flex-col gap-4" data-testid="recovery-codes">
      <Alert tone="warning">
        Save these recovery codes somewhere safe, like a password manager. Each
        works once if you lose your phone or passkey. They won't be shown again.
      </Alert>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-sunken p-3 font-mono text-base text-fg">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {typeof navigator.clipboard === "undefined" ? null : (
          <Button
            variant="secondary"
            className="flex-1"
            onPress={() => void navigator.clipboard.writeText(text)}
          >
            Copy
          </Button>
        )}
        <Button
          variant="secondary"
          className="flex-1"
          onPress={() => {
            saveBlob(
              new Blob([text], { type: "text/plain" }),
              "shoestring-recovery-codes.txt",
            );
          }}
        >
          Download
        </Button>
      </div>
      <label className="flex min-h-touch items-center gap-3 text-base text-fg">
        <input
          type="checkbox"
          className="size-5 accent-brand"
          checked={saved}
          onChange={(e) => {
            setSaved(e.target.checked);
          }}
        />
        I've saved my recovery codes
      </label>
      <Button size="lg" isDisabled={!saved} onPress={onDone}>
        Done
      </Button>
    </div>
  );
}

type Flow = "totp" | "passkey" | "codes" | null;

function TotpSetup({ onFinished }: { onFinished: () => void }) {
  const reauth = useReauth();
  const [setup, setSetup] = useState<Schemas["TotpSetup"] | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof ReauthCancelled)) setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={onFinished} />;
  if (!setup) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-fg">
          Use an authenticator app such as 1Password, Google Authenticator or
          Authy. You'll scan a code, then enter the 6 digits it shows.
        </p>
        <FormError error={error} />
        <Button
          size="lg"
          isPending={busy}
          onPress={() =>
            void run(async () => {
              setSetup(await reauth(() => unwrap(api.POST("/me/mfa/totp"))));
            })
          }
        >
          Continue
        </Button>
      </div>
    );
  }
  const secretGroups = setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!/^\d{6}$/.test(code.trim())) {
          setError(null);
          return;
        }
        void run(async () => {
          const result = await reauth(() =>
            unwrap(
              api.POST("/me/mfa/totp/confirm", { body: { code: code.trim() } }),
            ),
          );
          if (result.recoveryCodes) setCodes(result.recoveryCodes);
          else onFinished();
        });
      }}
    >
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-fg">
        <li>Scan this code with your authenticator app.</li>
      </ol>
      <div className="flex justify-center">
        <QrCode
          value={setup.otpauthUri}
          label="QR code to add Shoestring to your authenticator app"
        />
      </div>
      <p className="text-sm text-fg-muted">
        Can't scan? Enter this key instead:{" "}
        <span className="font-mono text-base break-words text-fg select-all">
          {secretGroups}
        </span>
      </p>
      <TextField
        label="2. Enter the 6-digit code from the app"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={setCode}
        {...(error instanceof ApiError && error.code === "MFA_FAILED"
          ? {
              errorMessage:
                "That code didn't work. Check the time on your phone and try the newest code.",
            }
          : {})}
      />
      <FormError
        error={
          error instanceof ApiError && error.code === "MFA_FAILED"
            ? null
            : error
        }
      />
      <Button type="submit" size="lg" isPending={busy}>
        Turn on
      </Button>
    </form>
  );
}

function PasskeySetup({ onFinished }: { onFinished: () => void }) {
  const reauth = useReauth();
  const [name, setName] = useState("Passkey");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (codes) return <RecoveryCodes codes={codes} onDone={onFinished} />;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        (async () => {
          const options = await reauth(() =>
            unwrap(api.POST("/me/mfa/passkeys/options")),
          );
          const credential = await createCredential(options);
          const result = await reauth(() =>
            unwrap(
              api.POST("/me/mfa/passkeys", {
                body: { name: name.trim() || "Passkey", credential },
              }),
            ),
          );
          if (result.recoveryCodes) setCodes(result.recoveryCodes);
          else onFinished();
        })()
          .catch((e: unknown) => {
            if (!(e instanceof ReauthCancelled) && !isPasskeyCancel(e))
              setError(e);
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <p className="text-fg">
        A passkey uses your phone's or computer's screen lock (Face ID,
        fingerprint or PIN) as your second step.
      </p>
      <TextField
        label="Name this passkey"
        description="So you can tell your devices apart, e.g. 'iPhone'."
        maxLength={40}
        value={name}
        onChange={setName}
      />
      <FormError error={error} />
      <Button type="submit" size="lg" isPending={busy}>
        Create passkey
      </Button>
    </form>
  );
}

type Removal =
  { kind: "totp" } | { kind: "passkey"; id: string; name: string } | null;

export default function SecurityScreen() {
  const client = useQueryClient();
  const { refresh } = useAuth();
  const reauth = useReauth();
  const toast = useToast();
  const [flow, setFlow] = useState<Flow>(null);
  const [removing, setRemoving] = useState<Removal>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const action = useAction();
  const mfa = useQuery({
    queryKey: keys.mfa,
    queryFn: () => unwrap(api.GET("/me/mfa")),
  });

  const finish = () => {
    setFlow(null);
    setNewCodes(null);
    void client.invalidateQueries({ queryKey: keys.mfa });
    void refresh();
  };

  const factorCount = mfa.data
    ? (mfa.data.totp.enabled ? 1 : 0) + mfa.data.passkeys.length
    : 0;
  const lastFactor = factorCount === 1;

  const remove = () =>
    void action.run(async () => {
      if (!removing) return;
      if (removing.kind === "totp")
        await reauth(() => unwrap(api.DELETE("/me/mfa/totp")));
      else
        await reauth(() =>
          unwrap(
            api.DELETE("/me/mfa/passkeys/{passkeyId}", {
              params: { path: { passkeyId: removing.id } },
            }),
          ),
        );
      setRemoving(null);
      toast(
        removing.kind === "totp"
          ? "Authenticator app removed"
          : `Removed ${removing.name}`,
      );
      finish();
    });

  const regenerate = () =>
    void action.run(async () => {
      const result = await reauth(() =>
        unwrap(api.POST("/me/mfa/recovery-codes")),
      );
      setNewCodes(result.recoveryCodes);
      setFlow("codes");
    });

  return (
    <AppShell active="more" budgetId={getLastBudgetId()}>
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-6 lg:px-8 lg:pt-8">
        <h1 className="text-2xl font-semibold text-fg">Security</h1>
        <FormError error={removing ? null : action.error} />
        {mfa.isPending ? (
          <LoadingState rows={2} />
        ) : mfa.isError ? (
          <ErrorState error={mfa.error} onRetry={() => void mfa.refetch()} />
        ) : (
          <>
            <section
              className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-1"
              aria-labelledby="mfa-heading"
            >
              <h2
                id="mfa-heading"
                className="flex items-center gap-2 text-lg font-semibold text-fg"
              >
                <Icon name="shield" /> Two-step verification
              </h2>
              <p
                className={
                  mfa.data.enabled
                    ? "font-medium text-success"
                    : "text-fg-muted"
                }
                data-testid="mfa-status"
              >
                {mfa.data.enabled
                  ? "On. Signing in needs your password and a second step."
                  : "Off. Add a second step so a stolen password alone can't open your account."}
              </p>
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="font-medium text-fg">Authenticator app</p>
                {mfa.data.totp.enabled ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-success">Set up</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => {
                        setRemoving({ kind: "totp" });
                      }}
                      data-testid="remove-totp"
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    className="self-start"
                    onPress={() => {
                      setFlow("totp");
                    }}
                    data-testid="setup-totp"
                  >
                    Set up authenticator app
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="font-medium text-fg">Passkeys</p>
                {mfa.data.passkeys.length > 0 ? (
                  <ul
                    className="divide-y divide-line"
                    data-testid="passkey-list"
                  >
                    {mfa.data.passkeys.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 py-1.5"
                      >
                        <span className="text-fg">{p.name}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Remove passkey ${p.name}`}
                          onPress={() => {
                            setRemoving({
                              kind: "passkey",
                              id: p.id,
                              name: p.name,
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {passkeysSupported() && mfa.data.passkeys.length < 10 ? (
                  <Button
                    variant="secondary"
                    className="self-start"
                    onPress={() => {
                      setFlow("passkey");
                    }}
                  >
                    Add a passkey
                  </Button>
                ) : passkeysSupported() ? null : (
                  <p className="text-sm text-fg-muted">
                    This browser can't create passkeys.
                  </p>
                )}
              </div>
              {mfa.data.enabled ? (
                <div className="flex flex-col gap-2 border-t border-line pt-3">
                  <p className="font-medium text-fg">Recovery codes</p>
                  <p
                    className={`text-sm ${mfa.data.recoveryCodesRemaining <= 3 ? "font-medium text-warning" : "text-fg-muted"}`}
                  >
                    {mfa.data.recoveryCodesRemaining} of 10 left.
                    {mfa.data.recoveryCodesRemaining <= 3
                      ? " Make new ones soon."
                      : ""}
                  </p>
                  <Button
                    variant="secondary"
                    className="self-start"
                    isPending={action.busy && removing === null}
                    onPress={regenerate}
                    data-testid="regenerate-codes"
                  >
                    Make new recovery codes
                  </Button>
                </div>
              ) : null}
            </section>
            <p className="text-sm text-fg-muted">
              Password and email are under{" "}
              <Link
                href="/settings/account"
                className="font-semibold text-brand"
              >
                Account
              </Link>
              .
            </p>
          </>
        )}
      </div>
      <Sheet
        title={
          flow === "passkey"
            ? "Add a passkey"
            : flow === "codes"
              ? "New recovery codes"
              : "Set up authenticator app"
        }
        isOpen={flow !== null}
        onOpenChange={(open) => {
          if (!open) {
            if (flow === "codes") finish();
            else setFlow(null);
          }
        }}
      >
        {flow === "totp" ? <TotpSetup onFinished={finish} /> : null}
        {flow === "passkey" ? <PasskeySetup onFinished={finish} /> : null}
        {flow === "codes" && newCodes ? (
          <RecoveryCodes codes={newCodes} onDone={finish} />
        ) : null}
      </Sheet>
      <ConfirmDialog
        isOpen={removing !== null}
        title={
          removing?.kind === "totp"
            ? "Remove the authenticator app?"
            : `Remove ${removing?.kind === "passkey" ? removing.name : ""}?`
        }
        confirmLabel="Remove"
        busy={action.busy}
        error={action.error}
        onCancel={() => {
          setRemoving(null);
          action.setError(null);
        }}
        onConfirm={remove}
      >
        {lastFactor
          ? "This is your only second step: two-step verification turns off and your recovery codes stop working."
          : "You'll still have your other second step."}
      </ConfirmDialog>
    </AppShell>
  );
}

// /budgets/new (J1): name, starter categories and this month's limits, created
// atomically by one POST /budgets with an Idempotency-Key (safe to retry).
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { CheckboxButton, CheckboxField } from "react-aria-components";
import { api, unwrap } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import { newIdempotencyKey } from "../api/ids.ts";
import { mapFieldErrors } from "../api/messages.ts";
import type { Schemas } from "../api/types.ts";
import { keys } from "../app/data.ts";
import { navigate } from "../app/router.tsx";
import { AmountField } from "../components/AmountField.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { LogoMark } from "../components/Logo.tsx";
import { FormError } from "../components/States.tsx";
import { TextField } from "../components/TextField.tsx";
import { parseMoneyInput } from "../lib/money.ts";

interface Starter {
  name: string;
  kind: Schemas["CategoryKind"];
  on: boolean;
  amount: string;
}

export const STARTERS: readonly Omit<Starter, "on" | "amount">[] = [
  { name: "Housing", kind: "expense" },
  { name: "Groceries", kind: "expense" },
  { name: "Dining out", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Utilities", kind: "expense" },
  { name: "Household", kind: "expense" },
  { name: "Health", kind: "expense" },
  { name: "Fun", kind: "expense" },
  { name: "Salary", kind: "income" },
];

export function deviceTimezone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
    );
  } catch {
    return "America/New_York";
  }
}

export default function CreateBudgetScreen() {
  const client = useQueryClient();
  const [name, setName] = useState("Home");
  const [starters, setStarters] = useState<Starter[]>(() =>
    STARTERS.map((s) => ({ ...s, on: true, amount: "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);
  const key = useRef(newIdempotencyKey());

  const parsed = starters.map((s) =>
    s.amount.trim() === "" ? null : parseMoneyInput(s.amount, { min: 0 }),
  );
  const invalid = parsed.some((p) => p !== null && !p.ok);
  const fields =
    error instanceof ApiError
      ? mapFieldErrors(error.details, ["name"]).fields
      : {};

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-5 pt-10 pb-10">
      <div className="flex items-center gap-2.5 text-xl font-bold text-fg">
        <LogoMark />
        Shoestring
      </div>
      <h1 className="mt-8 text-3xl font-semibold text-fg">
        Set up your budget
      </h1>
      <p className="mt-1 text-fg-muted">
        Pick the categories you spend on and, if you like, a monthly limit for
        each. You can change all of this later.
      </p>
      <form
        className="mt-6 flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setShowErrors(true);
          if (invalid || name.trim() === "") return;
          const categories = starters.flatMap((s, i) => {
            if (!s.on) return [];
            const p = parsed[i];
            return [
              {
                name: s.name,
                kind: s.kind,
                ...(p?.ok ? { plannedCents: p.cents } : {}),
              },
            ];
          });
          setBusy(true);
          setError(null);
          unwrap(
            api.POST("/budgets", {
              params: { header: { "Idempotency-Key": key.current } },
              body: {
                name: name.trim(),
                timezone: deviceTimezone(),
                categories,
              },
            }),
          )
            .then(async (budget) => {
              await client.invalidateQueries({ queryKey: keys.budgets });
              navigate(`/budgets/${budget.id}`, { replace: true });
            })
            .catch(setError)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <TextField
          label="Budget name"
          maxLength={60}
          isRequired
          value={name}
          onChange={setName}
          {...(fields.name
            ? { errorMessage: fields.name }
            : showErrors && name.trim() === ""
              ? { errorMessage: "Give your budget a name." }
              : {})}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-medium text-fg">
            Categories and monthly limits
          </legend>
          {starters.map((s, i) => (
            <div
              key={s.name}
              className="flex items-center gap-3 border-b border-line py-1.5"
            >
              <CheckboxField
                isSelected={s.on}
                onChange={(on) => {
                  setStarters((all) =>
                    all.map((x, j) => (j === i ? { ...x, on } : x)),
                  );
                }}
                className="flex-1"
              >
                <CheckboxButton className="flex min-h-touch cursor-pointer items-center gap-3 text-base text-fg">
                  {({ isSelected }) => (
                    <>
                      <span
                        aria-hidden="true"
                        className={`flex size-6 items-center justify-center rounded-sm border-2 ${isSelected ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface"}`}
                      >
                        {isSelected ? <Icon name="check" size={16} /> : null}
                      </span>
                      {s.name}
                      {s.kind === "income" ? (
                        <span className="text-sm text-fg-muted">(income)</span>
                      ) : null}
                    </>
                  )}
                </CheckboxButton>
              </CheckboxField>
              <AmountField
                label={`Monthly ${s.kind === "income" ? "expected" : "limit"} for ${s.name}`}
                hideLabel
                className="w-32"
                min={0}
                value={s.amount}
                showError={showErrors}
                onChange={(amount) => {
                  setStarters((all) =>
                    all.map((x, j) => (j === i ? { ...x, amount } : x)),
                  );
                }}
              />
            </div>
          ))}
        </fieldset>
        <p className="text-sm text-fg-muted">
          "Today" and the month follow this device's time zone (
          {deviceTimezone()}).
        </p>
        <FormError error={Object.keys(fields).length > 0 ? null : error} />
        <Button
          type="submit"
          size="lg"
          className="w-full"
          isPending={busy}
          data-testid="create-budget"
        >
          Create budget
        </Button>
      </form>
    </main>
  );
}

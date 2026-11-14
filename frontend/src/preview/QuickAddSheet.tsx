// DEV PREVIEW ONLY: the quick-add sheet (J2). Three taps: "+" → type the
// amount (the keypad opens on its own) → tap a category → Save. Everything a
// thumb needs sits in the bottom half, right above the keypad. Split mode
// shows "left to assign" live, from lib/splits.ts.
import { useState } from "react";
import { Alert } from "../components/Alert.tsx";
import { AmountField } from "../components/AmountField.tsx";
import { Button } from "../components/Button.tsx";
import { ChipGroup } from "../components/ChipGroup.tsx";
import { Icon } from "../components/Icon.tsx";
import { Money } from "../components/Money.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { shortDate } from "../lib/dates.ts";
import { centsToInputString, parseMoneyInput } from "../lib/money.ts";
import { remainderFor, splitBalance } from "../lib/splits.ts";
import { budget, categoryName, recentCategories } from "./mock-data.ts";

type Direction = "outflow" | "inflow";

interface SplitLine {
  key: string;
  categoryId: string;
  text: string;
}

function OptionPill({
  icon,
  label,
  children,
}: {
  icon: "calendar" | "note" | "split";
  label?: string;
  children: string;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      weight="medium"
      shape="pill"
      className="flex-1"
      {...(label ? { "aria-label": label } : {})}
    >
      <Icon name={icon} size={18} />
      {children}
    </Button>
  );
}

function SaveRow() {
  return (
    <div className="flex gap-2 pt-1">
      <Button variant="secondary" size="lg" className="flex-1">
        Save &amp; new
      </Button>
      <Button size="lg" className="flex-[1.4]" data-testid="quick-add-save">
        Save
      </Button>
    </div>
  );
}

function SingleCategory() {
  const [direction, setDirection] = useState<Direction>("outflow");
  const [amount, setAmount] = useState("42.50");
  const [categoryId, setCategoryId] = useState<string | null>(
    recentCategories[0]?.id ?? null,
  );
  return (
    <div className="flex flex-col gap-4 pt-2">
      <SegmentedControl
        label="Type"
        value={direction}
        onChange={setDirection}
        options={[
          { id: "outflow", label: "Spent" },
          { id: "inflow", label: "Received" },
        ]}
      />
      <AmountField
        label="Amount"
        hideLabel
        size="display"
        value={amount}
        onChange={(text) => {
          setAmount(text);
        }}
        data-testid="quick-add-amount"
      />
      <ChipGroup
        label="Category"
        hideLabel
        chips={[
          ...recentCategories.map((c) => ({ id: c.id, label: c.name })),
          { id: "more", label: "More…" },
        ]}
        value={categoryId}
        onChange={setCategoryId}
      />
      <div className="flex gap-2">
        <OptionPill
          icon="calendar"
          label={`Date: today, ${shortDate(budget.today)}`}
        >
          Today
        </OptionPill>
        <OptionPill icon="note">Note</OptionPill>
        <OptionPill icon="split">Split</OptionPill>
      </div>
      <SaveRow />
    </div>
  );
}

function SplitEditor() {
  const total = parseMoneyInput("86.40");
  const totalCents = total.ok ? total.cents : 0;
  const [lines, setLines] = useState<SplitLine[]>([
    { key: "a", categoryId: recentCategories[0]?.id ?? "", text: "60.00" },
    { key: "b", categoryId: recentCategories[3]?.id ?? "", text: "20.00" },
  ]);
  const cents = lines.map((l) => {
    const r = parseMoneyInput(l.text);
    return r.ok ? r.cents : null;
  });
  const balance = splitBalance(totalCents, cents);
  const lastIndex = lines.length - 1;
  const rest = remainderFor(totalCents, cents, lastIndex);

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-fg-muted">Spent</span>
        <span className="text-3xl font-semibold text-fg">
          <Money cents={totalCents} />
        </span>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">
          Split between categories
        </legend>
        {lines.map((line, i) => (
          <div key={line.key} className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              shape="pill"
              align="between"
              weight="medium"
              className="flex-1"
              aria-label={`Category: ${categoryName(line.categoryId)}`}
            >
              {categoryName(line.categoryId)}
              <Icon name="chevronDown" size={18} />
            </Button>
            <AmountField
              label={`Amount for ${categoryName(line.categoryId)}`}
              hideLabel
              className="w-32"
              value={line.text}
              onChange={(text) => {
                setLines((all) =>
                  all.map((l, j) => (j === i ? { ...l, text } : l)),
                );
              }}
            />
            <Button
              variant="quiet"
              size="icon"
              aria-label={`Remove ${categoryName(line.categoryId)}`}
            >
              <Icon name="trash" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="md" className="self-start">
          <Icon name="plus" /> Add category
        </Button>
      </fieldset>

      <div aria-live="polite" data-testid="split-left-to-assign">
        {balance.kind === "under" ? (
          <Alert tone="warning">
            <span className="flex flex-wrap items-center gap-x-1">
              <Money cents={balance.leftCents} /> left to assign
            </span>
          </Alert>
        ) : balance.kind === "over" ? (
          <Alert tone="danger">
            Splits are <Money cents={balance.overCents} /> more than the total
          </Alert>
        ) : (
          <Alert tone="success">Fully assigned</Alert>
        )}
      </div>
      {rest !== null ? (
        <Button
          variant="secondary"
          size="md"
          className="-mt-2"
          onPress={() => {
            setLines((all) =>
              all.map((l, j) =>
                j === lastIndex ? { ...l, text: centsToInputString(rest) } : l,
              ),
            );
          }}
        >
          Put the rest on {categoryName(lines[lastIndex]?.categoryId ?? "")}
        </Button>
      ) : null}
      <SaveRow />
    </div>
  );
}

export function QuickAddSheet({
  mode,
  bottomInset,
}: {
  mode: "single" | "split";
  bottomInset: number;
}) {
  return (
    <Sheet
      title="Add transaction"
      isOpen
      onOpenChange={() => undefined}
      bottomInset={bottomInset}
      data-testid="quick-add-sheet"
    >
      {mode === "single" ? <SingleCategory /> : <SplitEditor />}
    </Sheet>
  );
}

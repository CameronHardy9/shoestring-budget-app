// Split arithmetic for the quick-add split editor. Integer cents only.

/** Sum of integer cents; throws on anything that is not a safe integer. */
export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Money amounts must be integer cents.");
    }
    total += value;
  }
  return total;
}

export type SplitBalance =
  | { kind: "balanced" }
  | { kind: "under"; leftCents: number }
  | { kind: "over"; overCents: number };

/**
 * How the split amounts compare with the transaction total. Splits still being
 * typed (null) count as zero, so "left to assign" updates as the person types.
 */
export function splitBalance(
  totalCents: number,
  splitCents: readonly (number | null)[],
): SplitBalance {
  const assigned = sumCents(splitCents.map((cents) => cents ?? 0));
  const left = sumCents([totalCents, -assigned]);
  if (left === 0) return { kind: "balanced" };
  return left > 0
    ? { kind: "under", leftCents: left }
    : { kind: "over", overCents: -left };
}

/**
 * "Assign the rest" to one split: the amount that split needs so the splits sum
 * to the total, or null when the other splits already use up the total.
 */
export function remainderFor(
  totalCents: number,
  splitCents: readonly (number | null)[],
  index: number,
): number | null {
  const others = splitCents.filter((_, i) => i !== index);
  const rest = sumCents([totalCents, -sumCents(others.map((c) => c ?? 0))]);
  return rest > 0 ? rest : null;
}

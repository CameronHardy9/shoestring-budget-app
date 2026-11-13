// Pure ADR-0004 summary math, separate from the query so it can be unit
// tested exhaustively (100% branch coverage target).
import type {
  CategorySummaryRecord,
  MonthSummaryRecord,
  SummaryTotalsRecord,
} from "./records.ts";
import type { CategoryKind } from "./schema.ts";

export interface SummaryInputRow {
  categoryId: string;
  name: string;
  kind: CategoryKind;
  archived: boolean;
  plannedCents: number;
  outCents: number;
  inCents: number;
}

/**
 * Pure ADR-0004 math (100% branch coverage target):
 * expense: actual = out - in (spent net of refunds); income: actual = in - out.
 * remaining = planned - actual. Totals per kind over the listed categories.
 */
export function summarize(
  rows: readonly SummaryInputRow[],
): Pick<MonthSummaryRecord, "categories" | "totals"> {
  const totals: Record<CategoryKind, SummaryTotalsRecord> = {
    expense: { plannedCents: 0, actualCents: 0, remainingCents: 0 },
    income: { plannedCents: 0, actualCents: 0, remainingCents: 0 },
  };
  const categories: CategorySummaryRecord[] = rows.map((r) => {
    const actualCents =
      r.kind === "expense" ? r.outCents - r.inCents : r.inCents - r.outCents;
    const remainingCents = r.plannedCents - actualCents;
    const t = totals[r.kind];
    t.plannedCents += r.plannedCents;
    t.actualCents += actualCents;
    t.remainingCents += remainingCents;
    return {
      categoryId: r.categoryId,
      name: r.name,
      kind: r.kind,
      archived: r.archived,
      plannedCents: r.plannedCents,
      actualCents,
      remainingCents,
    };
  });
  return { categories, totals };
}

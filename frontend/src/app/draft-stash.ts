// Unsaved quick-add input kept in memory across a sign-in in this tab
// (errors.md "Client handling": a 401 keeps what the person typed). Bound to
// the budget and to the user who typed it (F-54): if someone else signs in on
// the same phone, the draft is discarded, never shown or saved as theirs.
// Memory only, like everything else (ADR-0002).
import type { Draft } from "./transaction-form.ts";

let stashed: { budgetId: string; userId: string; draft: Draft } | null = null;

export function stashDraft(
  budgetId: string,
  userId: string,
  draft: Draft,
): void {
  stashed = { budgetId, userId, draft };
}

/**
 * The draft for this budget, taken once. A draft from another user is
 * discarded; one for another budget stays until that budget opens.
 */
export function takeStashedDraft(
  budgetId: string,
  userId: string,
): Draft | null {
  if (!stashed) return null;
  if (stashed.userId !== userId) {
    stashed = null;
    return null;
  }
  if (stashed.budgetId !== budgetId) return null;
  const { draft } = stashed;
  stashed = null;
  return draft;
}

/** Discard a draft another user left behind (on sign-in). */
export function discardStashedDraftUnlessFor(userId: string): void {
  if (stashed && stashed.userId !== userId) stashed = null;
}

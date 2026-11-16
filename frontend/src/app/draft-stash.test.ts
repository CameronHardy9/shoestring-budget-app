import { afterEach, describe, expect, it } from "vitest";
import {
  discardStashedDraftUnlessFor,
  stashDraft,
  takeStashedDraft,
} from "./draft-stash.ts";
import { emptyDraft, type Draft } from "./transaction-form.ts";

const A = "user-a";
const B = "user-b";
const draft: Draft = { ...emptyDraft("2026-11-14"), payee: "Corner shop" };

afterEach(() => {
  discardStashedDraftUnlessFor("nobody");
});

describe("stashed quick-add draft", () => {
  it("comes back once, for the same user and budget", () => {
    stashDraft("budget-1", A, draft);
    expect(takeStashedDraft("budget-1", A)).toEqual(draft);
    expect(takeStashedDraft("budget-1", A)).toBeNull();
  });

  it("waits for its own budget", () => {
    stashDraft("budget-1", A, draft);
    expect(takeStashedDraft("budget-2", A)).toBeNull();
    expect(takeStashedDraft("budget-1", A)).toEqual(draft);
  });

  it("is discarded, never shown, when another user opens the budget (F-54)", () => {
    stashDraft("budget-1", A, draft);
    expect(takeStashedDraft("budget-1", B)).toBeNull();
    expect(takeStashedDraft("budget-1", A)).toBeNull();
  });

  it("is discarded when another user signs in, kept for the same user", () => {
    stashDraft("budget-1", A, draft);
    discardStashedDraftUnlessFor(A);
    expect(takeStashedDraft("budget-1", A)).toEqual(draft);

    stashDraft("budget-1", A, draft);
    discardStashedDraftUnlessFor(B);
    expect(takeStashedDraft("budget-1", A)).toBeNull();
  });
});

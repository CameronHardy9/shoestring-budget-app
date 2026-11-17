// Unit test (no stack needed; runs in `make check`): the Sentry gate's amount
// scan ignores the digits inside allowlisted IDs and positions, and still
// catches the amount everywhere else.
import { describe, expect, it } from "vitest";
import { findAmount, maskAllowedIds } from "./pii-scan.ts";

// The breadcrumb URL that raised the false alarm on csp-prod-chromium.
const COLLIDING_UUID = "01a1eb0c-8765-700f-84f0-e70c6ffdc813";

describe("findAmount", () => {
  it("does not trip on a UUID containing the amount's digits (API path, user.id, requestId)", () => {
    expect(
      findAmount(
        `{"data":{"url":"/api/budgets/${COLLIDING_UUID}/categories","method":"GET"}}`,
      ),
    ).toBeNull();
    expect(
      findAmount(`{"user":{"id":"${COLLIDING_UUID.toUpperCase()}"}}`),
    ).toBeNull();
    expect(
      findAmount(
        `{"tags":{"requestId":"0190a0a0-0000-7000-8000-000000008765"}}`,
      ),
    ).toBeNull();
  });

  it("does not trip on a 32-hex event ID or on stack positions, times and statuses", () => {
    expect(findAmount(`{"event_id":"8765${"a".repeat(28)}"}`)).toBeNull();
    expect(
      findAmount(
        `{"filename":"/assets/index-0a1b2c3d.js","lineno":1,"colno":8765}`,
      ),
    ).toBeNull();
    expect(findAmount(`{"lineno":8765,"timestamp":1795008765.123}`)).toBeNull();
  });

  it("still catches the amount anywhere else", () => {
    for (const leak of [
      "8765",
      `{"value":"paid 8765 cents"}`,
      `{"amountCents":8765}`,
      `{"url":"/api/budgets/${COLLIDING_UUID}/transactions/8765"}`,
      `{"url":"/api/x/8765/y"}`,
      `{"url":"/api/budgets/${COLLIDING_UUID}-8765"}`,
      `{"value":"Pharmacy $87.65"}`,
      `{"value":"$ 87.65"}`,
      `{"value":"total 87.65 today"}`,
      `{"colno":1,"value":"8765"}`,
    ])
      expect(findAmount(leak), leak).not.toBeNull();
  });

  it("masks only whole tokens: a hex run longer than a UUID group is left to the scan", () => {
    const notUuid = "ab01a1eb0c-8765-700f-84f0-e70c6ffdc813";
    expect(maskAllowedIds(notUuid)).toBe(notUuid);
    expect(findAmount(notUuid)).not.toBeNull();
  });
});

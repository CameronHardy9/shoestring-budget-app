import { describe, expect, it } from "vitest";
import { ApiError, NetworkError, UnexpectedResponseError } from "./errors.ts";
import {
  describeError,
  ERROR_COPY,
  FIELD_ISSUE_COPY,
  formatWait,
  GENERIC_FIELD_COPY,
  mapFieldErrors,
} from "./messages.ts";
import type { ErrorBody, FieldError, FieldIssue } from "./types.ts";

const body = (code: ErrorBody["code"], details?: FieldError[]): ErrorBody => ({
  code,
  message: "server text",
  requestId: "req-12345678",
  ...(details ? { details } : {}),
});

describe("error copy", () => {
  it("never repeats the server's message and never leaves a code without copy", () => {
    for (const [code, entry] of Object.entries(ERROR_COPY)) {
      expect(entry.message, code).not.toBe("");
      expect(entry.message, code).not.toBe("server text");
    }
  });

  it("describes API errors with their request ID", () => {
    const d = describeError(new ApiError(500, body("INTERNAL"), null));
    expect(d).toMatchObject({
      retryable: true,
      diagnostics: true,
      requestId: "req-12345678",
    });
    expect(d.message).toMatch(/Nothing you typed was lost/);
  });

  it("uses Retry-After for rate limits", () => {
    expect(
      describeError(new ApiError(429, body("RATE_LIMITED"), 120)).message,
    ).toBe("Too many attempts. Try again in 2 minutes.");
    expect(
      describeError(new ApiError(429, body("RATE_LIMITED"), null)).message,
    ).toBe(ERROR_COPY.RATE_LIMITED.message);
  });

  it("describes network and unexpected errors", () => {
    expect(describeError(new NetworkError())).toMatchObject({
      retryable: true,
      requestId: null,
    });
    expect(
      describeError(new UnexpectedResponseError(502, "abc12345")),
    ).toMatchObject({
      diagnostics: true,
      requestId: "abc12345",
    });
  });

  it.each([
    [1, "1 second"],
    [30, "30 seconds"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [3600, "1 hour"],
    [7200, "2 hours"],
  ])("formatWait(%i) = %s", (s, text) => {
    expect(formatWait(s)).toBe(text);
  });
});

describe("mapFieldErrors", () => {
  const fe = (
    field: string,
    issue: FieldIssue,
    where: FieldError["in"] = "body",
  ): FieldError => ({
    in: where,
    field,
    issue,
    message: "server text",
  });

  it("maps body details to known fields, first one wins", () => {
    const mapped = mapFieldErrors(
      [
        fe("amountCents", "too_big"),
        fe("amountCents", "required"),
        fe("splits.1.amountCents", "too_small"),
      ],
      ["amountCents", "splits.1.amountCents"],
    );
    expect(mapped.fields).toEqual({
      amountCents: FIELD_ISSUE_COPY.too_big,
      "splits.1.amountCents": FIELD_ISSUE_COPY.too_small,
    });
    expect(mapped.form).toEqual([]);
  });

  it("sends unknown fields and non-body locations to the form, without duplicates", () => {
    const mapped = mapFieldErrors(
      [
        fe("Idempotency-Key", "required", "header"),
        fe("nope", "unknown_field"),
        fe("other", "unknown_field"),
      ],
      ["amountCents"],
    );
    expect(mapped.form).toEqual([
      FIELD_ISSUE_COPY.required,
      FIELD_ISSUE_COPY.unknown_field,
    ]);
  });

  it("applies per-form overrides and survives unknown issue codes", () => {
    const mapped = mapFieldErrors(
      [
        fe("password", "too_short"),
        {
          in: "body",
          field: "x",
          issue: "brand_new" as FieldIssue,
          message: "",
        },
      ],
      ["password", "x"],
      { too_short: "Use at least 12 characters." },
    );
    expect(mapped.fields).toEqual({
      password: "Use at least 12 characters.",
      x: GENERIC_FIELD_COPY,
    });
  });
});

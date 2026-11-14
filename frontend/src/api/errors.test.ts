import { describe, expect, it } from "vitest";
import {
  ApiError,
  isClientError,
  isErrorBody,
  NetworkError,
  parseRetryAfter,
} from "./errors.ts";

describe("isErrorBody", () => {
  it("accepts contract error bodies", () => {
    expect(
      isErrorBody({ code: "NOT_FOUND", message: "m", requestId: "r-123456" }),
    ).toBe(true);
    expect(
      isErrorBody({
        code: "VALIDATION_FAILED",
        message: "m",
        requestId: "r-123456",
        details: [
          {
            in: "query",
            field: "cursor",
            issue: "invalid_value",
            message: "m",
          },
        ],
      }),
    ).toBe(true);
  });
  it.each([
    null,
    "text",
    1,
    {},
    { code: "NOT_FOUND", message: "m" },
    { code: "toString", message: "m", requestId: "r" },
    { code: "NOT_FOUND", message: "m", requestId: "r", details: [null] },
    {
      code: "NOT_FOUND",
      message: "m",
      requestId: "r",
      details: [{ in: "cookie", field: "", issue: "required", message: "" }],
    },
  ])("rejects %j", (value) => {
    expect(isErrorBody(value)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it.each([
    ["30", 30],
    [" 2 ", 2],
    ["0", null],
    ["-1", null],
    ["Wed, 21 Oct 2015 07:28:00 GMT", null],
    [null, null],
  ])("%j → %j", (value, seconds) => {
    expect(parseRetryAfter(value)).toBe(seconds);
  });
});

describe("isClientError", () => {
  it("recognises the client error classes", () => {
    expect(isClientError(new NetworkError())).toBe(true);
    expect(
      isClientError(
        new ApiError(
          404,
          { code: "NOT_FOUND", message: "", requestId: "r-123456" },
          null,
        ),
      ),
    ).toBe(true);
    expect(isClientError(new Error("x"))).toBe(false);
  });
});

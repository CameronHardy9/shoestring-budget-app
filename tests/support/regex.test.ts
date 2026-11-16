// Unit test (no stack needed; runs in `make check`): RegExps built from contract
// paths and link templates treat every literal character literally, backslash
// included (CodeQL js/incomplete-sanitization on support/contract.ts).
import { describe, expect, it } from "vitest";
import {
  endsWithRegex,
  escapeRegExp,
  openApiPathRegex,
  templateRegex,
} from "./regex.ts";

const META = String.raw`/a.b*c+d?e^f$g{h}i(j)k|l[m]n\o`;

describe("escapeRegExp", () => {
  it("escapes every regex metacharacter and the backslash so the string matches only itself", () => {
    const re = new RegExp(`^${escapeRegExp(META)}$`);
    expect(re.test(META)).toBe(true);
    // Each metacharacter, unescaped, would match these instead.
    expect(re.test("/aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(false);
    expect(re.test("/a.bbbbc+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(false);
    expect(re.test("/a.b*c+d?e^f$g{h}i(j)k|l[m]no")).toBe(false);
  });

  it("keeps a trailing backslash from escaping the closing anchor", () => {
    const re = new RegExp(`^${escapeRegExp("x\\")}$`);
    expect(re.test("x\\")).toBe(true);
    expect(re.test("x$")).toBe(false);
  });
});

describe("openApiPathRegex", () => {
  it("matches a path with metacharacters and a backslash in a literal segment only literally", () => {
    const path = String.raw`/v1/a.b+c/(x|y)/back\slash/[z]*/{id}`;
    const re = openApiPathRegex(path);
    expect(re.test(String.raw`/v1/a.b+c/(x|y)/back\slash/[z]*/42`)).toBe(true);
    expect(re.exec(String.raw`/v1/a.b+c/(x|y)/back\slash/[z]*/42`)?.[1]).toBe(
      "42",
    );
    // `.` `+` `|` `\s` `[z]*` as regex syntax would accept these; literally they differ.
    expect(re.test(String.raw`/v1/aXbbc/(x|y)/back\slash/[z]*/42`)).toBe(false);
    expect(re.test(String.raw`/v1/a.b+c/x/back\slash/[z]*/42`)).toBe(false);
    expect(re.test(String.raw`/v1/a.b+c/(x|y)/back slash/[z]*/42`)).toBe(false);
    expect(re.test(String.raw`/v1/a.b+c/(x|y)/back\slash//42`)).toBe(false);
  });

  it("captures each {param} as one path segment, in order, and anchors both ends", () => {
    const re = openApiPathRegex(
      "/budgets/{budgetId}/transactions/{transactionId}",
    );
    expect(re.exec("/budgets/b-1/transactions/t-2")?.slice(1)).toEqual([
      "b-1",
      "t-2",
    ]);
    expect(re.test("/budgets/b-1/x/transactions/t-2")).toBe(false);
    expect(re.test("/budgets//transactions/t-2")).toBe(false);
    expect(re.test("/budgets/b-1/transactions/t-2/extra")).toBe(false);
    expect(re.test("/v1/budgets/b-1/transactions/t-2")).toBe(false);
    expect(openApiPathRegex("/session").test("/session")).toBe(true);
  });
});

describe("templateRegex", () => {
  const link = (p: string) =>
    templateRegex(p, {
      "{budgetId}": "[0-9a-f-]{36}",
      "#token=…": "#token=[A-Za-z0-9_-]{43,64}",
    });

  it("substitutes placeholders and escapes the literal rest of an auth.md §15 link path", () => {
    const id = "0b5c1f4e-2d7a-4c3b-9e8f-1a2b3c4d5e6f";
    const re = link("/budgets/{budgetId}/members");
    expect(re.test(`/budgets/${id}/members`)).toBe(true);
    expect(re.test(`/budgets/${id}/members/x`)).toBe(false);
    expect(re.test("/budgets/{budgetId}/members")).toBe(false);

    const token = link("/invite#token=…");
    expect(token.test(`/invite#token=${"A".repeat(43)}`)).toBe(true);
    expect(token.test("/invite#token=short")).toBe(false);
  });

  it("keeps a backslash or metacharacter in the literal text literal", () => {
    const re = templateRegex(String.raw`/a\d.{x}`, { "{x}": "[0-9]+" });
    expect(re.test(String.raw`/a\d.12`)).toBe(true);
    expect(re.test("/a5X12")).toBe(false);
  });
});

describe("endsWithRegex", () => {
  it("matches only strings ending with the literal suffix", () => {
    const re = endsWithRegex("/budgets/a.b");
    expect(re.test("http://localhost/budgets/a.b")).toBe(true);
    expect(re.test("http://localhost/budgets/aXb")).toBe(false);
    expect(re.test("http://localhost/budgets/a.b/members")).toBe(false);
  });
});

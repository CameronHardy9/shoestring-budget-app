// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateApiTypes, OUT_PATH } from "./api-codegen.ts";

describe("generated API client types", () => {
  it("match docs/contracts/api.openapi.yaml (run `pnpm --filter ./frontend gen:api` if this fails)", async () => {
    const committed = readFileSync(OUT_PATH, "utf8");
    expect(committed === (await generateApiTypes())).toBe(true);
  }, 30_000);
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildConfig } from "../vite.config.ts";
import { BOOT_ENTRY_NAME, bootChunkFile } from "./boot-script.ts";

describe("boot script (F-50)", () => {
  it("is a separate build entry for the capture module", () => {
    const input = buildConfig({}).build?.rolldownOptions?.input as Record<
      string,
      string
    >;
    expect(String(input[BOOT_ENTRY_NAME])).toMatch(
      /frontend\/src\/boot\/capture-link-token\.ts$/,
    );
  });

  it("finds the emitted boot chunk, and fails the build without one", () => {
    expect(
      bootChunkFile({
        a: {
          type: "chunk",
          isEntry: true,
          name: "index",
          fileName: "assets/index-1.js",
        },
        b: {
          type: "chunk",
          isEntry: true,
          name: "boot",
          fileName: "assets/boot-2.js",
        },
      }),
    ).toBe("assets/boot-2.js");
    expect(() =>
      bootChunkFile({
        a: {
          type: "chunk",
          isEntry: false,
          name: "boot",
          fileName: "assets/boot-2.js",
        },
      }),
    ).toThrow(/F-50/);
  });
});

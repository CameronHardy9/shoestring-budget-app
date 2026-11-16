import { afterEach, describe, expect, it, vi } from "vitest";
import { REVOKE_AFTER_MS, saveBlob } from "./download.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("saveBlob", () => {
  it("downloads under the given name and revokes the URL only later (iOS Safari)", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL, revokeObjectURL }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("codes.txt");
        expect(this.href).toBe("blob:x");
      });
    saveBlob(new Blob(["a"]), "codes.txt");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_AFTER_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});

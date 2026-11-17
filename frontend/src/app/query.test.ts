import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/errors.ts";
import { createQueryClient } from "./query.ts";

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("query client", () => {
  it("never pauses a write offline: every mutation runs and can fail at once", async () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations).toMatchObject({
      networkMode: "always",
      retry: false,
    });
    onlineManager.setOnline(false);
    const write = vi.fn(() => Promise.reject(new NetworkError()));
    const mutation = client.getMutationCache().build(client, {
      mutationFn: write,
    });
    await expect(mutation.execute(undefined)).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(mutation.state.isPaused).toBe(false);
  });
});

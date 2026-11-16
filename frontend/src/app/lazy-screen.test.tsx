import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { lazyScreen } from "./lazy-screen.tsx";

function Hello() {
  return <h1>Hello</h1>;
}

function mount(Screen: () => React.JSX.Element) {
  return render(
    <Suspense fallback={<p>Loading</p>}>
      <Screen />
    </Suspense>,
  );
}

describe("lazyScreen", () => {
  it("suspends like React.lazy when the module isn't loaded yet", async () => {
    const load = vi.fn(() => Promise.resolve(Hello));
    mount(lazyScreen(load));
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Hello" }),
    ).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("renders on the first pass once preloaded", async () => {
    const load = vi.fn(() => Promise.resolve(Hello));
    const Screen = lazyScreen(load);
    await Screen.preload();
    await Screen.preload();
    mount(Screen);
    // Synchronous query: no fallback, no wait.
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.queryByText("Loading")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("lets a failed preload be retried", async () => {
    const load = vi
      .fn<() => Promise<typeof Hello>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(Hello);
    const Screen = lazyScreen(load);
    await expect(Screen.preload()).rejects.toThrow("offline");
    await Screen.preload();
    mount(Screen);
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

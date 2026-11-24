// Tab screens are preloaded at idle time once the first page is revealed
// (owner ruling 2026-11-24): never during a page loader session, never
// before sign-in, once only, and a failed preload is silent.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LACE_CYCLE_MS, LACE_GRACE_MS } from "../components/lace-timing.ts";
import { registerPageLoad } from "../components/page-loader.ts";
import {
  IDLE_FALLBACK_MS,
  IDLE_TIMEOUT_MS,
  preloadWhenIdle,
  usePreloadAfterFirstReveal,
  type Preloadable,
} from "./preload.ts";
import { TAB_SCREENS } from "./routes.tsx";

function screens(...results: ("ok" | "fail")[]) {
  return results.map((result) => ({
    preload: vi.fn(() =>
      result === "ok"
        ? Promise.resolve()
        : Promise.reject(
            new TypeError("Failed to fetch dynamically imported module"),
          ),
    ),
  }));
}

function Harness({
  enabled,
  list,
}: {
  enabled: boolean;
  list: readonly Preloadable[];
}) {
  usePreloadAfterFirstReveal(enabled, list);
  return null;
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("preloadWhenIdle", () => {
  it("without requestIdleCallback waits a moment, then preloads every screen", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const list = screens("ok", "ok");
    preloadWhenIdle(list);
    expect(list[0]!.preload).not.toHaveBeenCalled();
    await wait(IDLE_FALLBACK_MS);
    for (const s of list) expect(s.preload).toHaveBeenCalledOnce();
  });

  it("uses requestIdleCallback with a deadline when there is one", () => {
    const idle = vi.fn((fn: () => void) => {
      fn();
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", idle);
    const list = screens("ok");
    preloadWhenIdle(list);
    expect(idle).toHaveBeenCalledWith(expect.any(Function), {
      timeout: IDLE_TIMEOUT_MS,
    });
    expect(list[0]!.preload).toHaveBeenCalledOnce();
  });

  it("swallows a failed preload and still tries the others", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    // A plain function, not vi.fn(): a spy attaches its own handler to the
    // promise it returns, which would hide a missing catch.
    const failure = new TypeError(
      "Failed to fetch dynamically imported module",
    );
    let failedCalls = 0;
    const failing: Preloadable = {
      preload: () => {
        failedCalls += 1;
        return Promise.reject(failure);
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    const [ok] = screens("ok");
    preloadWhenIdle([failing, ok!]);
    await wait(IDLE_FALLBACK_MS);
    vi.useRealTimers();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.removeEventListener("unhandledrejection", onUnhandled);
    expect(failedCalls).toBe(1);
    expect(ok!.preload).toHaveBeenCalledOnce();
    expect(unhandled).toEqual([]);
  });
});

describe("usePreloadAfterFirstReveal", () => {
  beforeEach(() => {
    vi.stubGlobal("requestIdleCallback", undefined);
  });

  it("waits for the first page loader session to end, then preloads once", async () => {
    const list = screens("ok");
    const end = registerPageLoad("Starting Shoestring…");
    const view = render(<Harness enabled list={list} />);
    await wait(LACE_GRACE_MS + IDLE_FALLBACK_MS);
    // The lace is up: nothing competes with the loads it stands for.
    expect(list[0]!.preload).not.toHaveBeenCalled();
    end();
    await wait(LACE_CYCLE_MS + 200);
    await wait(IDLE_FALLBACK_MS);
    expect(list[0]!.preload).toHaveBeenCalledOnce();
    // A later session (and its end) doesn't preload again.
    const again = registerPageLoad("Loading…");
    view.rerender(<Harness enabled list={list} />);
    await wait(LACE_GRACE_MS);
    again();
    await wait(2 * LACE_CYCLE_MS + IDLE_FALLBACK_MS);
    expect(list[0]!.preload).toHaveBeenCalledOnce();
  });

  it("preloads right away (at idle) when no loader was needed", async () => {
    const list = screens("ok");
    render(<Harness enabled list={list} />);
    await wait(IDLE_FALLBACK_MS);
    expect(list[0]!.preload).toHaveBeenCalledOnce();
  });

  it("not before sign-in", async () => {
    const list = screens("ok");
    const view = render(<Harness enabled={false} list={list} />);
    await wait(IDLE_FALLBACK_MS * 5);
    expect(list[0]!.preload).not.toHaveBeenCalled();
    view.rerender(<Harness enabled list={list} />);
    await wait(IDLE_FALLBACK_MS);
    expect(list[0]!.preload).toHaveBeenCalledOnce();
  });

  it("covers the four tab screens", () => {
    expect(TAB_SCREENS).toHaveLength(4);
    for (const screen of TAB_SCREENS)
      expect(screen.preload).toBeTypeOf("function");
  });
});

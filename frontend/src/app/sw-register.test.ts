import { describe, expect, it, vi } from "vitest";
import { reloadOnTakeover } from "./sw-register.ts";

function container(controller: object | null) {
  const target = new EventTarget();
  return Object.assign(target, {
    controller,
  }) as unknown as Pick<
    ServiceWorkerContainer,
    "controller" | "addEventListener"
  > &
    EventTarget;
}

describe("service worker takeover", () => {
  it("does not reload when the first worker claims the page (an emailed link's token would be lost)", () => {
    const c = container(null);
    const reload = vi.fn();
    reloadOnTakeover(c, reload);
    c.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once when an updated worker takes over", () => {
    const c = container({});
    const reload = vi.fn();
    reloadOnTakeover(c, reload);
    c.dispatchEvent(new Event("controllerchange"));
    c.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
  });
});

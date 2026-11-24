import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getLastBudgetId,
  getThemePreference,
  setLastBudgetId,
  setThemePreference,
} from "./preferences.ts";

const ID = "0194f5c2-0000-7000-8000-000000000001";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme preference", () => {
  it("defaults to system", () => {
    expect(getThemePreference()).toBe("system");
  });
  it("stores light/dark and applies data-theme", () => {
    setThemePreference("dark");
    expect(getThemePreference()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    setThemePreference("system");
    expect(localStorage.getItem("shoestring.theme")).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
  it("ignores junk values", () => {
    localStorage.setItem("shoestring.theme", "<script>");
    expect(getThemePreference()).toBe("system");
  });
  it("applies to a given root", () => {
    const el = document.createElement("div");
    applyTheme("light", el);
    expect(el.dataset.theme).toBe("light");
  });
});

describe("last budget ID", () => {
  it("round-trips a UUID only", () => {
    setLastBudgetId(ID);
    expect(getLastBudgetId()).toBe(ID);
    setLastBudgetId("not-a-uuid");
    expect(getLastBudgetId()).toBeNull();
    localStorage.setItem("shoestring.lastBudgetId", "junk");
    expect(getLastBudgetId()).toBeNull();
  });
  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(getLastBudgetId()).toBeNull();
    expect(() => {
      setLastBudgetId(ID);
    }).not.toThrow();
  });
});

describe("theme-color", () => {
  it("follows a manual theme and restores the media queries for system", () => {
    document.head.replaceChildren(
      ...[
        ["#f4efe6", "(prefers-color-scheme: light)"],
        ["#121214", "(prefers-color-scheme: dark)"],
      ].map(([content, media]) => {
        const meta = document.createElement("meta");
        meta.name = "theme-color";
        meta.content = content ?? "";
        meta.media = media ?? "";
        return meta;
      }),
    );
    const metas = () => [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    applyTheme("dark");
    expect(metas().map((m) => [m.media, m.content])).toEqual([
      ["all", "#121214"],
      ["all", "#121214"],
    ]);
    applyTheme("system");
    expect(metas().map((m) => [m.media, m.content])).toEqual([
      ["(prefers-color-scheme: light)", "#f4efe6"],
      ["(prefers-color-scheme: dark)", "#121214"],
    ]);
  });
});

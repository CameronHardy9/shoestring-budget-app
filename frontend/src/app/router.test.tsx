import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { matchPath, navigate, useLocation, withSearch } from "./router.tsx";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function Where() {
  const l = useLocation();
  return <p>at {l.href}</p>;
}

describe("matchPath", () => {
  it("matches segments and decodes params", () => {
    expect(
      matchPath("/budgets/:budgetId/transactions", "/budgets/abc/transactions"),
    ).toEqual({ budgetId: "abc" });
    expect(matchPath("/budgets/:budgetId", "/budgets/abc/")).toEqual({
      budgetId: "abc",
    });
    expect(matchPath("/budgets/:budgetId", "/budgets/a%20b")).toEqual({
      budgetId: "a b",
    });
    expect(matchPath("/budgets/:budgetId", "/budgets/%E0%A4%A")).toBeNull();
    expect(matchPath("/budgets/:budgetId", "/budgets/abc/x")).toBeNull();
    expect(matchPath("/more", "/less")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });
});

describe("navigate", () => {
  it("updates subscribers and only goes to app-relative paths", () => {
    render(<Where />);
    act(() => {
      navigate("/budgets/x?month=2026-10");
    });
    expect(screen.getByText("at /budgets/x?month=2026-10")).toBeInTheDocument();
    act(() => {
      navigate("https://evil.example/");
    });
    expect(screen.getByText("at /")).toBeInTheDocument();
    act(() => {
      navigate("//evil.example", { replace: true });
    });
    expect(window.location.pathname).toBe("/");
  });

  it("edits the query string", () => {
    window.history.replaceState(null, "", "/t?month=2026-11&category=a");
    const loc = {
      pathname: "/t",
      search: new URLSearchParams("month=2026-11&category=a"),
      href: "/t?month=2026-11&category=a",
    };
    expect(withSearch(loc, { category: null })).toBe("/t?month=2026-11");
    expect(withSearch(loc, { month: null, category: null })).toBe("/t");
    expect(withSearch(loc, { month: "2026-10" })).toBe(
      "/t?month=2026-10&category=a",
    );
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetPageLoaderForTests } from "../components/page-loader.ts";

afterEach(() => {
  cleanup();
  // The page loader session is module state: no test inherits one.
  resetPageLoaderForTests();
});

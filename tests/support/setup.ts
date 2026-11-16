// Runs around every test (vitest setupFiles):
//   before: empty database, cleared rate limiters and outbox, clock frozen at
//           DEFAULT_NOW, so no test depends on another or on wall-clock time;
//   after:  every email the test caused is checked against auth.md §15.
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import { emailProblems } from "./emails.ts";
import { closeDal, emails, resetStack } from "./hooks.ts";

beforeEach(async () => {
  await resetStack();
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") return; // keep the first failure readable
  const problems = (await emails()).flatMap(emailProblems);
  expect(
    problems,
    "captured emails must follow auth.md §15 (kind, P column, link path)",
  ).toEqual([]);
});

afterAll(async () => {
  await closeDal();
});

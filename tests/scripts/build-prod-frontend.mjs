// Builds the PRODUCTION frontend bundle into tests/.prod-build (gitignored by
// tests/.gitignore) for the suites that
// need what users actually get: the CSP violation gate (C3.1) and the visual
// baselines (ADR-0009: "visual baselines use production frontend builds").
// It runs the frontend's own `vite build` with a different outDir only; it
// writes nothing under frontend/.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../.prod-build/", import.meta.url));
const started = Date.now();
execFileSync(
  "pnpm",
  ["--filter", "./frontend", "exec", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"],
  { stdio: "inherit", cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { ...process.env, VITE_APP_RELEASE: "e2e" } },
);
process.stdout.write(`production frontend built into tests/.prod-build in ${Date.now() - started} ms\n`);

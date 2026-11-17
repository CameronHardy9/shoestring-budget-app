// The production bundle never contains the test hooks (ADR-0009, F-10): build
// both entries into a temp dir and apply the Dockerfile's tripwire.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { afterAll, describe, expect, it } from "vitest";
import { productionBuildOptions } from "./build-options.ts";
import { scanDist } from "./test-hooks-tripwire.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ss-dist-"));
  dirs.push(d);
  return d;
};

describe("production build", () => {
  it("bundles server.js and admin.js without any test-hook code", async () => {
    const out = temp();
    const res = await build({
      ...productionBuildOptions(root, `${out}/`),
      write: true,
    });
    const files = res.output.map((o) => o.fileName);
    expect(files).toEqual(expect.arrayContaining(["server.js", "admin.js"]));
    expect(scanDist(out)).toEqual([]);
  }, 60_000);

  it("fails on an import it cannot resolve instead of leaving a silent external", async () => {
    const d = temp();
    writeFileSync(join(d, "entry.ts"), 'import { nothing } from "no-such-package-xyz";\nconsole.log(nothing);\n');
    await expect(
      build({ ...productionBuildOptions(root, `${d}/out/`), input: { entry: join(d, "entry.ts") }, write: false }),
    ).rejects.toThrow(/no-such-package-xyz/);
  }, 60_000);

  it("bundles @sentry/node into a lazy chunk; native and runtime deps stay external", async () => {
    const out = temp();
    const res = await build({ ...productionBuildOptions(root, `${out}/`), write: false });
    const chunks = res.output.filter((o) => o.type === "chunk");
    const sentry = chunks.filter((c) => c.code.includes("makeNodeTransport"));
    expect(sentry).toHaveLength(1);
    const lazy = sentry[0]!.fileName.split("/").pop()!;
    for (const entry of chunks.filter((c) => c.isEntry)) {
      // Entries never import the SDK chunk statically (loaded only with SENTRY_DSN).
      expect(entry.code).not.toContain(`from "./chunks/${lazy}"`);
      expect(entry.imports.some((i) => i.endsWith(lazy))).toBe(false);
    }
    const all = chunks.map((c) => c.code).join("\n");
    expect(all).toMatch(/import\("\.\/[^"]*esm-[^"]*\.js"\)|import\("\.\/chunks\/[^"]*"\)/);
    expect(all).toMatch(/from "@node-rs\/argon2"/); // native: external
    expect(all).not.toMatch(/from "@sentry\/|oxc-parser|minimatch/);
  }, 60_000);

  // F-61: anything bundled into dist/ is a runtime dependency for advisory
  // triage, even when package.json lists it under devDependencies (the Sentry
  // SDK is one). Dependabot and `pnpm audit --prod` label those "development",
  // so this pins the exact set: a newly bundled package fails here until it is
  // reviewed and added to scripts/bundled-runtime-packages.json, which is the
  // list triage relies on.
  it("bundles exactly the reviewed npm packages (bundled-runtime-packages.json)", async () => {
    const out = temp();
    const res = await build({ ...productionBuildOptions(root, `${out}/`), write: false });
    const bundled = new Set<string>();
    for (const chunk of res.output) {
      if (chunk.type !== "chunk") continue;
      for (const source of chunk.map?.sources ?? []) {
        const at = source.lastIndexOf("node_modules/");
        if (at === -1) continue; // own source or a workspace package (db/)
        const [scope, name] = source.slice(at + "node_modules/".length).split("/");
        bundled.add(scope!.startsWith("@") ? `${scope}/${name}` : scope!);
      }
    }
    const reviewed = JSON.parse(
      readFileSync(join(root, "scripts", "bundled-runtime-packages.json"), "utf8"),
    ) as { packages: string[] };
    expect(res.output.some((o) => o.type === "chunk" && o.isEntry && o.map)).toBe(true);
    expect([...bundled].sort()).toEqual([...reviewed.packages].sort());
  }, 60_000);

  it("the bundled SDK sends clean envelopes and source-mapped stacks (node --enable-source-maps)", async () => {
    // Inside backend/node_modules so the bundle's externals (pino, zod) resolve.
    const d = mkdtempSync(join(root, "node_modules", ".ss-bundle-"));
    dirs.push(d);
    writeFileSync(
      join(d, "entry.ts"),
      `import { createTransport } from "@sentry/node";
import { ALERTS, PURGE_MONITOR, initErrorTracker } from ${JSON.stringify(join(root, "src/observability/error-tracker.ts"))};
function failingQuery() {
  return Object.assign(new Error("violates check: Pharmacy 4500"), {
    code: "23514", constraint: "splits_amount_check", detail: "Failing row contains (Pharmacy, 4500)",
  });
}
const raw = [];
const t = await initErrorTracker({
  dsn: "https://k@o1.ingest.us.sentry.io/456", release: "r1", environment: "production",
  transport: (o) => createTransport(o, (req) => {
    raw.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
    return Promise.resolve({ statusCode: 200 });
  }),
});
const err = failingQuery();
t.captureError(err, { requestId: "req-1", userId: null, route: "/api/me" });
t.alert(ALERTS.emailQuotaWarning);
t.startCheckIn(PURGE_MONITOR).finish("ok");
await t.close(2000);
process.stdout.write(JSON.stringify({ raw, stack: err.stack }));
`,
    );
    await build({
      ...productionBuildOptions(root, `${d}/out/`),
      input: { entry: join(d, "entry.ts") },
      write: true,
    });
    const res = JSON.parse(
      execFileSync(process.execPath, ["--enable-source-maps", join(d, "out", "entry.js")], { encoding: "utf8" }),
    ) as { raw: string[]; stack: string };
    const wire = res.raw.join("\n");
    expect(wire).toContain('"type":"event"');
    expect(wire).toContain("code=23514 constraint=splits_amount_check");
    expect(wire).toContain("email_quota_threshold");
    expect(wire).toContain('"type":"check_in"');
    expect(wire).toContain('"status":"ok"');
    expect(wire).not.toMatch(/Pharmacy|4500|Failing row/);
    // Source maps resolve the bundled frame to the original file and line.
    expect(res.stack).toMatch(/entry\.ts:4:\d+/);
    expect(wire).toMatch(/"filename":"[^"]*entry\.ts","function":"failingQuery","lineno":4/);
  }, 60_000);

  it("the tripwire catches the sentinel and `_test` as a whole word, but not similar identifiers", () => {
    const d = temp();
    mkdirSync(join(d, "chunks"));
    writeFileSync(
      join(d, "fine.js"),
      "const is_test = 1, _tests = 2, TEST_HOOKS = 3;",
    );
    expect(scanDist(d)).toEqual([]);
    writeFileSync(
      join(d, "chunks", "a.js"),
      'app.post("/api/" + "_test" + "/reset")',
    );
    writeFileSync(
      join(d, "b.mjs"),
      'export const s = "__SHOESTRING_TEST_HOOKS__";',
    );
    expect(
      scanDist(d)
        .map((p) => p.slice(d.length + 1))
        .sort(),
    ).toEqual(["b.mjs", join("chunks", "a.js")]);
  });

  it("the tripwire fails closed on an entry it cannot read without following (a symlink)", () => {
    const d = temp();
    writeFileSync(join(d, "ok.js"), "const fine = 1;");
    symlinkSync(join(d, "ok.js"), join(d, "link.js"));
    expect(scanDist(d).map((p) => p.slice(d.length + 1))).toEqual(["link.js"]);
  });
});

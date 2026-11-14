// Shared by scripts/build.ts and the bundle test (src/build.test.ts).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import type { BuildOptions } from "rolldown";

export function productionBuildOptions(root: string, outDir: string): BuildOptions {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
    dependencies: Record<string, string>;
  };
  // Own dependencies are installed next to dist/ in the image; workspace
  // packages are bundled. Optional native/edge add-ons of pg are never used.
  const external = new Set([
    ...Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@shoestring/")),
    "pg-native",
    "pg-cloudflare",
  ]);
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  return {
    input: { server: `${root}src/server.ts`, admin: `${root}src/admin.ts` },
    platform: "node",
    tsconfig: `${root}tsconfig.json`,
    external: (id) =>
      builtins.has(id) || [...external].some((d) => id === d || id.startsWith(`${d}/`)),
    output: {
      dir: outDir,
      format: "esm",
      entryFileNames: "[name].js",
      chunkFileNames: "chunks/[name]-[hash].js",
      sourcemap: true,
      // Bundled CommonJS (pg) calls require(); give ESM output a real one.
      banner: 'import { createRequire as __ssCreateRequire } from "node:module"; const require = __ssCreateRequire(import.meta.url);',
    },
  };
}

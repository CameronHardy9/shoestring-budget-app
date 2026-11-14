// Production build (ADR-0009): bundles ONLY src/server.ts -> dist/server.js and
// src/admin.ts -> dist/admin.js. Workspace code (@shoestring/db, its kysely
// and pg) is bundled; this package's own npm dependencies stay external and
// are installed by `pnpm deploy --prod`. The test hooks are not reachable from
// either entry, and scripts/test-hooks-tripwire.ts proves it after the build.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { productionBuildOptions } from "./build-options.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = `${root}dist`;
rmSync(outDir, { recursive: true, force: true });
await build(productionBuildOptions(root, outDir));
process.stdout.write(`built ${outDir}/server.js and ${outDir}/admin.js\n`);

// Admin CLI entry point (built to dist/admin.js). See src/admin/cli.ts.
import { main } from "./admin/cli.ts";

process.exitCode = await main(process.argv.slice(2));

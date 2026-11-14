// Regenerates src/api/schema.gen.ts from the OpenAPI contract.
import { writeFileSync } from "node:fs";
import { generateApiTypes, OUT_PATH } from "./api-codegen.ts";

writeFileSync(OUT_PATH, await generateApiTypes());
process.stdout.write(`wrote ${OUT_PATH}\n`);

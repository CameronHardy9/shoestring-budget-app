// Regenerates src/contract/contract.gen.ts from the OpenAPI contract.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderContractModule } from "./contract-codegen.ts";

const specPath = fileURLToPath(
  new URL("../../docs/contracts/api.openapi.yaml", import.meta.url),
);
const outPath = fileURLToPath(
  new URL("../src/contract/contract.gen.ts", import.meta.url),
);
writeFileSync(outPath, renderContractModule(readFileSync(specPath, "utf8")));
process.stdout.write(`wrote ${outPath}\n`);

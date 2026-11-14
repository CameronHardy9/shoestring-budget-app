// Generates TypeScript types for the API from docs/contracts/api.openapi.yaml
// with openapi-typescript (pinned, no install script). Used by gen-api.ts (writes
// src/api/schema.gen.ts) and by api-codegen.test.ts, which fails `make check`
// when the committed file is stale, so contract drift is a compile error.
import openapiTS, { astToString } from "openapi-typescript";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SPEC_PATH = fileURLToPath(
  new URL("../../docs/contracts/api.openapi.yaml", import.meta.url),
);
export const OUT_PATH = fileURLToPath(
  new URL("../src/api/schema.gen.ts", import.meta.url),
);

const HEADER = `// GENERATED from docs/contracts/api.openapi.yaml by frontend/scripts/gen-api.ts.
// Do not edit. Regenerate with: pnpm --filter ./frontend gen:api
/* eslint-disable */
`;

export async function generateApiTypes(): Promise<string> {
  // Default options: deterministic output that does not depend on the machine.
  const ast = await openapiTS(pathToFileURL(SPEC_PATH));
  return HEADER + astToString(ast);
}

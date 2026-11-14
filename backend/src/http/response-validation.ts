// Response validation against the contract (dev and test only). Every
// response body is checked against the JSON Schema the OpenAPI file declares
// for its operation and status; a mismatch becomes a 500 and a log line, so
// drift is loud in e2e. Production skips it (the cost is not needed there).
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { contractSchemas } from "../contract/contract.gen.ts";
import type { ContractOperation } from "../contract/types.ts";

export class ContractViolation extends Error {
  override readonly name = "ContractViolation";
  readonly operationId: string;
  readonly status: number;
  /** Schema paths only (instance paths and keywords), never values. */
  readonly problems: string[];
  constructor(operationId: string, status: number, problems: string[]) {
    super("response does not match the contract");
    this.operationId = operationId;
    this.status = status;
    this.problems = problems;
  }
}

type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats =
  (formatsPlugin as unknown as { default?: AddFormats }).default ??
  (formatsPlugin as unknown as AddFormats);

export class ResponseValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(this.ajv);
    this.ajv.addSchema({ $id: "contract", $defs: contractSchemas });
  }

  private fn(schema: string): ValidateFunction {
    let f = this.cache.get(schema);
    if (!f) {
      const got = this.ajv.getSchema(`contract#/$defs/${schema}`);
      if (!got) throw new Error(`unknown contract schema ${schema}`);
      f = got;
      this.cache.set(schema, f);
    }
    return f;
  }

  /** Throws ContractViolation when (status, body) is not what `op` declares. */
  check(op: ContractOperation, status: number, body: unknown): void {
    const declared = op.responses[String(status)];
    const resp = declared ?? (status >= 400 ? op.responses.default : undefined);
    if (!resp)
      throw new ContractViolation(op.operationId, status, [
        "status not declared",
      ]);
    if (resp.schema === null) {
      if (body !== undefined && resp.contentType !== "text/csv")
        throw new ContractViolation(op.operationId, status, [
          "body not allowed",
        ]);
      return;
    }
    this.checkSchema(resp.schema, body, op.operationId, status);
  }

  checkSchema(
    schema: string,
    body: unknown,
    operationId: string,
    status: number,
  ): void {
    const f = this.fn(schema);
    if (!f(body)) {
      const problems = (f.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.keyword}`,
      );
      throw new ContractViolation(operationId, status, problems);
    }
  }
}

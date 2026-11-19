import { Ajv2020 } from "ajv/dist/2020.js";
import type { FromSchema, JSONSchema } from "json-schema-to-ts";
import { AgentError } from "./errors.js";

export type { JSONSchema };
export interface StandardSchema<T = unknown> {
  readonly "~standard": {
    readonly version: 1;
    validate(value: unknown): Validation<T> | Promise<Validation<T>>;
    jsonSchema: { input(options: { target: "draft-2020-12" }): Record<string, unknown> };
  };
}
type Validation<T> = { value: T; issues?: undefined } | { issues: readonly { message: string }[] };
export type Schema = StandardSchema | Exclude<JSONSchema, boolean>;
export type Infer<S extends Schema> = S extends StandardSchema<infer T> ? T
  : S extends JSONSchema ? FromSchema<S> : never;

// No remote loader or custom keywords. Format is annotation in the default vocabulary.
const ajv = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true });
const draft = "https://json-schema.org/draft/2020-12/schema";

export function schema(input: Schema) {
  const standard = "~standard" in input ? input["~standard"] as StandardSchema["~standard"] : undefined;
  const parameters: Record<string, unknown> = { ...structuredClone(
    standard ? standard.jsonSchema.input({ target: "draft-2020-12" }) : input
  ), $schema: draft };
  function inspect(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    for (const key of ["$ref", "$dynamicRef"]) {
      if (typeof object[key] === "string" && !object[key].startsWith("#")) {
        throw new AgentError("invalid_params", "Schema references must stay in the document");
      }
    }
    for (const value of Object.values(object)) inspect(value);
  }
  inspect(parameters);
  const validate = ajv.compile(parameters);
  return {
    parameters,
    async parse(value: unknown, code: "invalid_request" | "invalid_params" = "invalid_request") {
      if (!validate(value)) throw new AgentError(code, ajv.errorsText(validate.errors));
      if (!standard) return value;
      const result = await standard.validate(value);
      if (result.issues) throw new AgentError(code, result.issues.map(i => i.message).join("; "));
      return result.value;
    },
  };
}

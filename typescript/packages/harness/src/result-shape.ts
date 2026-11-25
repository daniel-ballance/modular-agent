import { Ajv2020 } from "ajv/dist/2020.js";

const schemaValidator = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true, addUsedSchema: false });

export function shapeViolation(shape: Record<string, unknown>, value: unknown): string | undefined {
	if (value === undefined) return "Return a JSON value matching the result schema.";
	try {
		const validate = schemaValidator.compile(shape);
		if (!validate(value)) return `Value does not match the schema: ${schemaValidator.errorsText(validate.errors)}`;
	} catch { return "Invalid JSON Schema"; }
}

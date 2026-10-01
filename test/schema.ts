import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

/** The protocol schema, parsed. */
export const schema: { $defs: Record<string, { enum?: string[] }> } = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "protocol", "noli-bridge.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validateFrame = ajv.compile(schema);

/** Throws with every schema violation if `frame` isn't a valid server frame. */
export function assertValidFrame(frame: unknown): void {
	if (validateFrame(frame)) return;
	throw new Error(`frame violates protocol schema:\n${ajv.errorsText(validateFrame.errors, { separator: "\n" })}\nframe: ${JSON.stringify(frame)}`);
}

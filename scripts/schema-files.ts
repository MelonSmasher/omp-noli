import { renameSync, rmSync, writeFileSync } from "node:fs";

export interface SchemaFile { path: string; text: string }

/** Stage every validated output before replacing any destination. Each rename is atomic. */
export function writeSchemaFiles(outputs: readonly SchemaFile[]): void {
	const staged = outputs.map(output => ({ ...output, temporary: `${output.path}.${crypto.randomUUID()}.tmp` }));
	try {
		for (const output of staged) writeFileSync(output.temporary, output.text, { flag: "wx" });
		for (const output of staged) renameSync(output.temporary, output.path);
	} finally {
		for (const output of staged) rmSync(output.temporary, { force: true });
	}
}

import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSchemaFiles } from "../scripts/schema-files";

const root = join(import.meta.dir, "..");
const generated = ["protocol/noli-forge-read-tool.schema.json", "protocol/noli-forge-write-tool.schema.json", "protocol/noli-bridge.schema.json", "src/forge-schema-selectors.ts"];

/** Run the real generator against disposable copies, never the checkout's outputs. */
async function failedRefresh(writeSchema: string, error: RegExp): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "noli-schema-refresh-"));
	try {
		for (const name of ["scripts", "src", "protocol", "incoming"]) mkdirSync(join(dir, name));
		for (const name of [...generated, "src/protocol.ts", "scripts/generate-schema.ts", "scripts/schema-text.ts", "scripts/schema-files.ts"]) copyFileSync(join(root, name), join(dir, name));
		const before = generated.map(name => readFileSync(join(dir, name), "utf8"));
		// A changed but valid first source exposes premature writes before the second is validated.
		writeFileSync(join(dir, "incoming/noli-forge-read-tool.schema.json"), `${before[0]}\n`);
		writeFileSync(join(dir, "incoming/noli-forge-write-tool.schema.json"), writeSchema);
		const child = Bun.spawn([Bun.which("bun")!, join(dir, "scripts/generate-schema.ts")], {
			cwd: dir, stdout: "pipe", stderr: "pipe",
			env: { ...process.env, NODE_PATH: join(root, "node_modules"), NOLI_FORGE_PROTOCOL_DIR: join(dir, "incoming") },
		});
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exit).not.toBe(0);
		expect(stdout + stderr).toMatch(error);
		expect(generated.map(name => readFileSync(join(dir, name), "utf8"))).toEqual(before);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

// Each case spawns a fresh Bun process that cold-loads the TypeScript
// compiler (~4 s unloaded); the 5 s default flakes under parallel CI load.
const SUBPROCESS_TIMEOUT_MS = 30_000;

test("schema refresh parses every source before changing any output", async () => {
	await failedRefresh("{ invalid JSON", /JSON|Parse/);
}, SUBPROCESS_TIMEOUT_MS);

test("schema refresh rejects inconsistent shared definitions without changing any output", async () => {
	const schema = JSON.parse(readFileSync(join(root, generated[1]!), "utf8"));
	schema.$defs.ForgeResourceKind.enum.push("mismatched_kind");
	await failedRefresh(JSON.stringify(schema), /Native read\/write handle schemas disagree: ForgeResourceKind/);
}, SUBPROCESS_TIMEOUT_MS);

test("schema replacement stages all outputs before the first rename and removes staging files on failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-schema-stage-"));
	try {
		const first = join(dir, "first");
		writeFileSync(first, "original");
		expect(() => writeSchemaFiles([{ path: first, text: "replacement" }, { path: join(dir, "missing/second"), text: "second" }])).toThrow();
		expect(readFileSync(first, "utf8")).toBe("original");
		expect(readdirSync(dir)).toEqual(["first"]);
		writeSchemaFiles([{ path: first, text: "replacement" }, { path: join(dir, "second"), text: "second" }]);
		expect(readFileSync(first, "utf8")).toBe("replacement");
		expect(readFileSync(join(dir, "second"), "utf8")).toBe("second");
		expect(readdirSync(dir).sort()).toEqual(["first", "second"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

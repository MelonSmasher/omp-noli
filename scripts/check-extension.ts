import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const dir = mkdtempSync(join(tmpdir(), "noli-extension-check-"));
const previousDir = process.env.NOLI_BRIDGE_DIR;
const previousToken = process.env.NOLI_BRIDGE_TOKEN;
try {
	process.env.NOLI_BRIDGE_DIR = dir;
	process.env.NOLI_BRIDGE_TOKEN = crypto.randomUUID();
	const loaded = await loadExtensions([resolve(import.meta.dir, "../src/index.ts")], dir);
	assert.deepEqual(loaded.errors, [], "supported OMP must import and initialize the extension");
	assert.equal(loaded.extensions.length, 1);
	console.log("EXTENSION LOAD PASSED");
} finally {
	if (previousDir === undefined) delete process.env.NOLI_BRIDGE_DIR;
	else process.env.NOLI_BRIDGE_DIR = previousDir;
	if (previousToken === undefined) delete process.env.NOLI_BRIDGE_TOKEN;
	else process.env.NOLI_BRIDGE_TOKEN = previousToken;
	rmSync(dir, { recursive: true, force: true });
}

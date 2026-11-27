import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const dir = mkdtempSync(join(tmpdir(), "noli-extension-check-"));
const previousDir = process.env.NOLI_BRIDGE_DIR;
const previousTokenFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
try {
	process.env.NOLI_BRIDGE_DIR = dir;
	const tokenFile = join(dir, "bootstrap-token");
	writeFileSync(tokenFile, crypto.randomUUID(), { mode: 0o600 });
	process.env.NOLI_BRIDGE_TOKEN_FILE = tokenFile;
	const loaded = await loadExtensions([resolve(import.meta.dir, "../src/index.ts")], dir);
	assert.deepEqual(loaded.errors, [], "supported OMP must import and initialize the extension");
	assert.equal(loaded.extensions.length, 1);
	assert.equal(existsSync(tokenFile), false, "factory consumes the private bootstrap file");
	console.log("EXTENSION LOAD PASSED");
} finally {
	if (previousDir === undefined) delete process.env.NOLI_BRIDGE_DIR;
	else process.env.NOLI_BRIDGE_DIR = previousDir;
	if (previousTokenFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE;
	else process.env.NOLI_BRIDGE_TOKEN_FILE = previousTokenFile;
	rmSync(dir, { recursive: true, force: true });
}

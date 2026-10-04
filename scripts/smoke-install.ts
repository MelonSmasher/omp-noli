import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const tag = process.argv[2];
assert(tag && /^v\d+\.\d+\.\d+$/.test(tag), "Pass a published stable release tag");
const dir = mkdtempSync(join(tmpdir(), "noli-release-install-"));
try {
	const env: Record<string, string> = { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_PROFILE: "release-smoke", PI_CODING_AGENT_DIR: join(dir, "agent"), XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), BUN_INSTALL_CACHE_DIR: join(dir, "bun-cache"), CI: "true", NO_COLOR: "1" };
	const cli = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
	const child = Bun.spawn([process.execPath, cli, "--profile", "release-smoke", "plugin", "install", `github:MelonSmasher/omp-noli#${tag}`], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
	const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	assert.equal(exit, 0, `Official isolated installation failed: ${out}\n${err}`);
	const files = readdirSync(dir, { recursive: true });
	const manifest = files.find(file => String(file).endsWith("node_modules/omp-noli/package.json"));
	assert(manifest, "Official plugin installer created package");
	const packageRoot = join(dir, String(manifest).slice(0, -"package.json".length));
	const pkg = await Bun.file(join(packageRoot, "package.json")).json();
	assert.equal(pkg.version, tag.slice(1));
	const entries: unknown = pkg.omp?.extensions;
	assert(Array.isArray(entries) && entries.length > 0 && entries.every(entry => typeof entry === "string"), "Installed manifest declares non-empty extension entries");
	const loaded = await loadExtensions(entries.map(entry => join(packageRoot, entry)), dir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	// Published plugin path is selected by the official installer at runtime, not this checkout.
	const protocol = await import(join(packageRoot, "src/protocol.ts"));
	assert.equal(protocol.PROTOCOL_VERSION, 1);
	assert.deepEqual(protocol.NATIVE_METHODS, ["tree.navigate", "goal.budget", "memory.status", "memory.search", "memory.save"]);
	console.log(`PUBLISHED INSTALL SMOKE PASSED: ${tag}, official OMP 18.6.1, isolated disposable HOME/profile, installed manifest aligned, extension imported, negotiated methods verified`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

const selection = process.argv[2];
const root = resolve(import.meta.dir, "..");
if (selection === "--verify") {
	// A fresh process uses exactly the disposable install's HOME/config, not ambient SDK caches.
	const dir = process.argv[3]!;
	const expectedVersion = process.argv[4]!;
	const installed = (await getEnabledPlugins(dir, { home: dir })).filter(plugin => plugin.name === "omp-noli");
	assert.equal(installed.length, 1, "Official discovery finds one enabled installed plugin");
	const plugin = installed[0]!;
	assert.equal(plugin.version, expectedVersion);
	const entries = resolvePluginExtensionPaths(plugin);
	assert.equal(entries.length, 1, "Installed manifest resolves one extension");
	const loaded = await loadExtensions(entries, dir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert(loaded.extensions[0]!.handlers.has("tool_call"), "Installed extension initializes host-tool policy with authenticated bootstrap environment");
	// Runtime-selected installed package path must not resolve to this checkout's protocol module.
	const protocol = await import(join(plugin.path, "src/protocol.ts"));
	assert.equal(protocol.PROTOCOL_VERSION, 1);
	assert(protocol.CAPABILITY_NAMES.includes("host.thread_read"));
	assert.deepEqual(protocol.NATIVE_METHODS, ["tree.navigate", "goal.budget", "memory.status", "memory.search", "memory.save"]);
	const schema = await Bun.file(join(plugin.path, "protocol/noli-bridge.schema.json")).json();
	assert(schema.$defs.CapabilityApi.enum.includes("main-only-v2"));
	assert.equal(schema.$defs.Capabilities.properties["host.thread_read"].allOf[1].properties.api.const, "main-only-v2");
	console.log("NOLI_RELEASE_INSTALL_OK");
} else {
	assert(selection === "--local" || (selection && /^v\d+\.\d+\.\d+$/.test(selection)), "Pass --local or a published stable release tag");
	const local = selection === "--local";
	const expectedVersion = local ? (await Bun.file(join(root, "package.json")).json()).version : selection.slice(1);
	const spec = local ? root : `github:MelonSmasher/omp-noli#${selection}`;
	const dir = mkdtempSync(join(tmpdir(), "noli-release-install-"));
	try {
		const bridgeDir = join(dir, "bridge");
		mkdirSync(bridgeDir, { mode: 0o700 });
		const env: Record<string, string> = { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_PROFILE: "release-smoke", PI_CODING_AGENT_DIR: join(dir, "agent"), XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), BUN_INSTALL_CACHE_DIR: join(dir, "bun-cache"), CI: "true", NO_COLOR: "1" };
		const cli = join(root, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
		const install = Bun.spawn([process.execPath, cli, "--profile", "release-smoke", "plugin", "install", spec], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		const [out, err, exit] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
		assert.equal(exit, 0, `Official isolated installation failed: ${out}\n${err}`);
		const verify = Bun.spawn([process.execPath, import.meta.path, "--verify", dir, expectedVersion], { cwd: dir, env: { ...env, NOLI_BRIDGE_DIR: bridgeDir, NOLI_BRIDGE_TOKEN: crypto.randomUUID() }, stdout: "pipe", stderr: "pipe" });
		const [verified, failure, code] = await Promise.all([new Response(verify.stdout).text(), new Response(verify.stderr).text(), verify.exited]);
		assert.equal(code, 0, `Installed extension verification failed: ${verified}\n${failure}`);
		assert(verified.includes("NOLI_RELEASE_INSTALL_OK"));
		console.log(`NOLI_RELEASE_INSTALL_OK: ${local ? "prepared local checkout" : selection}, official OMP 18.6.1, isolated disposable HOME/profile, enabled plugin discovery, extension initialization and reference-read negotiation`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

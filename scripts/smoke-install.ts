import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ServerFrame } from "../src/protocol";
import { type } from "@oh-my-pi/omptype";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";

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
	if (process.argv[5] === "--local") assert.equal(realpathSync(plugin.path), realpathSync(root), "Local installer links exactly the prepared source");
	else assert.notEqual(realpathSync(plugin.path), realpathSync(root), "Published install loads downloaded source, not this checkout");
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
	const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "runtime-agent"), sessionManager: SessionManager.create(dir, join(dir, "sessions")), settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false, preloadedExtensionPaths: entries });
	let socket: Socket | undefined;
	try {
		const runtime = created.session.extensionRunner;
		assert(runtime);
		await created.session.refreshRpcHostTools(["noli_thread_read"].map(name => ({ name, label: name, description: "Policy smoke only; no backend invocation", parameters: type({ reference_id: "string" }), execute: async () => { throw new Error("Smoke must never invoke the backend host tool"); } })));
		await initializeExtensions(created.session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
		const call = { type: "tool_call" as const, toolName: "noli_thread_read", toolCallId: "installed-policy", input: { reference_id: "public-smoke-reference", limit: 1 } };
		assert.equal((await runtime.emitToolCall(call))?.block, true, "Before authenticated hello even real main is denied");
		const hello = await new Promise<ServerFrame>((resolveFrame, reject) => {
			const timeout = setTimeout(() => reject(new Error("Installed bridge hello timed out")), 5000);
			let buffered = "";
			socket = connect(join(process.env.NOLI_BRIDGE_DIR!, `omp-${process.pid}.sock`));
			socket.once("error", error => { clearTimeout(timeout); reject(error); });
			socket.on("data", data => {
				buffered += data.toString();
				const newline = buffered.indexOf("\n");
				if (newline === -1) return;
				clearTimeout(timeout);
				resolveFrame(JSON.parse(buffered.slice(0, newline)) as ServerFrame);
			});
			socket.once("connect", () => socket!.write(`${JSON.stringify({ id: 1, method: "hello", params: { token: process.env.NOLI_BRIDGE_TOKEN } })}\n`));
		});
		assert(hello.type === "response" && hello.ok);
		const advertised = hello.result as { capabilities?: Record<string, { api: string; available: boolean }> };
		assert.equal(advertised.capabilities?.["host.thread_read"]?.api, "main-only-v2");
		assert.equal(advertised.capabilities?.["host.thread_read"]?.available, true);
		const admitted = await runtime.emitToolCall(call);
		assert.equal(admitted?.block, undefined, `Actual installed policy accepts authenticated SDK/main reference read: ${admitted?.reason ?? "no denial"}`);
		assert.equal((await runtime.emitToolCall({ ...call, input: { thread_id: "legacy" } }))?.block, true);
		assert.equal((await runtime.emitToolCall({ ...call, input: { reference_id: "public-smoke-reference", endpoint: "forbidden" } }))?.block, true);
		assert.equal((await runtime.emitToolCall(call, undefined, { kind: "sub", id: "child", name: "child", depth: 1, parentId: "Main" }))?.block, true);
		console.log("NOLI_RELEASE_INSTALL_OK");
	} finally {
		socket?.destroy();
		await created.session.dispose();
	}
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
		const runtime = Bun.spawn(["omp", "--version"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		const [version, versionError, versionExit] = await Promise.all([new Response(runtime.stdout).text(), new Response(runtime.stderr).text(), runtime.exited]);
		assert.equal(versionExit, 0, `Official installed OMP binary unavailable: ${versionError}`);
		const install = Bun.spawn(["omp", "plugin", "install", spec], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		const [out, err, exit] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
		assert.equal(exit, 0, `Official isolated installation failed: ${out}\n${err}`);
		const verify = Bun.spawn(["bun", import.meta.path, "--verify", dir, expectedVersion, local ? "--local" : "--published"], { cwd: dir, env: { ...env, NOLI_BRIDGE_DIR: bridgeDir, NOLI_BRIDGE_TOKEN: crypto.randomUUID() }, stdout: "pipe", stderr: "pipe" });
		const [verified, failure, code] = await Promise.all([new Response(verify.stdout).text(), new Response(verify.stderr).text(), verify.exited]);
		assert.equal(code, 0, `Installed extension verification failed: ${verified}\n${failure}`);
		assert(verified.includes("NOLI_RELEASE_INSTALL_OK"));
		console.log(`NOLI_RELEASE_INSTALL_OK: ${local ? "prepared local checkout" : selection}, ${version.trim()}, pinned SDK 18.6.1 extension loader, isolated disposable HOME/profile, enabled plugin discovery, extension initialization and reference-read negotiation`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

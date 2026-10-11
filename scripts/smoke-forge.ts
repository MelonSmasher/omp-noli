import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSession, SessionManager, Settings, VERSION } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { ForgeClient } from "./fixtures/forge-client";
import { verifyForgeRuntime } from "./fixtures/forge-runtime";

assert.equal(VERSION, "18.8.2", "Qualification uses the pinned official SDK");
const root = resolve(import.meta.dir, "..");
if (process.argv[2] !== "--verify") {
	const dir = mkdtempSync(join(tmpdir(), "noli-forge-runtime-"));
	try {
		const bun = Bun.which("bun"); assert(bun);
		const child = Bun.spawn([bun, import.meta.path, "--verify", dir], { cwd: dir, env: { HOME: dir, PATH: `${dirname(bun)}:${process.env.PATH ?? "/usr/bin:/bin"}`, PI_CODING_AGENT_DIR: join(dir, "agent"), OMP_PROFILE: "forge-smoke", XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), CI: "true", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
		const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		assert.equal(exit, 0, `Official forge qualification failed: ${out}\n${err}`);
		assert(out.includes("OFFICIAL FORGE RUNTIME OK")); assert(out.includes("OFFICIAL FORGE PROVENANCE OK"));
		process.stdout.write(out);
	} finally { rmSync(dir, { recursive: true, force: true }); }
} else {
	const dir = process.argv[3]!;
	const bridgeDir = join(dir, "bridge"); mkdirSync(bridgeDir, { mode: 0o700 });
	const tokenFile = join(bridgeDir, "bootstrap-token");
	for (const nonSdk of [false, true]) {
		const token = randomUUID(); writeFileSync(tokenFile, token, { mode: 0o600 });
		process.env.NOLI_BRIDGE_DIR = bridgeDir; process.env.NOLI_BRIDGE_TOKEN_FILE = tokenFile;
		const created = await createAgentSession({ cwd: dir, agentDir: join(dir, nonSdk ? "lookalike-agent" : "runtime-agent"), sessionManager: SessionManager.create(dir, join(dir, nonSdk ? "lookalike-sessions" : "sessions")), settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false, preloadedExtensionPaths: [join(root, "src/index.ts"), ...(nonSdk ? [join(root, "scripts/fixtures/non-sdk-forge.ts")] : [])] });
		const session = created.session;
		const client = new ForgeClient(join(bridgeDir, `omp-${process.pid}.sock`), token, () => session.sessionId);
		try {
			await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
			const runtime = session.extensionRunner; assert(runtime);
			const call = { type: "tool_call" as const, toolName: "noli_forge_resource", toolCallId: "forge-before-auth", input: { action: "resolve_review", number: "42" } };
			assert.equal((await runtime.emitToolCall(call))?.block, true, "Unauthenticated main cannot call forge tools");
			await client.connect();
			if (nonSdk) {
				assert(!session.hasRpcHostTool("noli_forge_resource"));
				const tool = session.getToolByName("noli_forge_resource"); assert(tool);
				await assert.rejects(tool.execute("non-sdk-forge", call.input), /Authenticated Noli thread control is unavailable/);
				console.log("OFFICIAL FORGE PROVENANCE OK: real extension-owned lookalike is denied despite authenticated owning-main context; SDK 18.8.2, disposable HOME/profile, no model requests");
			} else await verifyForgeRuntime(session, (method, params) => client.request(method, params), () => client.reconnect());
		} finally { await client.disconnect(); await session.dispose(); }
	}
}

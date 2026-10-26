import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, ExtensionAgentIdentity } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { RpcHostToolCallRequest, RpcHostToolCancelRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { ForgeClient } from "./forge-client";

// Policy-only fixture. Results below are deliberate guard inputs, not Noli journal,
// approval, provider or live mutation receipts. Native OMP 18.10.1 pairing is a separate gate.
const target = {
	origin: "github", account: "selected", repository: { provider: "github", repository_id: "9007199254740993", node_id: "R_fixture" },
	kind: "issue", resource: { type: "github", id: "9007199254740995", node_id: "I_fixture", number: "7" },
	web_url: "https://github.com/fixture/repository/issues/7",
};
const cases = [
	{ name: "noli_forge_read_v1", input: { action: "read", read: { resource: "task_snapshot", request: { attempt_id: "fixture-attempt", sequence: 0 } }, byte_budget: 1024 } },
	{ name: "noli_forge_write_v1", input: { target, payload: { kind: "issue", mutation: { action: "comment", body: "Policy fixture only" } }, precondition: { kind: "updated_at", value: "2026-10-13T00:00:00Z" } } },
	{ name: "noli_forge_write_status_v1", input: { operation_id: "fixture-operation" } },
] as const;
const content = [{ type: "text" as const, text: "private-installed-policy-canary" }];
const errorText = "private-installed-backend-denial";
const detailsFor = (name: string) => name === "noli_forge_write_v1"
	? { status: "pending_approval", operation_id: "fixture-operation" }
	: { trust: "untrusted_provider_content", fixture_canary: "private-installed-metadata" };

export async function verifyInstalledForgeRuntime(session: AgentSession, installedPath: string, client: ForgeClient) {
	const runtime = session.extensionRunner;
	assert(runtime);
	// Select modules using the official install discovery result, never checkout imports.
	const modulePaths = ["forge-read-tools.ts", "forge-write-tools.ts", "thread-control.ts"].map(file => realpathSync(join(installedPath, "src", file)));
	const [read, write, control] = await Promise.all(modulePaths.map(path => import(pathToFileURL(path).href)));
	assert.equal(read.FORGE_READ_TOOL, cases[0].name);
	assert.deepEqual(write.FORGE_WRITE_TOOLS, cases.slice(1).map(item => item.name));
	for (const item of cases) assert(control.THREAD_TOOLS.includes(item.name), `Installed consumer must include ${item.name}`);
	assert.equal(read.forgeReadArguments(cases[0].input), true);
	assert.equal(read.forgeReadArguments({ ...cases[0].input, endpoint: "forbidden" }), false);
	assert.equal(write.forgeWriteArguments(cases[1].input, "installed-policy-fixture"), true);
	assert.equal(write.forgeWriteArguments({ ...cases[1].input, approved: true }, "installed-policy-fixture"), false);
	assert.equal(write.forgeWriteStatusArguments(cases[2].input), true);
	assert.equal(write.forgeWriteStatusArguments({ ...cases[2].input, retry: true }), false);

	const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
	let arrived: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const bridge = new RpcHostToolBridge(frame => { frames.push(frame); arrived?.(); });
	async function nextFrame() {
		if (!frames.length) await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => { arrived = undefined; timer = undefined; reject(new Error("Installed SDK host-tool frame timed out")); }, 5000);
			arrived = () => { clearTimeout(timer); timer = undefined; arrived = undefined; resolve(); };
		});
		return frames.shift()!;
	}
	function answer(frame: RpcHostToolCallRequest | RpcHostToolCancelRequest, name: string, isError = false, details: unknown = detailsFor(name)) {
		assert.equal(frame.type, "host_tool_call");
		assert(bridge.handleResult({ type: "host_tool_result", id: frame.id, isError, result: { content: isError ? [{ type: "text", text: errorText }] : content, details } }));
	}
	const adapters = bridge.setTools(cases.map(item => ({ name: item.name, label: item.name, description: "Installed policy-only guard fixture", parameters: { type: "object" } })));
	try {
		await session.refreshRpcHostTools(adapters);
		for (const item of cases) {
			const tool = session.getToolByName(item.name); assert(tool && session.hasRpcHostTool(item.name));
			await assert.rejects(tool.execute(`installed-unauth-${item.name}`, item.input), /Authenticated Noli thread control is unavailable/);
			assert.equal(frames.length, 0, "Unauthenticated tools cannot reach fixture backend");
		}
		await session.refreshRpcHostTools([]);
		const hello = await client.connect();
		assert(hello.type === "response" && hello.ok);
		const negotiated = await client.request("capabilities.get", { hostTools: true });
		assert(negotiated.type === "response" && negotiated.ok);
		const advertised = negotiated.result as { capabilities: Record<string, { api: string; available: boolean }> };
		for (const capability of ["host.forge_read", "host.forge_write"]) {
			assert.equal(advertised.capabilities[capability]?.api, "session-v2");
			assert.equal(advertised.capabilities[capability]?.available, true, "Required support must precede host-tool registration");
		}
		for (const item of cases) assert.equal((await runtime.emitToolCall({ type: "tool_call", toolName: item.name, toolCallId: `installed-absent-${item.name}`, input: item.input }))?.block, true, "Authenticated but unregistered tools are denied");
		await session.refreshRpcHostTools(adapters);
		for (const [index, item] of cases.entries()) {
			// This fixture also qualifies published pre-v0.9.7 releases with legacy shape errors.
			const shapeError = item.name === "noli_forge_read_v1" ? /Invalid|Unexpected forge read field:|Unsupported forge read resource:/ : /Invalid/;
			const tool = session.getToolByName(item.name); assert(tool && session.hasRpcHostTool(item.name));
			const admitted = tool.execute(`installed-main-${item.name}`, item.input);
			const frame = await nextFrame();
			assert(frame.type === "host_tool_call");
			assert.equal(frame.toolName, item.name);
			assert.deepEqual(frame.arguments, item.input);
			answer(frame, item.name);
			assert.deepEqual(await admitted, { content, details: detailsFor(item.name) }, "Actual SDK wrapper consumes installed admission and result policy");
			for (const id of ["fixture-child", "advisor"]) {
				const identity = { kind: "sub", id, name: id, depth: 1, parentId: "Main" } as ExtensionAgentIdentity;
				const caller: ExtensionToolWrapper = new ExtensionToolWrapper(adapters[index]!, runtime, identity);
				if (id === "advisor" && item.name !== "noli_forge_read_v1") {
					await assert.rejects(caller.execute(`installed-${id}-${item.name}`, item.input), /advisor is read-only/);
					assert.equal(frames.length, 0, "Advisors cannot propose writes or inspect write operations");
					continue;
				}
				const pending: Promise<AgentToolResult<unknown>> = caller.execute(`installed-${id}-${item.name}`, item.input);
				const callerFrame = await nextFrame();
				assert(callerFrame.type === "host_tool_call");
				assert.equal(callerFrame.toolName, item.name);
				const requester = id === "advisor" ? { kind: "advisor" } : { kind: "child", agent_id: id };
				assert.deepEqual(callerFrame.arguments, { ...item.input, noli_requester: requester });
				answer(callerFrame, item.name);
				assert.deepEqual(await pending, { content, details: detailsFor(item.name) }, "Installed guard admits runtime-attributed session callers");
				await assert.rejects(caller.execute(`installed-forged-${id}-${item.name}`, { ...item.input, noli_requester: requester }), shapeError);
				assert.equal(frames.length, 0, "Callers cannot supply their own attribution");
			}
			const unattributed = new ExtensionToolWrapper(adapters[index]!, runtime, { kind: "sub", id: "", name: "unknown", depth: 1, parentId: "Main" } as ExtensionAgentIdentity);
			await assert.rejects(unattributed.execute(`installed-unattributed-${item.name}`, item.input), /restricted to the owning session/);
			assert.equal(frames.length, 0);
			for (const key of ["caller", "noli_requester", "token", "endpoint", "session_id", "grant", "approved", "unknown"]) {
				await assert.rejects(tool.execute(`installed-invalid-${item.name}-${key}`, { ...item.input, [key]: "forged" }), shapeError);
				assert.equal(frames.length, 0, "Unknown envelope fields cannot reach fixture backend");
			}
			const malformed = item.name === "noli_forge_read_v1"
				? [{ action: "read", read: { resource: "task_snapshot", request: { attempt_id: "fixture-attempt", sequence: 0, grant: "forged" } } }, { action: "read", read: { resource: "unknown", request: {} } }, { action: "continue", cursor: "not-a-cursor" }]
				: item.name === "noli_forge_write_v1"
					? [{ ...cases[1].input, target: { ...target, token: "forged" } }, { ...cases[1].input, payload: null }, { ...cases[1].input, precondition: {} }]
					: [{ operation_id: "" }, { operation_id: "bad\nidentifier" }, { operation_id: 7 }];
			for (const input of malformed) {
				await assert.rejects(tool.execute(`installed-malformed-${item.name}`, input), shapeError);
				assert.equal(frames.length, 0, "Closed producer envelopes deny malformed data before dispatch");
			}
			const denied = assert.rejects(tool.execute(`installed-denied-${item.name}`, item.input), new RegExp(errorText));
			answer(await nextFrame(), item.name, true); await denied;
			const abort = new AbortController();
			const cancelled = assert.rejects(tool.execute(`installed-cancel-${item.name}`, item.input, abort.signal), /was aborted/);
			const cancelFrame = await nextFrame(); abort.abort();
			const cancellation = await nextFrame();
			assert(cancellation.type === "host_tool_cancel");
			assert.equal(cancellation.targetId, cancelFrame.id); await cancelled;
			assert.equal(bridge.handleResult({ type: "host_tool_result", id: cancelFrame.id, result: { content, details: detailsFor(item.name) } }), false);
			for (const isError of [false, true]) for (const invalidate of ["tree", "reconnect", "adoption"] as const) {
				const pending: Promise<AgentToolResult<unknown>> = tool.execute(`installed-stale-${item.name}-${invalidate}-${isError}`, item.input);
				const pendingFrame = await nextFrame();
				if (invalidate === "tree") await runtime.emit({ type: "session_tree", newLeafId: session.sessionManager.getLeafId(), oldLeafId: session.sessionManager.getLeafId() });
				else if (invalidate === "reconnect") await client.reconnect();
				else {
					const previousSessionFile = session.sessionManager.getSessionFile();
					await session.sessionManager.newSession();
					for (const candidate of cases) await assert.rejects(session.getToolByName(candidate.name)!.execute(`installed-foreign-${candidate.name}`, candidate.input), /Authenticated Noli thread control is unavailable/);
					assert.equal(frames.length, 0);
					await runtime.emit({ type: "session_switch", reason: "new", previousSessionFile });
					const adopted = await client.request("session.adopt", { sessionId: session.sessionId });
					assert(adopted.type === "response" && adopted.ok);
				}
				answer(pendingFrame, item.name, isError);
				const stale: AgentToolResult<unknown> = await pending;
				assert.equal(stale.isError, true);
				assert.deepEqual(stale.details, {});
				assert(!JSON.stringify(stale).includes("private-installed"), "Stale success, error and metadata must be scrubbed by the installed consumer");
			}
			const fresh: Promise<AgentToolResult<unknown>> = tool.execute(`installed-fresh-${item.name}`, item.input); answer(await nextFrame(), item.name);
			assert.deepEqual(await fresh, { content, details: detailsFor(item.name) }, "Fresh authenticated control succeeds after stale-result checks");
		}
		const proposalTool = session.getToolByName(cases[1].name)!;
		for (const details of [{ status: "acknowledged", operation_id: "fixture-operation" }, { status: "completed", operation_id: "fixture-operation" }, { status: "pending_approval" }, { status: "pending_approval", operation_id: "fixture-operation", approved: true }]) {
			const invalid = proposalTool.execute("installed-invalid-admission", cases[1].input);
			answer(await nextFrame(), cases[1].name, false, details);
			const rejected = await invalid;
			assert.equal(rejected.isError, true);
			assert.deepEqual(rejected.details, {});
			assert(!JSON.stringify(rejected).includes("private-installed"));
		}
		console.log(`NOLI_INSTALLED_FORGE_MODULES: ${JSON.stringify(modulePaths)}`);
		return hello;
	} finally {
		clearTimeout(timer); arrived = undefined;
		bridge.close("Installed policy fixture complete");
		await session.refreshRpcHostTools([]);
	}
}

export async function verifyInstalledForgeProvenance(entries: string[], dir: string, tokenFile: string, bootstrap: string): Promise<void> {
	const fixtureDir = join(dir, "non-sdk-forge");
	mkdirSync(fixtureDir, { mode: 0o700 });
	const fixture = join(fixtureDir, "lookalike.ts");
	// Publish atomically in the disposable profile; never expose a partial command/module.
	writeFileSync(`${fixture}.tmp`, `import { type } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/omptype"))};\nexport default function(pi) { for (const name of ${JSON.stringify(cases.map(item => item.name))}) pi.registerTool({ name, label: name, description: "Negative provenance fixture", parameters: type({}), execute: async () => { throw new Error("NON_SDK_BACKEND_MUST_NOT_EXECUTE"); } }); }\n`, { mode: 0o600 });
	renameSync(`${fixture}.tmp`, fixture);
	writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
	process.env.NOLI_BRIDGE_TOKEN_FILE = tokenFile;
	let session: AgentSession | undefined;
	let client: ForgeClient | undefined;
	try {
		const created = await createAgentSession({ cwd: dir, agentDir: join(fixtureDir, "agent"), sessionManager: SessionManager.create(dir, join(fixtureDir, "sessions")), settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false, preloadedExtensionPaths: [...entries, fixture] });
		session = created.session;
		assert.deepEqual(created.extensionsResult.errors, []);
		await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
		client = new ForgeClient(join(process.env.NOLI_BRIDGE_DIR!, `omp-${process.pid}.sock`), bootstrap, () => session!.sessionId);
		const hello = await client.connect(); assert(hello.type === "response" && hello.ok);
		for (const item of cases) {
			assert(!session.hasRpcHostTool(item.name));
			const tool = session.getToolByName(item.name); assert(tool);
			await assert.rejects(tool.execute(`installed-non-sdk-${item.name}`, item.input), /Authenticated Noli thread control is unavailable/);
		}
	} finally {
		await client?.disconnect();
		await session?.dispose();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}

import assert from "node:assert/strict";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionAgentIdentity } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type { RpcHostToolCallRequest, RpcHostToolCancelRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ServerFrame } from "../../src/protocol";
import type { ForgeClient } from "./forge-client";

export async function verifyForgeRuntime(session: AgentSession, request: (method: string, params?: Record<string, unknown>) => Promise<ServerFrame>, reconnect: () => Promise<void>, connectSecondary: () => Promise<ForgeClient>): Promise<void> {
	const runtime = session.extensionRunner;
	assert(runtime);
	const negotiated = await request("capabilities.get", { hostTools: true });
	assert(negotiated.type === "response" && negotiated.ok);
	const advertised = type({ capabilities: { "host.forge_resource": { available: "boolean", api: "string" } } }).assert(negotiated.result);
	const capabilities = advertised.capabilities;
	assert.equal(capabilities["host.forge_resource"]?.api, "session-v2");
	assert.equal(capabilities["host.forge_resource"]?.available, true, "Bootstrap guard support precedes registration");
	const input = { action: "resolve_review", number: "9007199254740993" };
	const call = { type: "tool_call" as const, toolName: "noli_forge_resource", toolCallId: "unregistered-forge", input };
	assert.equal((await runtime.emitToolCall(call))?.block, true, "Authentication cannot authorize an absent SDK tool");
	const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
	let arrived: (() => void) | undefined;
	const bridge = new RpcHostToolBridge(frame => { frames.push(frame); arrived?.(); });
	async function nextFrame(): Promise<RpcHostToolCallRequest | RpcHostToolCancelRequest> {
		if (frames.length === 0) await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => { arrived = undefined; reject(new Error("Official host-tool frame timed out")); }, 5000);
			arrived = () => { clearTimeout(timeout); arrived = undefined; resolve(); };
		});
		return frames.shift()!;
	}
	const adapters = bridge.setTools([{ name: "noli_forge_resource", label: "Forge resource", description: "Disposable runtime transport qualification", parameters: { type: "object" } }]);
	await session.refreshRpcHostTools(adapters);
	const tool = session.getToolByName("noli_forge_resource");
	assert(tool);
	assert(session.hasRpcHostTool("noli_forge_resource"));
	const details = { trust: "untrusted_provider_content", result: { snapshot: { state: "fresh", content: "bounded backend snapshot" }, link: "forge:native-handle" } };
	const content = [{ type: "text" as const, text: "bounded provider content\n".repeat(2048) }];
	function answer(frame: RpcHostToolCallRequest | RpcHostToolCancelRequest, isError = false): void {
		assert.equal(frame.type, "host_tool_call");
		assert(bridge.handleResult({ type: "host_tool_result", id: frame.id, isError, result: { content: isError ? [{ type: "text", text: "permission denied by forge backend" }] : content, details: isError ? undefined : details } }));
	}
	const admitted = tool.execute("forge-admitted", input);
	const mainFrame = await nextFrame();
	assert(mainFrame.type === "host_tool_call");
	assert.deepEqual(mainFrame.arguments, input, "IDs reach the actual RPC transport as decimal strings");
	answer(mainFrame);
	assert.deepEqual(await admitted, { content, details }, "Bounded backend content is unchanged, not synthesized");
	const handle = { origin: "https://github.com", account: "selected-account", repository: { provider: "github", repository_id: "9007199254740993", node_id: "R_native" }, kind: "review", resource: { type: "github", id: "9007199254740995", number: "42", node_id: null }, web_url: "https://github.com/owner/repo/pull/42" };
	const read = tool.execute("forge-offline", { action: "read", handle, offline: true });
	const readFrame = await nextFrame();
	assert(readFrame.type === "host_tool_call");
	assert.deepEqual(readFrame.arguments, { action: "read", handle, offline: true });
	answer(readFrame); await read;
	const helloPending = tool.execute("forge-unrelated-hello", input);
	const helloFrame = await nextFrame();
	const secondary = await connectSecondary();
	answer(helloFrame);
	assert.deepEqual(await helloPending, { content, details }, "An unrelated authenticated hello cannot revoke the owning read");
	const disconnectPending = tool.execute("forge-unrelated-disconnect", input);
	const disconnectFrame = await nextFrame();
	await secondary.disconnect();
	await request("capabilities.get", { hostTools: true });
	answer(disconnectFrame);
	assert.deepEqual(await disconnectPending, { content, details }, "An unrelated socket disconnect cannot revoke the owning read");
	for (const id of ["fixture-child", "advisor"]) {
		const identity = { kind: "sub", id, name: id, depth: 1, parentId: "Main" } as ExtensionAgentIdentity;
		const caller: ExtensionToolWrapper = new ExtensionToolWrapper(adapters[0]!, runtime, identity);
		const pending: Promise<AgentToolResult<unknown>> = caller.execute(`forge-${id}`, input);
		const frame = await nextFrame();
		assert(frame.type === "host_tool_call");
		const requester = id === "advisor" ? { kind: "advisor" } : { kind: "child", agent_id: id };
		assert.deepEqual(frame.arguments, { ...input, noli_requester: requester }, "Only the runtime adds caller attribution");
		answer(frame);
		assert.deepEqual(await pending, { content, details }, "Attributed session callers receive current forge reads");
		await assert.rejects(caller.execute(`forge-forged-${id}`, { ...input, noli_requester: requester }), /Invalid/);
		assert.equal(frames.length, 0, "Model-supplied requester attribution never reaches the backend");
	}
	const unattributed = new ExtensionToolWrapper(adapters[0]!, runtime, { kind: "sub", id: "", name: "unknown", depth: 1, parentId: "Main" } as ExtensionAgentIdentity);
	await assert.rejects(unattributed.execute("forge-unattributed", input), /restricted to the owning session/);
	assert.equal(frames.length, 0, "Unattributed callers cannot reach the backend");
	for (const forged of [{ ...input, noli_requester: { kind: "child", agent_id: "fixture-child" } }, { ...input, caller: "Main" }, { ...input, token: "forged" }, { ...input, endpoint: "https://github.com/api" }, { action: "read", handle: { ...handle, account: 7 }, offline: false }, { action: "read", handle: { ...handle, repository: { ...handle.repository, credential: "forged" } }, offline: false }]) {
		await assert.rejects(tool.execute("forge-invalid", forged), /Invalid forge resource arguments/);
		assert.equal(frames.length, 0);
	}
	const denied = tool.execute("forge-backend-denial", input);
	const deniedCheck = assert.rejects(denied, /permission denied by forge backend/);
	answer(await nextFrame(), true); await deniedCheck;
	const abort = new AbortController();
	const cancelled = tool.execute("forge-cancelled", input, abort.signal);
	const cancelledCheck = assert.rejects(cancelled, /was aborted/);
	const cancelledFrame = await nextFrame(); abort.abort();
	const cancellation = await nextFrame();
	assert(cancellation.type === "host_tool_cancel");
	assert.equal(cancellation.targetId, cancelledFrame.id);
	await cancelledCheck;
	assert.equal(bridge.handleResult({ type: "host_tool_result", id: cancelledFrame.id, result: { content, details } }), false, "Cancelled RPC results cannot revive the call");
	for (const isError of [false, true]) for (const invalidate of ["tree", "reconnect", "adoption"] as const) {
		const pending: Promise<AgentToolResult<unknown>> = tool.execute(`forge-stale-${invalidate}-${isError}`, input);
		const frame = await nextFrame();
		if (invalidate === "tree") await runtime.emit({ type: "session_tree", newLeafId: session.sessionManager.getLeafId(), oldLeafId: session.sessionManager.getLeafId() });
		else if (invalidate === "reconnect") await reconnect();
		else {
			const previousSessionFile = session.sessionManager.getSessionFile();
			await session.sessionManager.newSession();
			assert.equal((await runtime.emitToolCall(call))?.block, true, "A foreign native session cannot borrow authenticated admission");
			await runtime.emit({ type: "session_switch", reason: "new", previousSessionFile });
			assert.equal((await runtime.emitToolCall(call))?.block, true, "Adoption requires fresh authenticated binding");
			const adopted = await request("session.adopt", { sessionId: session.sessionId });
			assert(adopted.type === "response" && adopted.ok);
		}
		answer(frame, isError);
		const stale: AgentToolResult<unknown> = await pending;
		assert.equal(stale.isError, true);
		assert.deepEqual(stale.details, {}, "Stale provider metadata is discarded with content");
		assert(!JSON.stringify(stale).includes("bounded provider content"));
		assert(!JSON.stringify(stale).includes("bounded backend snapshot"));
		assert(!JSON.stringify(stale).includes("permission denied by forge backend"), "Stale error diagnostics cannot leak after ownership changes");
	}
	const fresh = tool.execute("forge-fresh-adoption", input); answer(await nextFrame());
	assert.deepEqual(await fresh, { content, details });
	await session.refreshRpcHostTools([]);
	bridge.close("Disposable smoke complete");
	console.log("OFFICIAL FORGE RUNTIME OK: session-v2 main/child/advisor read admission with runtime attribution, lossless decimal IDs, unchanged bounded content, current backend denial, native cancellation, unattributed/absent SDK/foreign/forged arguments denied, unrelated secondary hello/disconnect preserve owning reads, stale tree/reconnect/adoption RPC success and error text discarded");
}

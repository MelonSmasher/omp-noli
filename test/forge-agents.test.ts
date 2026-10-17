import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type { RpcHostToolCallRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { installThreadControl } from "../src/thread-control";
import { bindForgeRoot, installForgeRelay, releaseForgeRoot } from "../src/forge-relay";
import { forgeWriteArguments } from "../src/forge-write-tools";

const FORGE_TOOLS = ["noli_forge_resource", "noli_forge_read_v1", "noli_forge_status", "noli_forge_write_v1", "noli_forge_write_status_v1"];
const read = { action: "read", read: { resource: "release_files", request: {} } };

function root(dir: string) {
	let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let prompt!: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined;
	const pi = {
		on(name: string, handler: unknown) {
			if (name === "tool_call") call = handler as typeof call;
			if (name === "before_agent_start") prompt = handler as typeof prompt;
		},
		getAllTools: () => FORGE_TOOLS.map(name => ({ name, sourceInfo: { source: "sdk" } })),
	} as unknown as ExtensionAPI;
	installThreadControl(pi, id => id === "root-session" ? 1 : undefined, dir);
	const ctx = (kind: "main" | "sub", id = kind === "main" ? "Main" : "0-Explore") =>
		({ agent: { kind, id }, sessionManager: { getSessionId: () => "root-session" } }) as unknown as ExtensionContext;
	return { call: (toolName: string, input: Record<string, unknown>, context: ExtensionContext) => call({ type: "tool_call", toolName, toolCallId: "c", input }, context), prompt, ctx };
}

const sha = (lines: string[]) => createHash("sha256").update(JSON.stringify(lines)).digest("hex");

describe("#236 forge context in the prompt", () => {
	test("the prefix hash stays stable across task-state updates and changes with the binding", () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const block = "Noli forge binding for this thread (rewritten only when its repository, account or sign-in state changes):\n- Repository: GitLab `group/project` at https://git.example.test.\n- Acting account: `builder`, signed in.";
		writeFileSync(join(dir, "forge-context.json"), JSON.stringify({ block }));
		const h = root(dir);
		const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "work", systemPrompt: ["base"] };
		const turn = () => h.prompt(event, h.ctx("main"))!;
		writeFileSync(join(dir, "forge-task.json"), JSON.stringify({ task: "Noli task state: attempt a is seeding." }));
		const first = turn();
		expect(first.systemPrompt).toContain(block);
		expect(first.message).toMatchObject({ content: "Noli task state: attempt a is seeding." });
		const prefix = sha(first.systemPrompt!);
		// Unchanged task state adds nothing; changed task state is a new tail message, never prefix bytes.
		const second = turn();
		expect(sha(second.systemPrompt!)).toBe(prefix);
		expect(second.message).toBeUndefined();
		writeFileSync(join(dir, "forge-task.json"), JSON.stringify({ task: "Noli task state: attempt a is active. Watching: CI (failed)." }));
		const third = turn();
		expect(sha(third.systemPrompt!)).toBe(prefix);
		expect(third.message).toMatchObject({ customType: "noli-forge-task", display: false });
		// Re-running on the previous request's prompt replaces the block instead of stacking it.
		expect(sha(h.prompt({ ...event, systemPrompt: third.systemPrompt! }, h.ctx("main"))!.systemPrompt!)).toBe(prefix);
		// An account change rewrites the block.
		writeFileSync(join(dir, "forge-context.json"), JSON.stringify({ block: block.replace("`builder`, signed in", "`builder`, revoked or signed out") }));
		const revoked = turn().systemPrompt!;
		expect(sha(revoked)).not.toBe(prefix);
		expect(revoked.filter(line => line.startsWith("Noli forge binding")).length).toBe(1);
	});
});

describe("#237/#240 callers in the root session", () => {
	test("subagents read and propose as themselves; the advisor only reads; other controls stay main-only", () => {
		const h = root(mkdtempSync(join(tmpdir(), "noli-forge-")));
		expect(h.call("noli_forge_status", {}, h.ctx("main"))).toEqual({ input: {} });
		expect(h.call("noli_forge_status", { thread_id: "other" }, h.ctx("main"))?.block).toBe(true);
		expect(h.call("noli_forge_read_v1", read, h.ctx("sub"))).toEqual({ input: { ...read, noli_requester: { kind: "child", agent_id: "0-Explore" } } });
		const proposal = { payload: { kind: "issue", number: "17", mutation: { action: "comment", body: "Done" } } };
		expect(h.call("noli_forge_write_v1", proposal, h.ctx("sub"))).toEqual({ input: { ...proposal, noli_requester: { kind: "child", agent_id: "0-Explore" } } });
		expect(h.call("noli_forge_status", {}, h.ctx("sub", "advisor"))).toEqual({ input: { noli_requester: { kind: "advisor" } } });
		for (const tool of ["noli_forge_write_v1", "noli_forge_write_status_v1"]) {
			expect(h.call(tool, tool === "noli_forge_write_v1" ? proposal : { operation_id: "op" }, h.ctx("sub", "advisor"))?.reason).toContain("read-only");
		}
		// A model cannot name a requester, and unattributed callers get nothing.
		expect(h.call("noli_forge_read_v1", { ...read, noli_requester: { kind: "child", agent_id: "1-Other" } }, h.ctx("sub"))?.block).toBe(true);
		expect(h.call("noli_forge_read_v1", { ...read, noli_requester: { kind: "advisor" } }, h.ctx("main"))?.block).toBe(true);
		expect(h.call("noli_forge_read_v1", read, h.ctx("sub", ""))?.block).toBe(true);
		for (const tool of ["noli_thread_get", "noli_thread_finish", "noli_attach_file", "noli_thread_open"]) expect(h.call(tool, {}, h.ctx("sub"))?.block).toBe(true);
	});
	test("number and branch write forms pass the envelope guard; authority fields do not", () => {
		for (const payload of [{ kind: "issue", number: "17", mutation: { action: "milestone", title: "Group plan" } },
			{ kind: "create_review", title: "T", body: "B", source_branch: "topic", target_branch: "main" }, { kind: "merge", number: "12" }]) {
			expect(forgeWriteArguments({ payload }, "c")).toBe(true);
			expect(forgeWriteArguments({ payload, precondition: { kind: "ci" } }, "c")).toBe(true);
			expect(forgeWriteArguments({ payload, account: "other" }, "c")).toBe(false);
			expect(forgeWriteArguments({ payload, precondition: "ci" }, "c")).toBe(false);
		}
	});
});

describe("#240 subagent relay through the SDK's real host-tool wrapper", () => {
	/**
	 * A root session as OMP builds it: the RPC host-tool bridge's adapters, each wrapped
	 * in the SDK's ExtensionToolWrapper whose runner emits the plugin's real root hooks.
	 */
	function rootSession(sessionId: string, generation: { value: number | undefined }) {
		let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
		let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
		const pi = {
			on(name: string, handler: unknown) {
				if (name === "tool_call") call = handler as typeof call;
				if (name === "tool_result") result = handler as typeof result;
			},
			getAllTools: () => FORGE_TOOLS.map(name => ({ name, sourceInfo: { source: "sdk" } })),
		} as unknown as ExtensionAPI;
		installThreadControl(pi, id => id === sessionId ? generation.value : undefined);
		const main = { agent: { kind: "main", id: "Main" }, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
		// The root session's own settings decide tool approval, exactly as for the main agent.
		const runner = {
			sessionSettings: Settings.isolated({ "tools.approvalMode": "yolo", "memory.backend": "off" }),
			hasHandlers: (name: string) => name === "tool_call" || name === "tool_result",
			consumeToolCallEmitted: () => false,
			sessionId,
			runScoped: <T>(run: () => T) => run(),
			emitToolCall: async (event: ToolCallEvent) => call(event, main),
			emitToolResult: async (event: ToolResultEvent) => result(event, main),
		};
		const frames: RpcHostToolCallRequest[] = [];
		const bridge = new RpcHostToolBridge(frame => {
			if (frame.type !== "host_tool_call") return;
			frames.push(frame);
			const details = frame.toolName === "noli_forge_write_v1" ? { status: "pending_approval", operation_id: "op" } : undefined;
			queueMicrotask(() => bridge.handleResult({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text: "{}" }], details } }));
		});
		const wrapped = new Map(bridge.setTools(FORGE_TOOLS.map(name => ({ name, label: name, description: name, parameters: { type: "object" } })))
			.map(tool => [tool.name, new ExtensionToolWrapper(tool, runner as never)]));
		return { frames, tool: (name: string) => wrapped.get(name) as unknown as { description: string; parameters: unknown; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown): Promise<{ content: unknown[]; details?: unknown }> } | undefined, sessionId };
	}
	function child(dir: string) {
		const tools = new Map<string, { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> }>();
		installForgeRelay({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never), on() {} } as unknown as ExtensionAPI, dir);
		const as = (id: string) => ({ agent: { kind: "sub", id }, sessionManager: { getSessionId: () => `child-${id}` } }) as unknown as ExtensionContext;
		return { tools, run: (name: string, params: unknown, id = "0-Explore") => tools.get(name)!.execute(`model-${name}`, params, undefined, undefined, as(id)) };
	}
	const bind = (dir: string, parent: ReturnType<typeof rootSession>, generation: { value: number | undefined }) =>
		bindForgeRoot({ dir, sessionId: parent.sessionId, generation: id => id === parent.sessionId ? generation.value : undefined, tool: parent.tool });

	test("relayed calls pass the root guard and reach the RPC transport with the child's identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		expect([...c.tools.keys()].sort()).toEqual([...FORGE_TOOLS].sort());
		await c.run("noli_forge_status", {});
		await c.run("noli_forge_read_v1", read);
		await c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "12" } });
		const child0 = { kind: "child", agent_id: "0-Explore" };
		expect(parent.frames.map(frame => [frame.toolName, frame.arguments])).toEqual([
			["noli_forge_status", { noli_requester: child0 }],
			["noli_forge_read_v1", { ...read, noli_requester: child0 }],
			["noli_forge_write_v1", { payload: { kind: "merge", number: "12" }, noli_requester: child0 }],
		]);
		// The relay ID is consumed; a model cannot reuse it or set the requester itself.
		await expect(c.run("noli_forge_read_v1", { ...read, noli_requester: { kind: "child", agent_id: "1-Other" } })).rejects.toThrow("Invalid");
		await expect(c.run("noli_forge_status", { session: "other" })).rejects.toThrow("Invalid");
		await expect(c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "1" } }, "advisor")).rejects.toThrow("read-only");
		await expect(parent.tool("noli_forge_status")!.execute("model-call", { noli_requester: child0 })).rejects.toThrow();
		expect(parent.frames.length).toBe(3);
		releaseForgeRoot(dir);
	});

	test("a same-directory replacement parent never inherits an existing child's relay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const old = rootSession("old-parent", generation);
		bind(dir, old, generation);
		const c = child(dir);
		await c.run("noli_forge_status", {});
		const replacement = rootSession("replacement-parent", generation);
		bind(dir, replacement, generation);
		await expect(c.run("noli_forge_status", {})).rejects.toThrow("ended with the parent session");
		await expect(c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "12" } })).rejects.toThrow("ended with the parent session");
		expect(replacement.frames).toEqual([]);
		expect(old.frames.length).toBe(1);
		// A child started under the replacement gets the replacement's tools.
		await child(dir).run("noli_forge_status", {});
		expect(replacement.frames.length).toBe(1);
		releaseForgeRoot(dir);
	});

	test("revoked parent authentication ends every child grant, and late results are discarded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		generation.value = undefined;
		await expect(c.run("noli_forge_status", {})).rejects.toThrow("unavailable");
		generation.value = 2;
		const late = c.run("noli_forge_status", {});
		generation.value = 3;
		await expect(late).rejects.toThrow();
		releaseForgeRoot(dir);
		await expect(c.run("noli_forge_status", {})).rejects.toThrow("ended with the parent session");
		expect(parent.frames.length).toBeLessThanOrEqual(1);
	});

	test("another launch's subagents get no tools", () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 };
		bind(dir, rootSession("root-session", generation), generation);
		expect(child(join(dir, "other")).tools.size).toBe(0);
		releaseForgeRoot(dir);
	});
});

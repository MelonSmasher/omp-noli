import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type { RpcHostToolCallRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { FORGE_CLI_INSTRUCTION, installThreadControl } from "../src/thread-control";
import { bindForgeRoot, installForgeRelay, releaseForgeRoot } from "../src/forge-relay";
import { forgeWriteArguments } from "../src/forge-write-tools";
import { taskReminder } from "../src/forge-agents";
import { forgeReadArguments } from "../src/forge-read-tools";

const FORGE_TOOLS = ["noli_model_roles", "noli_forge_resource", "noli_forge_read_v1", "noli_forge_status", "noli_forge_write_v1", "noli_forge_write_status_v1"];
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
		const event: BeforeAgentStartEvent = { type: "before_agent_start", reason: "prompt", prompt: "work", systemPrompt: ["base"] };
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
	for (const clear of ["removed", "empty"] as const) {
		test(`${clear} task state clears the prior tail reminder once without changing the prefix`, () => {
			const dir = mkdtempSync(join(tmpdir(), "noli-forge-task-clear-"));
			try {
				const h = root(dir);
				const event: BeforeAgentStartEvent = { type: "before_agent_start", reason: "prompt", prompt: "work", systemPrompt: ["base"] };
				const turn = () => h.prompt(event, h.ctx("main"))!;
				const initial = turn();
				expect(initial.message).toBeUndefined();
				const task = "Noli task state: attempt a is active.";
				const file = join(dir, "forge-task.json");
				writeFileSync(file, JSON.stringify({ task }));
				expect(turn().message).toMatchObject({ content: task });
				if (clear === "removed") rmSync(file);
				else writeFileSync(file, JSON.stringify({ task: "" }));
				const cleared = turn();
				expect(cleared.message).toEqual({ customType: "noli-forge-task", content: "Noli task state: cleared. Disregard earlier task-state reminders.", display: false });
				expect(sha(cleared.systemPrompt!)).toBe(sha(initial.systemPrompt!));
				expect(turn().message).toBeUndefined();
				writeFileSync(file, JSON.stringify({ task }));
				expect(turn().message).toMatchObject({ content: task });
				expect(turn().message).toBeUndefined();
			} finally { rmSync(dir, { recursive: true, force: true }); }
		});
	}
	test("clearing task state is tracked independently for each session", () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-task-sessions-"));
		try {
			const delivered = new Map<string, string>();
			const file = join(dir, "forge-task.json");
			writeFileSync(file, JSON.stringify({ task: "Task active." }));
			for (const id of ["root", "child"]) expect(taskReminder(delivered, id, dir)?.content).toBe("Task active.");
			rmSync(file);
			expect(taskReminder(delivered, "new-session", dir)).toBeUndefined();
			for (const id of ["root", "child"]) {
				expect(taskReminder(delivered, id, dir)?.content).toContain("Disregard earlier task-state reminders.");
				expect(taskReminder(delivered, id, dir)).toBeUndefined();
			}
		} finally { rmSync(dir, { recursive: true, force: true }); }
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
		// While held, Noli's replies wait so a call stays in flight.
		const pending: (() => void)[] = [];
		let hold = false;
		const bridge = new RpcHostToolBridge(frame => {
			if (frame.type !== "host_tool_call") return;
			frames.push(frame);
			const details = frame.toolName === "noli_forge_write_v1" ? { status: "pending_approval", operation_id: "op" } : undefined;
			const reply = () => bridge.handleResult({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text: "{}" }], details } });
			if (hold) pending.push(reply); else queueMicrotask(reply);
		});
		const wrapped = new Map(bridge.setTools(FORGE_TOOLS.map(name => ({ name, label: name, description: name, parameters: { type: "object" } })))
			.map(tool => [tool.name, new ExtensionToolWrapper(tool, runner as never)]));
		return { frames, hold: (value: boolean) => { hold = value; }, release: () => { for (const reply of pending.splice(0)) reply(); }, tool: (name: string) => wrapped.get(name) as unknown as { description: string; parameters: unknown; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown): Promise<{ content: unknown[]; details?: unknown }> } | undefined, sessionId };
	}
	function child(dir: string) {
		const tools = new Map<string, { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> }>();
		let prompt: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined) | undefined;
		installForgeRelay({
			registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
			on(name: string, handler: unknown) { if (name === "before_agent_start") prompt = handler as typeof prompt; },
		} as unknown as ExtensionAPI, dir);
		const as = (id: string, name: string) => ({ agent: { kind: "sub", id, name }, sessionManager: { getSessionId: () => `child-${id}` } }) as unknown as ExtensionContext;
		return { tools,
			run: (name: string, params: unknown, id = "0-Explore", callId = `model-${name}`, agent = "task") => tools.get(name)!.execute(callId, params, undefined, undefined, as(id, agent)),
			/** OMP's before_agent_start: the first context that names the child's definition. */
			prompt: (systemPrompt = ["base"], id = "0-Explore", agent = "task") => {
				const event: BeforeAgentStartEvent = { type: "before_agent_start", reason: "prompt", prompt: "work", systemPrompt };
				return prompt?.(event, as(id, agent)) ?? { systemPrompt };
			},
		};
	}
	const bind = (dir: string, parent: ReturnType<typeof rootSession>, generation: { value: number | undefined }) =>
		bindForgeRoot({ dir, sessionId: parent.sessionId, generation: id => id === parent.sessionId ? generation.value : undefined, tool: parent.tool });

	test("relayed calls pass the root guard and reach the RPC transport with the child's identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		expect(c.tools.has("noli_forge_watch")).toBe(false);
		// Proposals wait for the child's definition name.
		expect([...c.tools.keys()].sort()).toEqual(FORGE_TOOLS.filter(name => !name.startsWith("noli_forge_write")).sort());
		c.prompt();
		expect([...c.tools.keys()].sort()).toEqual([...FORGE_TOOLS].sort());
		await c.run("noli_model_roles", {});
		await c.run("noli_model_roles", {}, "advisor");
		await c.run("noli_forge_status", {});
		await c.run("noli_forge_read_v1", read);
		await c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "12" } });
		const child0 = { kind: "child", agent_id: "0-Explore" };
		expect(parent.frames.map(frame => [frame.toolName, frame.arguments])).toEqual([
			["noli_model_roles", { noli_requester: child0 }],
			["noli_model_roles", { noli_requester: { kind: "advisor" } }],
			["noli_forge_status", { noli_requester: child0 }],
			["noli_forge_read_v1", { ...read, noli_requester: child0 }],
			["noli_forge_write_v1", { payload: { kind: "merge", number: "12" }, noli_requester: child0 }],
		]);
		// The relay ID is consumed; a model cannot reuse it or set the requester itself.
		await expect(c.run("noli_forge_read_v1", { ...read, noli_requester: { kind: "child", agent_id: "1-Other" } })).rejects.toThrow("Unexpected forge read field: \"noli_requester\"");
		await expect(c.run("noli_forge_status", { session: "other" })).rejects.toThrow("Invalid");
		await expect(c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "1" } }, "advisor")).rejects.toThrow("read-only");
		await expect(parent.tool("noli_forge_status")!.execute("model-call", { noli_requester: child0 })).rejects.toThrow();
		expect(parent.frames.length).toBe(5);
		releaseForgeRoot(dir);
	});

	test("a relay ID is single-use: replaying it while the call is in flight is rejected and the original completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		parent.hold(true);
		const original = c.run("noli_forge_read_v1", read);
		for (let i = 0; i < 10 && parent.frames.length === 0; i++) await Bun.sleep(1);
		expect(parent.frames.length).toBe(1);
		const relayId = parent.frames[0]!.toolCallId;
		expect(relayId.startsWith("noli-relay:")).toBe(true);
		const changed = { action: "read", read: { resource: "issues", request: {} } };
		for (const args of [changed, read]) {
			await expect(parent.tool("noli_forge_read_v1")!.execute(relayId, args)).rejects.toThrow("restricted to the owning session's main agent");
		}
		// An unknown relay-shaped ID is not attributed to the main agent either.
		await expect(parent.tool("noli_forge_status")!.execute("noli-relay:forged", {})).rejects.toThrow();
		expect(parent.frames.length).toBe(1);
		parent.release();
		parent.hold(false);
		const result = await original as { content: { text: string }[] };
		expect(result.content[0]!.text).toBe("{}");
		expect(parent.frames[0]!.arguments).toEqual({ ...read, noli_requester: { kind: "child", agent_id: "0-Explore" } });
		releaseForgeRoot(dir);
	});

	test("a same-directory replacement parent never inherits an existing child's relay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const old = rootSession("old-parent", generation);
		bind(dir, old, generation);
		const c = child(dir);
		c.prompt();
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

	test("Noli's read-only reviewers are never offered forge proposals and cannot run them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		for (const agent of ["noli-reviewer", "noli-council-1", "noli-council-2", "noli-council-3"]) {
			const c = child(dir);
			c.prompt(["base"], "1-Review", agent);
			expect([...c.tools.keys()].sort()).toEqual(FORGE_TOOLS.filter(name => !name.startsWith("noli_forge_write")).sort());
			await c.run("noli_forge_status", {}, "1-Review", undefined, agent);
		}
		// A general child gets proposals once named; a reviewer identity still cannot run one.
		const c = child(dir);
		c.prompt();
		expect(c.tools.has("noli_forge_write_v1")).toBe(true);
		await expect(c.run("noli_forge_write_v1", { payload: { kind: "merge", number: "12" } }, "1-Review", undefined, "noli-reviewer")).rejects.toThrow("read-only review agents");
		expect(parent.frames.map(frame => frame.toolName)).toEqual(Array(4).fill("noli_forge_status"));
		releaseForgeRoot(dir);
	});

	test("binding blocks are replaced or removed, and revoked authentication removes relay guidance", () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 as number | undefined };
		bind(dir, rootSession("root-session", generation), generation);
		const c = child(dir);
		const path = join(dir, "forge-context.json");
		const first = "Noli forge binding for this thread:\n- Repository: first/repo.";
		const changed = "Noli forge binding for this thread:\n- Repository: second/repo.";
		writeFileSync(path, JSON.stringify({ block: first }));
		const initial = c.prompt().systemPrompt!;
		expect(initial).toEqual(["base", FORGE_CLI_INSTRUCTION, first]);
		writeFileSync(path, JSON.stringify({ block: changed }));
		const updated = c.prompt(initial).systemPrompt!;
		expect(updated).toEqual(["base", FORGE_CLI_INSTRUCTION, changed]);
		expect(c.prompt(updated).systemPrompt).toEqual(updated);
		unlinkSync(path);
		expect(c.prompt(updated).systemPrompt).toEqual(["base", FORGE_CLI_INSTRUCTION]);
		writeFileSync(path, JSON.stringify({ block: changed }));
		writeFileSync(join(dir, "forge-task.json"), JSON.stringify({ task: "Noli task state: private work." }));
		generation.value = undefined;
		expect(c.prompt(updated)).toEqual({ systemPrompt: ["base"] });
		generation.value = 2;
		expect(c.prompt(["base"]).systemPrompt).toEqual(updated);
		releaseForgeRoot(dir);
		expect(c.prompt(updated)).toEqual({ systemPrompt: ["base"] });
	});

	test("a replacement parent removes existing guidance without adopting its binding", () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 };
		const first = "Noli forge binding for this thread:\n- Repository: first/repo.";
		writeFileSync(join(dir, "forge-context.json"), JSON.stringify({ block: first }));
		bind(dir, rootSession("old-parent", generation), generation);
		const c = child(dir);
		const initial = c.prompt().systemPrompt!;
		bind(dir, rootSession("replacement-parent", generation), generation);
		writeFileSync(join(dir, "forge-context.json"), JSON.stringify({ block: first.replace("first", "replacement") }));
		expect(c.prompt(initial)).toEqual({ systemPrompt: ["base"] });
		releaseForgeRoot(dir);
	});

	test("missing root tools register before a later turn only for the original parent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 };
		const parent = rootSession("root-session", generation);
		const available = new Set<string>();
		bindForgeRoot({ dir, sessionId: parent.sessionId, generation: () => generation.value,
			tool: name => available.has(name) ? parent.tool(name) : undefined });
		const c = child(dir);
		const task = "Noli task state: initial work.";
		writeFileSync(join(dir, "forge-task.json"), JSON.stringify({ task }));
		expect(c.tools.size).toBe(0);
		expect(c.prompt()).toEqual({ systemPrompt: ["base"] });
		available.add("noli_forge_status");
		const discarded = c.prompt();
		expect(discarded.systemPrompt).toEqual(["base", FORGE_CLI_INSTRUCTION]);
		expect(discarded.message).toBeUndefined();
		// The SDK discards the registering preparation and retries with its new base.
		const retained = c.prompt(discarded.systemPrompt);
		expect(retained.message).toMatchObject({ customType: "noli-forge-task", content: task });
		expect(c.prompt(retained.systemPrompt).message).toBeUndefined();
		expect([...c.tools.keys()]).toEqual(["noli_forge_status"]);
		await c.run("noli_forge_status", {});
		available.add("noli_forge_read_v1");
		const changed = "Noli task state: changed work.";
		writeFileSync(join(dir, "forge-task.json"), JSON.stringify({ task: changed }));
		expect(c.prompt().message).toBeUndefined();
		expect(c.prompt().message).toMatchObject({ customType: "noli-forge-task", content: changed });
		expect(c.prompt().message).toBeUndefined();
		expect([...c.tools.keys()]).toEqual(["noli_forge_status", "noli_forge_read_v1"]);
		await c.run("noli_forge_read_v1", read);
		available.clear();
		expect(c.prompt(["base", FORGE_CLI_INSTRUCTION])).toEqual({ systemPrompt: ["base"] });
		await expect(c.run("noli_forge_status", {})).rejects.toThrow("unavailable");
		bind(dir, rootSession("replacement-parent", generation), generation);
		c.prompt();
		expect(c.tools.size).toBe(2);
		await expect(c.run("noli_forge_status", {})).rejects.toThrow("ended with the parent session");
		expect(parent.frames.length).toBe(2);
		releaseForgeRoot(dir);
	});

	test("write validation measures the minted relay ID rather than the model call ID", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		c.prompt();
		const proposal = { payload: { kind: "merge", number: "12" } };
		await c.run("noli_forge_write_v1", proposal, "0-Explore", "m".repeat(MAX_RPC_REASSEMBLED_BYTES));
		expect(parent.frames.length).toBe(1);
		expect(parent.frames[0]!.toolCallId).toMatch(/^noli-relay:[0-9a-f-]{36}$/);
		releaseForgeRoot(dir);
	});

	test("relay read admission reserves the forwarded requester before reaching the root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "noli-forge-"));
		const generation = { value: 1 };
		const parent = rootSession("root-session", generation);
		bind(dir, parent, generation);
		const c = child(dir);
		const input = { action: "read", read: { resource: "issues", request: { search: "" } } };
		const overhead = Buffer.byteLength(JSON.stringify({ ...input, noli_requester: { kind: "child", agent_id: "0-Explore" } }), "utf8");
		input.read.request.search = "x".repeat(65536 - overhead + 1);
		expect(forgeReadArguments(input)).toBe(true);
		await expect(c.run("noli_forge_read_v1", input)).rejects.toThrow("Invalid forge read transport shape");
		expect(parent.frames).toEqual([]);
		input.read.request.search = input.read.request.search.slice(1);
		await c.run("noli_forge_read_v1", input);
		expect(Buffer.byteLength(JSON.stringify(parent.frames[0]!.arguments), "utf8")).toBe(65536);
		releaseForgeRoot(dir);
	});

	test("read byte limits include runtime child and advisor attribution", () => {
		const h = root(mkdtempSync(join(tmpdir(), "noli-forge-")));
		const id = 'é"\\'.repeat(64);
		for (const [context, requester] of [[h.ctx("sub", id), { kind: "child", agent_id: id }],
			[h.ctx("sub", "advisor"), { kind: "advisor" }]] as const) {
			const input = { action: "read", read: { resource: "issues", request: { search: "" } } };
			const overhead = Buffer.byteLength(JSON.stringify({ ...input, noli_requester: requester }), "utf8");
			input.read.request.search = "x".repeat(65536 - overhead);
			const allowed = h.call("noli_forge_read_v1", input, context);
			expect(allowed?.block).not.toBe(true);
			expect(Buffer.byteLength(JSON.stringify(allowed!.input), "utf8")).toBe(65536);
			input.read.request.search += "x";
			expect(forgeReadArguments(input)).toBe(true);
			expect(h.call("noli_forge_read_v1", input, context)?.block).toBe(true);
			expect(h.call("noli_forge_read_v1", input, h.ctx("main"))?.block).not.toBe(true);
		}
	});

	test("write envelope limits include runtime attribution without lowering the main agent limit", () => {
		const h = root(mkdtempSync(join(tmpdir(), "noli-forge-")));
		const id = 'é"\\'.repeat(64);
		const requester = { kind: "child", agent_id: id };
		const input = { payload: { kind: "issue", number: "17", mutation: { action: "comment", body: "" } } };
		const envelope = { type: "host_tool_call", id: "0000000000000000", toolCallId: "c", toolName: "noli_forge_write_v1", arguments: { ...input, noli_requester: requester } };
		const overhead = Buffer.byteLength(JSON.stringify(envelope), "utf8");
		input.payload.mutation.body = "x".repeat(MAX_RPC_REASSEMBLED_BYTES - overhead);
		expect(h.call("noli_forge_write_v1", input, h.ctx("sub", id))?.block).not.toBe(true);
		input.payload.mutation.body += "x";
		expect(h.call("noli_forge_write_v1", input, h.ctx("sub", id))?.block).toBe(true);
		expect(h.call("noli_forge_write_v1", input, h.ctx("main"))?.block).not.toBe(true);
	});
});

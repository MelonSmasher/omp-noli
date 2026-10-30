import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, type ContextEvent, type ExtensionAgentIdentity, type ExtensionAPI, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { streamSimple, type Model } from "@oh-my-pi/pi-ai";
import { render } from "@oh-my-pi/pi-utils/prompt";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EXTENSION_HANDLER_TIMEOUT_MS, ExtensionRunner, testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ProducerChannel } from "../src/bridge";
import { epochEntryId, prevToolDurations, wireToolName } from "../src/claude-facts";
import { COMPACTION_HANDLER_BUDGET_MS, type HandlerBudget, bindProducerChannel, installClaudeHooks, releaseProducerChannel, runnerHandlerBudget } from "../src/claude-hooks";
import { registerGateway } from "../src/gateway";
import type { ProducerBranchParams, ProducerCompactionParams, ProducerSessionParams, RequestFacts } from "../src/protocol";
import { SIDE_CHANNEL_REMINDERS, SYSTEM_PREFIXES } from "../src/system-prefix.generated";

// Real stock ExtensionRunner and provider stream; synthetic sessions, gateway and bridge. No live provider or Claude Code process.
type AgentMessage = ContextEvent["messages"][number];
type RunnerEvent = Parameters<ExtensionRunner["emit"]>[0];
const sdk = join(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent");
const reference = (letter: string) => letter.repeat(43);
let dir = "";
let auth: AuthStorage;
let registry: ModelRegistry;
let gatewayModel: Model;
let server: { port: number | undefined; stop(closeActiveConnections?: boolean): void };
const received: Array<{ body: string; headers: Headers }> = [];

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "noli-hooks-"));
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push({ body: await request.text(), headers: request.headers });
		return Response.json({ type: "error", error: { type: "invalid_request_error", message: "synthetic non-retryable fixture response" } }, { status: 400 });
	} });
	const model = { id: "gateway-claude", name: "Claude", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
	writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: { "noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", models: [model] } } }));
	auth = await AuthStorage.create(join(dir, "agent.db"));
	registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	registerGateway({ registerProvider: (name: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) => registry.registerProvider(name, config, "hooks") } as ExtensionAPI, dir);
	gatewayModel = registry.find("noli-anthropic", model.id)!;
});

afterAll(() => {
	server.stop(true);
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
	releaseProducerChannel(dir);
});

function recorder(register: () => Promise<string> = async () => reference("r")) {
	const calls = { sessions: [] as ProducerSessionParams[], branches: [] as ProducerBranchParams[], registered: [] as Array<{ ompSessionId: string; facts: RequestFacts }>, compactions: [] as ProducerCompactionParams[], forgotten: [] as string[] };
	const producer: ProducerChannel = {
		announce: params => { calls.sessions.push(params); },
		branch: async params => { calls.branches.push(params); },
		forget: id => { calls.forgotten.push(id); },
		register: async (ompSessionId, facts) => { calls.registered.push({ ompSessionId, facts }); return register(); },
		compaction: async params => { calls.compactions.push(params); },
	};
	return { calls, producer, set register(next: () => Promise<string>) { register = next; } };
}

async function runnerFor(factories: ExtensionFactory[], sessionManager: SessionManager, agent?: ExtensionAgentIdentity): Promise<ExtensionRunner> {
	const runtime = new ExtensionRuntime();
	const bus = new EventBus();
	const extensions = [];
	for (const [index, factory] of factories.entries()) extensions.push(await loadExtensionFromFactory(factory, dir, bus, runtime, `synthetic-${index}`));
	const runner = new ExtensionRunner(extensions, runtime, dir, sessionManager, registry, undefined, undefined, undefined, undefined, agent);
	runner.initialize({
		sendMessage() {}, sendUserMessage() {}, appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); }, setLabel() {},
		getActiveTools: () => [], getAllTools: () => [], setActiveTools: async () => {}, getCommands: () => [], setModel: async () => false,
		getThinkingLevel: () => undefined, setThinkingLevel() {}, getSessionName: () => undefined, setSessionName: async () => {},
	}, {
		getModel: () => gatewayModel, isIdle: () => true, abort() {}, hasPendingMessages: () => false, shutdown() {},
		getContextUsage: () => undefined, compact: async () => {}, getSystemPrompt: () => [],
	});
	return runner;
}

const hooks: ExtensionFactory = pi => installClaudeHooks(pi, dir, { toolResults: true });
const childHooks: ExtensionFactory = pi => installClaudeHooks(pi, dir, { toolResults: false });
const prompt = (text: string, timestamp: number) => ({ role: "user", content: text, attribution: "user", timestamp }) as AgentMessage;
const payload = () => ({ model: "gateway-claude", max_tokens: 64, messages: [{ role: "user", content: "synthetic" }] });

test("the generated table pins this SDK's system prefix and side-turn reminder", () => {
	const template = readFileSync(join(sdk, "src/prompts/system/system-prompt.md"), "utf8");
	const prefix = render(template.slice(0, template.lastIndexOf("\n", template.indexOf("{{")))).trimEnd();
	expect(SYSTEM_PREFIXES[VERSION]).toEqual({ sha256: new Bun.CryptoHasher("sha256").update(prefix).digest("hex"), len: Buffer.byteLength(prefix) });
	const reminder = readFileSync(join(sdk, "src/prompts/system/side-channel-no-tools.md"), "utf8");
	expect(SIDE_CHANNEL_REMINDERS[VERSION]).toEqual({ sha256: new Bun.CryptoHasher("sha256").update(reminder).digest("hex"), len: Buffer.byteLength(reminder) });
});

test("root: the synchronous tag survives a throwing handler before it and a timed-out handler after it", async () => {
	testSetExtensionHandlerTimeoutMs(50);
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const throwing: ExtensionFactory = pi => pi.on("before_provider_request", async () => { throw new Error("synthetic handler failure"); });
	const hanging: ExtensionFactory = pi => pi.on("before_provider_request", () => new Promise(() => {}));
	const runner = await runnerFor([throwing, hooks, hanging], sessionManager);
	await runner.emit({ type: "session_start" });
	const ompSessionId = sessionManager.getSessionId();
	expect(channel.calls.sessions).toEqual([{
		ompSessionId, parentOmpSessionId: null, agentKind: "main", agentId: "Main",
		epochEntryId: epochEntryId(sessionManager.getBranch()), ompVersion: VERSION, systemPrefix: SYSTEM_PREFIXES[VERSION]!,
	}]);
	expect(channel.calls.sessions[0]!.epochEntryId).not.toBeNull();
	expect(channel.calls.branches).toEqual([{ ompSessionId, leafId: sessionManager.getLeafId(), resetEntryIds: [] }]);
	await runner.emitContext([prompt("first synthetic prompt", 1)]);
	expect(channel.calls.registered).toHaveLength(1);
	expect(channel.calls.registered[0]).toMatchObject({ ompSessionId, facts: { producerSessionId: ompSessionId, requestClass: "main", querySource: "agent", prompt: { origin: "human", position: { promptIndex: 1, turnIndex: 1 } }, firstEligible: { sample: "typ" } } });
	const tagged = await runner.emitBeforeProviderRequest(payload(), gatewayModel);
	expect(tagged).toEqual({ ...payload(), noli_request: { session: ompSessionId, ref: reference("r"), warm: false } });
});

test("root: a failed registration tags the main call with a null reference", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder(async () => { throw new Error("synthetic registration rejection"); });
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const runner = await runnerFor([hooks], sessionManager);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("synthetic", 1)]);
	expect(channel.calls.registered).toHaveLength(1);
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: null, warm: false } });
});

test("root: side turns never register, warm replays carry no reference, and other providers are untouched", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const runner = await runnerFor([hooks], sessionManager);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("main", 1)]);
	const reminder = readFileSync(join(sdk, "src/prompts/system/side-channel-no-tools.md"), "utf8");
	await runner.emitContext([prompt("main", 1), { role: "developer", content: [{ type: "text", text: reminder }], attribution: "agent", timestamp: 2 } as AgentMessage, { role: "user", content: [{ type: "text", text: "side question" }], attribution: "agent", timestamp: 3 } as AgentMessage]);
	expect(channel.calls.registered).toHaveLength(1);
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: reference("r"), warm: false } });
	expect(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 0, missCost: 1, continuationProbability: 1, action: "warm" })).toBe("warm");
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: null, warm: true } });
	await runner.emitContext([prompt("main", 1), prompt("next", 4)]);
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: reference("r"), warm: false } });
	const other = { ...gatewayModel, provider: "anthropic" } as Model;
	expect(await runner.emitBeforeProviderRequest(payload(), other)).toEqual(payload());
});

test("root: native compaction cancels proactive passes and fails closed without the lifted budget, logging each reason", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const logged: Array<[string, string, unknown]> = [];
	const spy = { debug: (message: string, data?: unknown) => { logged.push(["debug", message, data]); }, warn: (message: string, data?: unknown) => { logged.push(["warn", message, data]); } };
	const loggingHooks: ExtensionFactory = pi => installClaudeHooks(Object.create(pi, { logger: { value: spy } }) as ExtensionAPI, dir, { toolResults: true });
	const runner = await runnerFor([loggingHooks], sessionManager);
	// Registering it also turns stock speculative compaction off.
	expect(runner.hasHandlers("session_before_compact")).toBe(true);
	await runner.emit({ type: "session_start" });
	sessionManager.appendMessage(prompt("summarized", 1) as Parameters<SessionManager["appendMessage"]>[0]);
	const before = { type: "session_before_compact", preparation: { tokensBefore: 1 }, branchEntries: [], customInstructions: undefined, signal: new AbortController().signal } as unknown as RunnerEvent;
	// Claude Code never compacts proactively: threshold and idle passes are cancelled.
	for (const reason of ["threshold", "idle"]) {
		await runner.emit({ type: "auto_compaction_start", reason, action: "context-full" } as unknown as RunnerEvent);
		expect(await runner.emit(before)).toEqual({ cancel: true });
	}
	// Outside the managed source launch there is no live runner to lift: fail closed, no stock summary.
	expect(await runner.emit(before)).toEqual({ cancel: true });
	expect(channel.calls.compactions).toHaveLength(0);
	// No cancel is silent: each one leaves its reason in the OMP log.
	expect(logged).toEqual([
		["debug", "Native compaction declined: Claude Code compacts only on prompt-too-long or /compact", { reason: "threshold", agent: "main" }],
		["debug", "Native compaction declined: Claude Code compacts only on prompt-too-long or /compact", { reason: "idle", agent: "main" }],
		["warn", "Native compaction unavailable: the handler budget or side turns cannot be used", undefined],
	]);
});

test("the handler budget is lifted only for the live runner module and restored by the last holder", () => {
	const runnerModule = { ExtensionRunner, EXTENSION_HANDLER_TIMEOUT_MS, testSetExtensionHandlerTimeoutMs: (value: number) => { calls.push(value); } };
	const calls: number[] = [];
	const live = {} as ExtensionRunner;
	Object.setPrototypeOf(live, ExtensionRunner.prototype);
	const budget = runnerHandlerBudget(runnerModule, ctx => (ctx as unknown as { live: boolean }).live ? live : {});
	const ctx = (value: boolean) => ({ live: value }) as unknown as Parameters<HandlerBudget["lift"]>[0];
	expect(budget.lift(ctx(false))).toBe(false);
	expect(budget.lift(ctx(true))).toBe(true);
	expect(budget.lift(ctx(true))).toBe(true);
	budget.restore();
	expect(calls).toEqual([COMPACTION_HANDLER_BUDGET_MS]);
	budget.restore();
	expect(calls).toEqual([COMPACTION_HANDLER_BUDGET_MS, EXTENSION_HANDLER_TIMEOUT_MS]);
});

test("children announce under their spawning agent's session and register subagent facts", async () => {
	const root = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => root.getSessionId());
	const rootRunner = await runnerFor([hooks], root);
	await rootRunner.emit({ type: "session_start" });
	const child = SessionManager.inMemory(dir);
	const childRunner = await runnerFor([childHooks], child, { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" });
	await childRunner.emit({ type: "session_start" });
	const grandchild = SessionManager.inMemory(dir);
	const grandchildRunner = await runnerFor([childHooks], grandchild, { kind: "sub", id: "0-Task.0-Explore", name: "explore", depth: 2, parentId: "0-Task" });
	await grandchildRunner.emit({ type: "session_start" });
	expect(channel.calls.sessions.map(session => [session.ompSessionId, session.parentOmpSessionId, session.agentKind, session.agentId])).toEqual([
		[root.getSessionId(), null, "main", "Main"],
		[child.getSessionId(), root.getSessionId(), "sub", "0-Task"],
		[grandchild.getSessionId(), child.getSessionId(), "sub", "0-Task.0-Explore"],
	]);
	await childRunner.emitContext([prompt("delegated task", 1)]);
	expect(channel.calls.registered.at(-1)).toMatchObject({ ompSessionId: child.getSessionId(), facts: { requestClass: "subagent", querySource: "task", producerAgentId: "0-Task", parentProducerSessionId: root.getSessionId() } });
	expect(await childRunner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { session: child.getSessionId(), ref: reference("r") } });
	await childRunner.emit({ type: "session_shutdown" });
	expect(channel.calls.forgotten).toEqual([child.getSessionId()]);
});

test("the tag reaches the Gateway request body through the stock Anthropic provider", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const runner = await runnerFor([hooks], sessionManager);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("synthetic prompt", 1)]);
	received.length = 0;
	const result = await streamSimple(gatewayModel, { messages: [{ role: "user", content: "synthetic prompt", timestamp: 1 }] }, {
		apiKey: "synthetic-local-key", sessionId: sessionManager.getSessionId(),
		onPayload: (body, model) => runner.emitBeforeProviderRequest(body, model),
	}).result();
	expect(result.stopReason).toBe("error");
	expect(received).toHaveLength(1);
	const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
	expect(body.noli_request).toEqual({ session: sessionManager.getSessionId(), ref: reference("r"), warm: false });
	expect([...received[0]!.headers.keys()].some(key => key.startsWith("x-noli-"))).toBe(false);
});

describe("previous tool durations through the stock runner", () => {
	const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
	const batch = (...calls: ReturnType<typeof call>[]) => ({ role: "assistant", content: calls, api: "anthropic-messages", provider: "noli-anthropic", model: "gateway-claude", responseId: "msg_batch", stopReason: "toolUse", timestamp: 2,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as unknown as AgentMessage;
	const started = (runner: ExtensionRunner, id: string, name: string) => runner.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} } as unknown as RunnerEvent);
	const ended = (runner: ExtensionRunner, id: string, name: string, isError: boolean) => runner.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: {}, isError } as unknown as RunnerEvent);
	const executed = (runner: ExtensionRunner, id: string, name: string, isError = false) =>
		runner.emitToolResult({ type: "tool_result", toolCallId: id, toolName: name, input: {}, content: [], details: undefined, isError } as unknown as Parameters<ExtensionRunner["emitToolResult"]>[0]);
	const lastFacts = (channel: ReturnType<typeof recorder>) => channel.calls.registered.at(-1)!.facts;

	test("root: executed tools (errors included) are timed; denied or unknown ones are left out; a new prompt resets", async () => {
		const sessionManager = SessionManager.inMemory(dir);
		const channel = recorder();
		bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
		const runner = await runnerFor([hooks], sessionManager);
		expect(runner.hasHandlers("tool_approval_resolved")).toBe(false);
		await runner.emit({ type: "session_start" });
		await runner.emitContext([prompt("go", 1)]);
		expect(lastFacts(channel).prevToolDurations).toBeUndefined();
		for (const [id, name] of [["t1", "read"], ["t2", "bash"], ["t3", "write"], ["t4", "no_such_tool"]] as const) await started(runner, id, name);
		await executed(runner, "t2", "bash", true);
		// Distinct end milliseconds; equal ones fall back to tool_use order.
		await Bun.sleep(5);
		await executed(runner, "t1", "read");
		await ended(runner, "t3", "write", true);
		await ended(runner, "t4", "no_such_tool", true);
		const messages = [prompt("go", 1), batch(call("t1", "read"), call("t2", "bash"), call("t3", "write"), call("t4", "no_such_tool"))];
		await runner.emitContext(messages);
		const durations = lastFacts(channel).prevToolDurations!;
		expect(durations.map(entry => entry.toolName)).toEqual(["_bash", "_read"]);
		for (const entry of durations) expect(Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0).toBe(true);
		// An auto-retry of the same request repeats the value.
		await runner.emitContext(messages);
		expect(lastFacts(channel).prevToolDurations).toEqual(durations);
		await runner.emitBeforeAgentStart("next", undefined, [], "prompt");
		await runner.emitContext([...messages, prompt("next", 3)]);
		expect(lastFacts(channel).prevToolDurations).toBeUndefined();
	});

	test("overflow compaction drops the batch; threshold compaction keeps it", async () => {
		const sessionManager = SessionManager.inMemory(dir);
		const channel = recorder();
		bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
		const runner = await runnerFor([hooks], sessionManager);
		await runner.emit({ type: "session_start" });
		await started(runner, "t1", "read");
		await executed(runner, "t1", "read");
		const messages = [prompt("go", 1), batch(call("t1", "read"))];
		await runner.emit({ type: "auto_compaction_start", reason: "threshold", action: "shake" } as unknown as RunnerEvent);
		await runner.emitContext(messages);
		expect(lastFacts(channel).prevToolDurations?.map(entry => entry.toolName)).toEqual(["_read"]);
		await runner.emit({ type: "auto_compaction_start", reason: "overflow", action: "shake" } as unknown as RunnerEvent);
		await runner.emitContext(messages);
		expect(lastFacts(channel).prevToolDurations).toBeUndefined();
	});

	test("subagents time only their own batch, and a restarted session starts without durations", async () => {
		const root = SessionManager.inMemory(dir);
		const channel = recorder();
		bindProducerChannel(dir, channel.producer, () => root.getSessionId());
		const rootRunner = await runnerFor([hooks], root);
		await rootRunner.emit({ type: "session_start" });
		const child = SessionManager.inMemory(dir);
		const childRunner = await runnerFor([childHooks], child, { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" });
		await childRunner.emit({ type: "session_start" });
		// Children add no tool_result handler, which would make stock OMP skip speculative execution.
		expect(childRunner.hasHandlers("tool_result")).toBe(false);
		await started(childRunner, "c1", "grep");
		await ended(childRunner, "c1", "grep", false);
		await started(childRunner, "c2", "bash");
		await ended(childRunner, "c2", "bash", true);
		await childRunner.emitContext([prompt("task", 1), batch(call("c1", "grep"), call("c2", "bash"))]);
		expect(lastFacts(channel)).toMatchObject({ requestClass: "subagent", prevToolDurations: [{ toolName: "_grep" }] });
		await rootRunner.emitContext([prompt("go", 1), batch(call("c1", "grep"))]);
		expect(lastFacts(channel)).toMatchObject({ requestClass: "main" });
		expect(lastFacts(channel).prevToolDurations).toBeUndefined();
		await started(rootRunner, "r1", "task");
		await executed(rootRunner, "r1", "task");
		const restarted = await runnerFor([hooks], root);
		await restarted.emit({ type: "session_start" });
		await restarted.emitContext([prompt("go", 1), batch(call("r1", "task"))]);
		expect(lastFacts(channel).prevToolDurations).toBeUndefined();
	});
});

describe("wire tool names in previous tool durations", () => {
	const names = ["read", "bash", "web_search", "mcp__server__lookup", "custom_extension_tool"];
	const tools = names.map(name => ({ name, description: `synthetic ${name}`, parameters: { type: "object", properties: {} } }));

	test("an extension-registered Anthropic Gateway model resolves isOAuth as production registration does", () => {
		// coding-agent/src/config/custom-models.ts:59-64,107: no providerAuth + anthropic-messages -> true.
		expect((gatewayModel as { isOAuth?: unknown }).isOAuth).toBe(true);
	});

	test.each([
		{ escape: false, oauth: true, expected: ["_read", "_bash", "web_search", "_mcp__server__lookup", "_custom_extension_tool"] },
		{ escape: false, oauth: false, expected: names },
		{ escape: true, oauth: false, expected: names.map(name => `_${name}`) },
		{ escape: true, oauth: true, expected: names.map(name => `_${name}`) },
	])("wireToolName equals stock OMP's real Gateway payload (escape=$escape, oauth=$oauth)", async ({ escape, oauth, expected }) => {
		const model = { ...gatewayModel, isOAuth: oauth, compat: { ...gatewayModel.compat, escapeBuiltinToolNames: escape } } as Model;
		received.length = 0;
		// A non-oat key: the key-based OAuth fallback stays false, as for the Gateway token.
		await streamSimple(model, { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools } as unknown as Parameters<typeof streamSimple>[1], { apiKey: reference("k") }).result();
		expect(received).toHaveLength(1);
		const wire = (JSON.parse(received[0]!.body) as { tools: { name: string }[] }).tools.map(tool => tool.name);
		expect(wire).toEqual([...expected]);
		expect(names.map(name => wireToolName(name, { escape, oauth }))).toEqual(wire);
	});

	test("durations report the wire name for the request's naming", () => {
		const batch = { role: "assistant", content: names.map((name, index) => ({ type: "toolCall", id: `t${index}`, name, arguments: {} })), stopReason: "toolUse", timestamp: 2 } as unknown as AgentMessage;
		const timings = new Map(names.map((_, index) => [`t${index}`, { start: 0, end: index + 1, executed: true, epoch: 0 }] as const));
		expect(prevToolDurations([batch], [], timings, 0, { escape: false, oauth: true })?.map(entry => entry.toolName)).toEqual(["_read", "_bash", "web_search", "_mcp__server__lookup", "_custom_extension_tool"]);
		expect(prevToolDurations([batch], [], timings, 0, { escape: false, oauth: false })?.map(entry => entry.toolName)).toEqual(names);
		expect(prevToolDurations([batch], [], timings, 0, { escape: true, oauth: false })?.map(entry => entry.toolName)).toEqual(names.map(name => `_${name}`));
	});
});

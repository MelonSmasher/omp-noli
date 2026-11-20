import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, type ContextEvent, type ExtensionAgentIdentity, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { streamSimple, type Model } from "@oh-my-pi/pi-ai";
import { prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import { render } from "@oh-my-pi/pi-utils/prompt";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EXTENSION_HANDLER_TIMEOUT_MS, ExtensionRunner, testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ProducerChannel } from "../src/bridge";
import { epochEntryId, prevToolDurations } from "../src/claude-facts";
import { COMPACTION_HANDLER_BUDGET_MS, type HandlerBudget, bindProducerChannel, installClaudeHooks, releaseProducerChannel, runnerHandlerBudget } from "../src/claude-hooks";
import { registerGateway } from "../src/gateway";
import type { CapabilityState, ProducerBranchParams, ProducerCompactionParams, ProducerSessionParams, RequestFacts } from "../src/protocol";
import { SIDE_CHANNEL_REMINDERS, SYSTEM_PREFIXES } from "../src/system-prefix.generated";

// Real stock ExtensionRunner and provider stream; synthetic sessions, gateway and bridge. No live provider or Claude Code process.
type AgentMessage = ContextEvent["messages"][number];
type RunnerEvent = Parameters<ExtensionRunner["emit"]>[0];
const sdk = join(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent");
const previousSdkRoot = process.env.NOLI_OMP_SDK_ROOT;
const reference = (letter: string) => letter.repeat(43);
let dir = "";
let auth: AuthStorage;
let registry: ModelRegistry;
let gatewayModel: Model;
let responsesModel: Model;
let codexResponsesModel: Model;
let server: { port: number | undefined; stop(closeActiveConnections?: boolean): void };
const received: Array<{ body: string; headers: Headers }> = [];

beforeAll(async () => {
	process.env.NOLI_OMP_SDK_ROOT = sdk;
	dir = mkdtempSync(join(tmpdir(), "noli-hooks-"));
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push({ body: await request.text(), headers: request.headers });
		return Response.json({ type: "error", error: { type: "invalid_request_error", message: "synthetic non-retryable fixture response" } }, { status: 400 });
	} });
	const model = { id: "gateway-claude", name: "Claude", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
	writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
		"noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", models: [model] },
		"noli-openai": { baseUrl: `http://127.0.0.1:${server.port}`, api: "openai-responses", models: [{ ...model, id: "gateway-codex" }] },
		"noli-codex": { baseUrl: `http://127.0.0.1:${server.port}`, api: "openai-codex-responses", models: [{ ...model, id: "gateway-codex-native" }] },
	} }));
	auth = await AuthStorage.create(join(dir, "agent.db"));
	registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	registerGateway({ registerProvider: (name: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) => registry.registerProvider(name, config, "hooks") } as ExtensionAPI, dir);
	gatewayModel = registry.find("noli-anthropic", model.id)!;
	responsesModel = registry.find("noli-openai", "gateway-codex")!;
	codexResponsesModel = registry.find("noli-codex", "gateway-codex-native")!;
});

afterAll(() => {
	if (previousSdkRoot === undefined) delete process.env.NOLI_OMP_SDK_ROOT;
	else process.env.NOLI_OMP_SDK_ROOT = previousSdkRoot;
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

async function runnerFor(factories: ExtensionFactory[], sessionManager: SessionManager, agent?: ExtensionAgentIdentity, model = gatewayModel): Promise<ExtensionRunner> {
	const runtime = new ExtensionRuntime();
	const bus = new EventBus();
	const extensions = [];
	for (const [index, factory] of factories.entries()) extensions.push(await loadExtensionFromFactory(factory, dir, bus, runtime, `synthetic-${index}`));
	const runner = new ExtensionRunner(extensions, runtime, dir, sessionManager, registry, undefined, undefined, undefined, undefined, agent);
	runner.initialize({
		sendMessage() {}, async sendUserMessage() {}, appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); }, setLabel() {},
		getActiveTools: () => [], getAllTools: () => [], setActiveTools: async () => {}, getCommands: () => [], setModel: async () => false,
		getThinkingLevel: () => undefined, setThinkingLevel() {}, getSessionName: () => undefined, setSessionName: async () => {},
	}, {
		getModel: () => model, isIdle: () => true, abort: async () => {}, hasPendingMessages: () => false, shutdown() {},
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


test("root: warm replays carry no reference and other providers are untouched", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const runner = await runnerFor([hooks], sessionManager);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("main", 1)]);
	expect(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", warmCost: 0, missCost: 1, spentCost: 0, continuationProbability: 1, action: "warm" })).toBe("warm");
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: null, warm: true } });
	await runner.emitContext([prompt("main", 1), prompt("next", 4)]);
	expect(await runner.emitBeforeProviderRequest(payload(), gatewayModel)).toMatchObject({ noli_request: { ref: reference("r"), warm: false } });
	const other = { ...gatewayModel, provider: "anthropic" } as Model;
	expect(await runner.emitBeforeProviderRequest(payload(), other)).toEqual(payload());
});

test("side turns retain parent ownership without registering fabricated main facts", async () => {
	const sessionManager = SessionManager.inMemory(dir);
	const channel = recorder();
	bindProducerChannel(dir, channel.producer, () => sessionManager.getSessionId());
	const runner = await runnerFor([hooks], sessionManager);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("main", 1)]);
	const reminder = readFileSync(join(sdk, "src/prompts/system/side-channel-no-tools.md"), "utf8");
	await runner.emitContext([prompt("main", 1), { role: "developer", content: [{ type: "text", text: reminder }], attribution: "agent", timestamp: 2 } as AgentMessage, { role: "user", content: [{ type: "text", text: "side question" }], attribution: "agent", timestamp: 3 } as AgentMessage]);
	const parent = sessionManager.getSessionId();
	const dispatch = `${parent}:side:0123456789abcdef`;
	const metadata = { user_id: JSON.stringify({ session_id: parent }) };
	received.length = 0;
	await streamSimple(gatewayModel, { messages: [{ role: "user", content: "side question", timestamp: 3 }] }, {
		apiKey: reference("k"), sessionId: dispatch, metadata,
		onPayload: payload => runner.emitBeforeProviderRequest(payload, gatewayModel),
	}).result();
	expect(channel.calls.registered).toHaveLength(1);
	expect(received).toHaveLength(1);
	expect(received[0]!.headers.get("x-noli-producer-session-id")).toBe(dispatch);
	expect(JSON.parse(received[0]!.body)).toMatchObject({ metadata, noli_request: { session: parent, ref: reference("r"), warm: false } });
});

test("Gateway compaction fails closed without the live OMP handler budget", async () => {
	const session = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const runner = await runnerFor([hooks], session);
	await runner.emit({ type: "session_start" });
	const before = { type: "session_before_compact", preparation: { tokensBefore: 1 }, branchEntries: [], signal: new AbortController().signal } as unknown as RunnerEvent;
	for (const reason of ["threshold", "idle", "overflow"]) {
		await runner.emit({ type: "auto_compaction_start", reason, action: "context-full" } as unknown as RunnerEvent);
		expect(await runner.emit(before)).toEqual({ cancel: true });
	}
	expect(channel.calls.compactions).toHaveLength(0);
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
});

test("Responses root and child register their own authenticated session without Claude body shaping", async () => {
	const root = SessionManager.inMemory(dir), child = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => root.getSessionId());
	const runner = await runnerFor([hooks], root, undefined, responsesModel);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("root synthetic", 1)]);
	const body = { model: responsesModel.id, input: [{ role: "user", content: "synthetic" }] };
	expect(await runner.emitBeforeProviderRequest(body, responsesModel)).toEqual({ ...body, noli_request: { session: root.getSessionId(), ref: reference("r"), warm: false } });
	// A second attempt of the same dispatch retains its registered authority.
	expect(await runner.emitBeforeProviderRequest(body, responsesModel)).toEqual({ ...body, noli_request: { session: root.getSessionId(), ref: reference("r"), warm: false } });
	const sub = await runnerFor([childHooks], child, { kind: "sub", id: "0-Responses", name: "responses", depth: 1, parentId: "Main" }, responsesModel);
	await sub.emit({ type: "session_start" });
	await sub.emitContext([prompt("child synthetic", 2)]);
	expect(channel.calls.registered.at(-1)).toMatchObject({ ompSessionId: child.getSessionId(), facts: { requestClass: "subagent", parentProducerSessionId: root.getSessionId() } });
	expect(await sub.emitBeforeProviderRequest(body, responsesModel)).toEqual({ ...body, noli_request: { session: child.getSessionId(), ref: reference("r"), warm: false } });
	expect(await runner.emitBeforeProviderRequest(body, { ...responsesModel, provider: "openai" })).toEqual(body);
	expect(await runner.emitBeforeProviderRequest(body, { ...responsesModel, api: "anthropic-messages" } as Model)).toEqual(body);
});

test("Responses registration failure is closed and stock routing carries the private owning-session header", async () => {
	const session = SessionManager.inMemory(dir), channel = recorder(async () => { throw new Error("synthetic rejection"); });
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const runner = await runnerFor([hooks], session, undefined, responsesModel);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("synthetic", 1)]);
	received.length = 0;
	await streamSimple(responsesModel, { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }, {
		apiKey: "synthetic-key", sessionId: session.getSessionId(), onPayload: (body, model) => runner.emitBeforeProviderRequest(body, model),
	}).result();
	expect(received).toHaveLength(1);
	expect(JSON.parse(received[0]!.body).noli_request).toEqual({ session: session.getSessionId(), ref: null, warm: false });
	expect(received[0]!.headers.get("x-noli-producer-session-id")).toBe(session.getSessionId());
});

test("real session lifecycle enriches stock Responses root and side headers without changing cache or body", async () => {
	const session = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const runner = await runnerFor([hooks], session, undefined, responsesModel);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("synthetic exact body", 1)]);
	received.length = 0;
	const owner = session.getSessionId(), side = `${owner}:side:conversation:actual-btw`;
	const cache = "shared-cache-not-routing";
	for (const sessionId of [owner, side]) {
		await streamSimple(responsesModel, { messages: [{ role: "user", content: "synthetic exact body", timestamp: 1 }] }, {
			apiKey: "synthetic-loopback-key", sessionId, parentSessionId: owner, promptCacheKey: cache,
			onPayload: (body, model) => runner.emitBeforeProviderRequest(body, model),
		}).result();
	}
	expect(responsesModel.api).toBe("openai-responses");
	expect(received.map(item => item.headers.get("x-noli-producer-session-id"))).toEqual([owner, side]);
	for (const item of received) {
		const body = JSON.parse(item.body);
		expect(body.prompt_cache_key).toBe(cache);
		expect(JSON.stringify(body.input)).toContain("synthetic exact body");
		expect(body.noli_request).toEqual({ session: owner, ref: reference("r"), warm: false });
	}
});

test.each(["claude", "responses"])("%s stock OMP compaction brackets manual and automatic summary requests and closes on failure", async family => {
	const model = family === "claude" ? gatewayModel : responsesModel;
	const session = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	let holders = 0;
	const boundedHooks: ExtensionFactory = pi => installClaudeHooks(pi, dir, { toolResults: true, handlerBudget: Promise.resolve({ lift: () => { holders++; return true; }, restore: () => { holders--; } }) });
	const runner = await runnerFor([boundedHooks], session, undefined, model);
	await runner.emit({ type: "session_start" });
	for (let index = 0; index < 4; index++) session.appendMessage(prompt(`synthetic history ${index} ${"detail ".repeat(200)}`, index + 1) as Parameters<SessionManager["appendMessage"]>[0]);
	const preparation = prepareCompaction(session.getBranch(), { enabled: true, reserveTokens: 128, keepRecentTokens: 1 }, model)!;
	expect(preparation).toBeDefined();
	for (const reason of [undefined, "threshold", "overflow"]) {
		channel.calls.compactions.length = 0;
		if (reason) await runner.emit({ type: "auto_compaction_start", reason, action: "context-full" } as unknown as RunnerEvent);
		received.length = 0;
		expect(await runner.emit({ type: "session_before_compact", preparation, branchEntries: session.getBranch(), customInstructions: "Keep synthetic facts", signal: new AbortController().signal } as unknown as RunnerEvent)).toEqual({ cancel: true });
		expect(channel.calls.compactions.map(call => call.phase)).toEqual(["begin", "end"]);
		expect(channel.calls.compactions[0]).toMatchObject({ ompSessionId: session.getSessionId(), facts: { requestClass: "compaction", compactionKind: reason === undefined ? "manual" : reason === "overflow" ? "reactive" : "auto" } });
		expect(channel.calls.compactions[1]!.facts).toBeNull();
		expect(received.length).toBeGreaterThan(0);
		for (const request of received) {
			expect(JSON.parse(request.body).noli_request).toEqual({ session: session.getSessionId(), ref: null, warm: false });
			const begin = channel.calls.compactions[0]!;
			expect(begin).toMatchObject({ dispatchSessionId: request.headers.get("x-noli-producer-session-id") });
			expect(request.headers.get("x-noli-producer-session-id")?.startsWith(session.getSessionId() + ":side:")).toBe(true);
			if (family === "responses") expect(JSON.parse(request.body).prompt_cache_key).toBe(request.headers.get("x-noli-producer-session-id"));
		}
		expect(holders).toBe(0);
	}
});

test.each(["history", "split-turn"])("Gateway %s compaction preserves application messages and context exclusions", async region => {
	const session = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const boundedHooks: ExtensionFactory = pi => installClaudeHooks(pi, dir, { toolResults: true, handlerBudget: Promise.resolve({ lift: () => true, restore() {} }) });
	const runner = await runnerFor([boundedHooks], session, undefined, responsesModel);
	await runner.emit({ type: "session_start" });
	for (let index = 0; index < 4; index++) session.appendMessage(prompt(`history ${index} ${"detail ".repeat(200)}`, index + 1) as Parameters<SessionManager["appendMessage"]>[0]);
	const preparation = prepareCompaction(session.getBranch(), { enabled: true, reserveTokens: 128, keepRecentTokens: 1 }, responsesModel)!;
	const messages: AgentMessage[] = [
		prompt("Preserve the application context", 1),
		{ role: "fileMention", files: [{ path: "notes.txt", content: "attached-file-evidence" }], timestamp: 2 },
		{ role: "bashExecution", command: "printf shell", output: "shell-result-evidence", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
		{ role: "pythonExecution", code: "print('python')", output: "python-result-evidence", exitCode: 0, cancelled: false, truncated: false, timestamp: 4 },
		{ role: "bashExecution", command: "private command", output: "excluded-shell-evidence", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 5 },
		{ role: "pythonExecution", code: "private_code()", output: "excluded-python-evidence", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 6 },
	];
	preparation.messagesToSummarize = region === "history" ? messages : [];
	preparation.turnPrefixMessages = region === "split-turn" ? messages : [];
	preparation.isSplitTurn = region === "split-turn";
	received.length = 0;
	await runner.emit({ type: "session_before_compact", preparation, branchEntries: session.getBranch(), signal: new AbortController().signal } as unknown as RunnerEvent);
	expect(received).toHaveLength(1);
	const summaryInput = JSON.stringify(JSON.parse(received[0]!.body).input);
	for (const content of ["attached-file-evidence", "shell-result-evidence", "python-result-evidence"]) expect(summaryInput).toContain(content);
	for (const content of ["excluded-shell-evidence", "excluded-python-evidence", "private command", "private_code"]) expect(summaryInput).not.toContain(content);
});

test("adversarial marker read failure is visible and never registers invented main facts", async () => {
	const session = SessionManager.inMemory(dir), channel = recorder(), warnings: string[] = [];
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const saved = process.env.NOLI_OMP_SDK_ROOT;
	process.env.NOLI_OMP_SDK_ROOT = join(dir, "missing-sdk");
	try {
		const loggingHooks: ExtensionFactory = pi => installClaudeHooks(Object.create(pi, { logger: { value: { warn: (message: string) => warnings.push(message) } } }) as ExtensionAPI, dir, { toolResults: true });
		const runner = await runnerFor([loggingHooks], session, undefined, responsesModel);
		await runner.emit({ type: "session_start" });
		await runner.emitContext([prompt("real main input", 1)]);
		expect(channel.calls.registered).toHaveLength(0);
		expect(await runner.emitBeforeProviderRequest({ model: responsesModel.id, input: "real main input" }, responsesModel)).toMatchObject({ noli_request: { ref: null, warm: false } });
		expect(warnings.join(" ")).toMatch(/update.*(marker|provenance)|(marker|provenance).*update/i);
	} finally {
		if (saved === undefined) delete process.env.NOLI_OMP_SDK_ROOT; else process.env.NOLI_OMP_SDK_ROOT = saved;
	}
});

test("adversarial completed OMP compaction survives cleanup-only bridge failure", async () => {
	const summary = "Synthetic trusted OMP summary survives bridge cleanup";
	let requests = 0;
	const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as { noli_request?: unknown };
		expect(body.noli_request).toBeDefined();
		requests++;
		const item = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: summary, annotations: [] }] };
		const response = { id: "resp_synthetic", object: "response", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } };
		const events = [
			{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: summary },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	} });
	try {
		const session = SessionManager.inMemory(dir), channel = recorder();
		const phases: string[] = [];
		channel.producer.compaction = async params => { phases.push(params.phase); if (params.phase === "end") throw new Error("synthetic cleanup transport failure"); };
		bindProducerChannel(dir, channel.producer, () => session.getSessionId());
		let held = 0;
		const hooks: ExtensionFactory = pi => installClaudeHooks(pi, dir, { toolResults: true, handlerBudget: Promise.resolve({ lift: () => { held++; return true; }, restore: () => { held--; } }) });
		const model = { ...responsesModel, baseUrl: `http://127.0.0.1:${upstream.port}` };
		const runner = await runnerFor([hooks], session, undefined, model);
		await runner.emit({ type: "session_start" });
		for (let i = 0; i < 4; i++) session.appendMessage(prompt(`synthetic ${i} ${"history ".repeat(200)}`, i + 1) as Parameters<SessionManager["appendMessage"]>[0]);
		const preparation = prepareCompaction(session.getBranch(), { enabled: true, reserveTokens: 128, keepRecentTokens: 1 }, model)!;
		expect(preparation).toBeDefined();
		const result = await runner.emit({ type: "session_before_compact", preparation, branchEntries: session.getBranch(), signal: new AbortController().signal } as unknown as RunnerEvent);
		expect(requests).toBeGreaterThan(0);
		expect(phases).toEqual(["begin", "end"]);
		expect(held).toBe(0);
		expect(result).toMatchObject({ compaction: { summary } });
	} finally { upstream.stop(true); }
});

test.each(["openai-responses", "openai-codex-responses"])("adversarial %s retains authenticated root and side dispatch provenance", async api => {
	const model = api === "openai-responses" ? responsesModel : codexResponsesModel;
	const session = SessionManager.inMemory(dir), channel = recorder();
	bindProducerChannel(dir, channel.producer, () => session.getSessionId());
	const runner = await runnerFor([hooks], session, undefined, model);
	await runner.emit({ type: "session_start" });
	await runner.emitContext([prompt("honest main", 1)]);
	const owner = session.getSessionId(), side = `${owner}:side:conversation:synthetic`;
	received.length = 0;
	for (const sessionId of [owner, side]) {
		await streamSimple(model, { messages: [{ role: "user", content: "honest main", timestamp: 1 }] }, {
			apiKey: "synthetic-loopback-only", sessionId, parentSessionId: owner,
			onPayload: (body, target) => runner.emitBeforeProviderRequest(body, target),
		}).result();
	}
	expect(received).toHaveLength(2);
	const dispatchSessions = received.map(request => api === "openai-codex-responses"
		? JSON.parse(request.headers.get("x-codex-turn-metadata") ?? "null")?.session_id
		: request.headers.get("x-noli-producer-session-id"));
	expect(dispatchSessions).toEqual([owner, side]);
	for (const request of received) expect(JSON.parse(request.body).noli_request).toEqual({ session: owner, ref: reference("r"), warm: false });
});

test.each([[true, true], [false, true], [true, false]])("adversarial native provenance advertises only prepared marker and live runner (%s, %s)", async (marker, live) => {
	const saved = process.env.NOLI_OMP_SDK_ROOT;
	if (!marker) process.env.NOLI_OMP_SDK_ROOT = join(dir, "missing-sdk");
	try {
		const session = SessionManager.inMemory(dir), channel = recorder();
		bindProducerChannel(dir, channel.producer, () => session.getSessionId());
		let runner: ExtensionRunner | undefined, context: ExtensionContext | undefined;
		const prepared = Promise.withResolvers<(ctx: ExtensionContext) => CapabilityState>();
		const budget = runnerHandlerBudget({ ExtensionRunner, EXTENSION_HANDLER_TIMEOUT_MS, testSetExtensionHandlerTimeoutMs }, () => live ? runner : {});
		const configured: ExtensionFactory = pi => {
			installClaudeHooks(pi, dir, { toolResults: true, handlerBudget: Promise.resolve(budget), onPrepared: prepared.resolve });
			pi.on("session_start", (_event, ctx) => { context = ctx; });
		};
		runner = await runnerFor([configured], session, undefined, responsesModel);
		await runner.emit({ type: "session_start" });
		const capability = (await prepared.promise)(context!);
		expect(capability.api).toBe("native-provenance-v3");
		expect(capability.available).toBe(marker && live);
		if (!capability.available) expect(capability.detail).toMatch(/update/i);
	} finally {
		if (saved === undefined) delete process.env.NOLI_OMP_SDK_ROOT; else process.env.NOLI_OMP_SDK_ROOT = saved;
	}
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
		expect(durations.map(entry => entry.toolName)).toEqual(["bash", "read"]);
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
		expect(lastFacts(channel).prevToolDurations?.map(entry => entry.toolName)).toEqual(["read"]);
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
		expect(lastFacts(channel)).toMatchObject({ requestClass: "subagent", prevToolDurations: [{ toolName: "grep" }] });
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

	test.each([false, true])("duration names match actual managed Anthropic tool declarations (escape=%s)", async escape => {
		const model = { ...gatewayModel, compat: { ...gatewayModel.compat, escapeBuiltinToolNames: escape } } as Model;
		received.length = 0;
		await streamSimple(model, { messages: [{ role: "user", content: "synthetic", timestamp: 1 }], tools } as unknown as Parameters<typeof streamSimple>[1], { apiKey: reference("k") }).result();
		expect(received).toHaveLength(1);
		const wire = JSON.parse(received[0]!.body).tools.map((tool: { name: string }) => tool.name);
		const batch = { role: "assistant", content: names.map((name, index) => ({ type: "toolCall", id: `t${index}`, name, arguments: {} })), stopReason: "toolUse", timestamp: 2 } as unknown as AgentMessage;
		const timings = new Map(names.map((_, index) => [`t${index}`, { start: 0, end: index + 1, executed: true, epoch: 0 }] as const));
		expect(prevToolDurations([batch], [], timings, 0, escape)?.map(entry => entry.toolName)).toEqual(wire);
	});
});

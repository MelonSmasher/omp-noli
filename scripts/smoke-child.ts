/** Installed-binary integration smoke. Prerequisites: POSIX, Bun >=1.4.2, omp/18.5.1 on PATH.
 * Usage: bun scripts/smoke-child.ts [package-root]. No external credentials/network required.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOutputResult, AgentView } from "../src/protocol";
import Ajv, { type ValidateFunction } from "ajv";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent";


type Json = Record<string, unknown>;
interface NativeBlock { type: string; id?: string; text?: string; name?: string; arguments?: unknown }
interface NativeMessage { role: string; id?: string; responseId?: string; content: string | NativeBlock[]; timestamp: number; toolName?: string; toolCallId?: string; isError?: boolean; details?: { usage?: { output: number } } }
interface NativeEntry { type: string; id?: string; timestamp?: string; message?: NativeMessage }
interface NativeSession {
	messages: NativeMessage[]; streamMessage: NativeMessage | null; entries: NativeEntry[];
	stats: SessionStats; servingModel: { modelIdentity: string; thinkingLevel: string; contextWindow: number };
	configuredThinking: string | null; thinkingLevel: string | null; tokenRate: number | null; streaming: boolean;
}
interface NativeAgent {
	id: string; identity: number; kind: string; parentId: string | null; live: boolean;
	status: string; sessionFile: string; lifecycle: { acceptedAt?: number } | null;
	native: NativeSession | null; retained: { native: NativeSession | null } | null; held: boolean;
}
interface NativeSnapshot { rootId: string; agents: NativeAgent[] }
interface ProviderRequest { stream: boolean; model: string; reasoning_effort?: string; tools: { function: { name: string } }[] }
interface WireFrame { id?: string; type?: string; ok?: boolean; success?: boolean; result?: unknown; data?: unknown; error?: string | { code?: string; message?: string }; command?: string; isTerminal?: boolean }
interface Hello { protocol: number; sessionId: string; capabilities: Record<string, { available: boolean }> }
interface AgentList { agents: AgentView[] }
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const validateFrame = ajv.compile<WireFrame>({ type: "object", properties: { id: { type: ["string", "number"] }, error: { type: ["string", "object"] } } });
const validateProvider = ajv.compile<ProviderRequest>({ type: "object", required: ["stream", "model", "tools"], properties: { stream: { type: "boolean" }, model: { type: "string" }, tools: { type: "array", items: { type: "object", required: ["function"], properties: { function: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } } } });
const messageSchema = { type: "object", required: ["role", "content", "timestamp"], properties: { role: { type: "string" }, content: { type: ["string", "array"] }, timestamp: { type: "number" } } };
const nativeSchema = { type: ["object", "null"], required: ["messages", "entries", "stats", "servingModel", "tokenRate"], properties: { messages: { type: "array", items: messageSchema }, streamMessage: { anyOf: [messageSchema, { type: "null" }] }, entries: { type: "array" }, stats: { type: "object", required: ["tokens", "cost", "assistantMessages"], properties: { tokens: { type: "object", required: ["input", "output"], properties: { input: { type: "number" }, output: { type: "number" } } }, cost: { type: "number" }, assistantMessages: { type: "number" } } }, servingModel: { type: "object", required: ["modelIdentity", "thinkingLevel", "contextWindow"] }, tokenRate: { type: ["number", "null"] } } };
const validateSnapshot = ajv.compile<NativeSnapshot>({ type: "object", required: ["rootId", "agents"], properties: { rootId: { type: "string" }, agents: { type: "array", items: { type: "object", required: ["id", "identity", "kind", "live", "status", "native", "held"], properties: { id: { type: "string" }, identity: { type: "number" }, kind: { type: "string" }, live: { type: "boolean" }, status: { type: "string" }, native: nativeSchema, retained: { type: ["object", "null"] }, held: { type: "boolean" } } } } } });
const validateHello = ajv.compile<Hello>({ type: "object", required: ["protocol", "sessionId", "capabilities"], properties: { protocol: { type: "number" }, sessionId: { type: "string" }, capabilities: { type: "object" } } });
const validateList = ajv.compile<AgentList>({ type: "object", required: ["agents"], properties: { agents: { type: "array", items: { type: "object", required: ["id", "model", "effort", "requests", "inputTokens", "outputTokens", "sessionCost", "contextTokens", "contextWindow", "tokensPerSecond"] } } } });
const validateOutput = ajv.compile<AgentOutputResult>({ type: "object", required: ["agentId", "text", "spans", "nextOffset"], properties: { agentId: { type: "string" }, text: { type: "string" }, spans: { type: "array", items: { type: "object", required: ["id", "role", "tool", "created_ms", "start", "end"], properties: { id: { type: "string" }, role: { type: "string" }, tool: { type: ["string", "null"] }, created_ms: { type: "number" }, start: { type: "integer" }, end: { type: "integer" } } } }, nextOffset: { type: ["integer", "null"] } } });
const validateDiskEntry = ajv.compile<NativeEntry>({ type: "object", required: ["type"], properties: { type: { type: "string" }, message: messageSchema } });
function parse<T>(value: unknown, validate: ValidateFunction<T>): T {
	assert(validate(value), `Invalid smoke boundary: ${ajv.errorsText(validate.errors)}`);
	return value;
}
const timeoutMs = 120_000;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(process.argv[2] ?? join(scriptDir, ".."));
const marker = "native-child-smoke-🧪";
const liveText = "CHILD LIVE TEXT 🧪";
const finalText = "CHILD FINAL ASSISTANT 🧪";
const toolText = `CHILD TOOL RESULT ${marker} 🧪`;
const provider = "child-smoke";
const rootModel = "root-model";
const childModel = "child-model";
const expectedChildModel = `${provider}/${childModel}`;
// Darwin's per-user TMPDIR is too long for the native Unix-socket path limit.
const temporary = mkdtempSync("/tmp/noli-child-");
const home = join(temporary, "home");
const workdir = join(temporary, "work");
const bridgeDir = join(temporary, "bridge");
const observerSocket = join(temporary, "native.sock");
const profile = "child-smoke";
const agentDir = join(home, ".omp", "profiles", profile, "agent");
// A generated bridge credential exists only in process memory and the child's environment.
const bridgeToken = randomBytes(32).toString("hex");
const requests: { model: string; effort: unknown; input: number; output: number }[] = [];
let labelRequests = 0;
let subprocess: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let endpoint: Bun.Server<undefined> | undefined;
let rpc: JsonClient | undefined;
let bridge: JsonClient | undefined;
let observer: JsonClient | undefined;
let failedProvider: Error | undefined;
let stderrDiagnostic = "";
let stop = false;
const finishChildStream = Promise.withResolvers<void>();
const clients = new Set<Socket>();
const deadline = Date.now() + timeoutMs;

async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Timed out: ${label}`)), ms);
	try { return await Promise.race([promise, expired.promise]); }
	finally { clearTimeout(timer); }
}
async function until<T>(label: string, sample: () => Promise<T | undefined>): Promise<T> {
	while (!stop && Date.now() < deadline) {
		if (failedProvider) throw failedProvider;
		const value = await sample();
		if (value !== undefined) return value;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}
class JsonClient {
	private nextId = 0;
	private buffered = "";
	private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly events: WireFrame[] = [];
	constructor(private send: (text: string) => void) {}
	feed(chunk: string) {
		this.buffered += chunk;
		for (;;) {
			const end = this.buffered.indexOf("\n");
			if (end < 0) break;
			const line = this.buffered.slice(0, end);
			this.buffered = this.buffered.slice(end + 1);
			if (!line.trim()) continue;
			let frame: WireFrame;
			try { frame = parse(JSON.parse(line), validateFrame); } catch { continue; }
			const waiter = this.pending.get(String(frame.id));
			if (waiter) {
				this.pending.delete(String(frame.id));
				if (frame.ok === false || frame.success === false) waiter.reject(new Error(`${frame.command ?? "native"}: ${typeof frame.error === "string" ? frame.error : frame.error?.message}`));
				else waiter.resolve(frame.result ?? frame.data);
			} else this.events.push(frame);
		}
	}
	fail(error: Error) {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
	}
	async call(frame: Json): Promise<unknown>;
	async call<T>(frame: Json, validate: ValidateFunction<T>): Promise<T>;
	async call<T>(frame: Json, validate?: ValidateFunction<T>): Promise<T | unknown> {
		const id = String(++this.nextId);
		const result = Promise.withResolvers<unknown>();
		this.pending.set(id, result);
		try {
			this.send(`${JSON.stringify({ ...frame, id })}\n`);
			const value = await bounded(result.promise, String(frame.method ?? frame.type ?? frame.op));
			return validate ? parse(value, validate) : value;
		} finally { this.pending.delete(id); }
	}
}
async function socketClient(path: string): Promise<JsonClient> {
	const socket = connect(path);
	clients.add(socket);
	const client = new JsonClient(text => socket.write(text));
	socket.setEncoding("utf8");
	socket.on("data", chunk => client.feed(String(chunk)));
	socket.on("error", error => client.fail(error));
	socket.on("close", () => client.fail(new Error("Smoke socket closed")));
	await bounded(new Promise<void>((resolveConnected, reject) => {
		socket.once("connect", resolveConnected);
		socket.once("error", reject);
	}), "connect socket");
	return client;
}
function transcriptStamp(file: string) {
	const stat = statSync(file);
	return { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}
function visibleBlocks(message: NativeMessage): { text: string; tool: string | null }[] {
	if (typeof message.content === "string") return [{ text: message.content, tool: message.toolName ?? null }];
	return (message.content ?? []).flatMap(block => {
		if (block.type === "text" && block.text) return [{ text: block.text, tool: message.toolName ?? null }];
		if (block.type === "toolCall" && block.name) return [{ text: JSON.stringify(block.arguments ?? {}), tool: block.name }];
		return [];
	});
}
function compareSpans(output: AgentOutputResult, native: { id: string; native?: NativeSession | null; messages?: NativeMessage[]; entries?: NativeEntry[] }, expected: string[]) {
	assert.equal(output.agentId, native.id);
	assert(Buffer.byteLength(output.text) <= 64 * 1024, "output page exceeds byte bound");
	let priorEnd = 0;
	const messages = [...(native.native?.messages ?? native.messages ?? [])];
	const streamed = native.native?.streamMessage;
	if (streamed) messages.push(streamed);
	for (const span of output.spans) {
		assert(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end));
		assert(span.start >= priorEnd && span.end >= span.start && span.end <= output.text.length, "invalid UTF-16 span");
		priorEnd = span.end;
		assert(messages.some(message => message.role === span.role), `span role is not native: ${span.role}`);
		assert(messages.some(message => message.role === span.role && message.timestamp === span.created_ms), "span timestamp is not native");
		const entryIds = (native.native?.entries ?? native.entries ?? []).filter(entry => entry.type === "message" && entry.message?.role === span.role && entry.message.timestamp === span.created_ms).flatMap(entry => entry.id ? [entry.id] : []);
		const matchingMessages = messages.filter(message => message.role === span.role && message.timestamp === span.created_ms);
		const nativeIds = matchingMessages.flatMap(message => [message.id, message.responseId, ...(message.role === "toolResult" ? [message.toolCallId] : []), ...(Array.isArray(message.content) ? message.content.filter(block => span.tool ? block.name === span.tool : block.type === "text").map(block => block.id) : [])]).filter((id): id is string => typeof id === "string");
		const identities = [...nativeIds, ...entryIds];
		assert(identities.length === 0 ? span.id.startsWith("derived:") : identities.some(id => span.id === id || span.id.startsWith(`${id}:block:`)), "span identity is not native");
		if (span.tool) assert(messages.some(message => message.toolName === span.tool || Array.isArray(message.content) && message.content.some(block => block.type === "toolCall" && block.name === span.tool)), `non-native tool ${span.tool}`);
	}
	for (const text of expected) {
		assert(output.text.includes(text), `plugin output is missing ${text}`);
		assert(output.spans.some(span => output.text.slice(span.start, span.end).includes(text)), `UTF-16 spans do not cover ${text}`);
		assert(messages.some(message => visibleBlocks(message).some(block => block.text.includes(text))), `native transcript is missing ${text}`);
	}
}
function compareTelemetry(view: AgentView, ref: NativeAgent, parked = false) {
	const native = ref.native ?? ref.retained?.native;
	assert(native, "independent native telemetry missing");
	const stats = native.stats;
	assert.equal(view.model, native.servingModel.modelIdentity);
	assert.equal(view.effort, native.servingModel.thinkingLevel);
	assert.equal(view.requests, stats.assistantMessages, "requests incorrectly include task-result usage");
	assert.equal(view.inputTokens, stats.tokens.input);
	assert.equal(view.outputTokens, stats.tokens.output);
	assert.equal(view.sessionCost, stats.cost);
	assert.equal(view.contextTokens, stats.contextUsage?.tokens ?? null);
	assert.equal(view.contextWindow, stats.contextUsage?.contextWindow ?? null);
	if (parked) assert.equal(view.tokensPerSecond, null, "parked rate must be null");
	else if (native.tokenRate === null) assert.equal(view.tokensPerSecond, null);
	else {
		assert(view.tokensPerSecond !== null && view.tokensPerSecond > 0, "active throughput missing");
		assert(Math.abs(view.tokensPerSecond - native.tokenRate) / native.tokenRate < 0.2, "throughput differs from own native meter");
	}
}

try {
	assert(process.platform !== "win32", "Smoke requires Unix domain sockets");
	assert(existsSync(join(packageRoot, "package.json")), "package-root does not contain package.json");
	const binary = Bun.which("omp");
	assert(binary, "Installed omp binary is missing from PATH");
	const executableHeader = Buffer.alloc(4);
	const executable = openSync(binary, "r");
	try { assert.equal(readSync(executable, executableHeader, 0, 4, 0), 4); }
	finally { closeSync(executable); }
	assert(executableHeader.subarray(0, 2).toString() !== "#!", "Smoke requires the compiled installed omp binary, not a shell/SDK launcher");
	const versionProcess = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
	let version: string;
	try {
		const [text, , exitCode] = await bounded(Promise.all([new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(), versionProcess.exited]), "installed binary version");
		version = text.trim();
		assert.equal(exitCode, 0);
	} finally {
		if (versionProcess.exitCode === null) { versionProcess.kill("SIGKILL"); await versionProcess.exited; }
	}
	assert(/(?:omp[/ v])18\.5\.1\b/.test(version), `Requires installed omp 18.5.1, received ${version}`);
	for (const dir of [home, workdir, bridgeDir, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(join(agentDir, "agents"));
	writeFileSync(join(agentDir, "agents", "smoke-child.md"), "---\nname: smoke-child\ndescription: Native installed-binary smoke child\nmodel: child-smoke/child-model:high\nthinking: high\nspawns: \"\"\n---\nComplete the deterministic child assignment. Call child_smoke_gate, then report your final assistant text and submit a required terminal yield.\n");
	endpoint = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("Not found", { status: 404 });
			try {
				const raw: unknown = await request.json();
				if (raw && typeof raw === "object" && !("tools" in raw)) {
					assert("model" in raw && raw.model === rootModel && "stream" in raw && raw.stream === true);
					assert("messages" in raw && Array.isArray(raw.messages) && raw.messages.some((message: Json) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("# Task\nLabel the delegated work")), "unexpected tool-free native request");
					assert.equal(++labelRequests, 1, "unexpected additional native label request");
					const chunk = { id: "smoke-native-label", object: "chat.completion.chunk", model: rootModel, choices: [{ index: 0, delta: { role: "assistant", content: "<title>Observe native child transcript and usage</title>" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } };
					return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
				}
				const body = parse(raw, validateProvider);
				assert(body.stream === true, "native provider must request streaming");
				assert([rootModel, childModel].includes(body.model), "unexpected model request");
				const ordinal = requests.filter(item => item.model === body.model).length;
				assert(ordinal < 2, "unexpected extra model call");
				const usage = { model: body.model, effort: body.reasoning_effort, input: body.model === rootModel ? 101 + ordinal : 211 + ordinal, output: body.model === rootModel ? 31 + ordinal : ordinal === 0 ? 1100 : 71 };
				requests.push(usage);
				const isChild = body.model === childModel;
				const tool = isChild ? ordinal === 0 ? "child_smoke_gate" : "yield" : ordinal === 0 ? "task" : null;
				if (tool) assert(body.tools.some(entry => entry.function.name === tool), `native tool ${tool} is not registered`);
				const callArgs = tool === "task" ? { context: "Installed binary smoke; perform the genuine task and required yield.", tasks: [{ name: "SmokeChild", agent: "smoke-child", model: `${expectedChildModel}:high`, task: `CHILD PROMPT ${marker}\nCall child_smoke_gate with marker ${marker}; final assistant and terminal yield required.`, solutionSpace: "One deterministic tool observation and required yield" }] } : tool === "child_smoke_gate" ? { marker } : { type: "result", data: { marker, observed: true } };
				const text = isChild ? ordinal === 0 ? `${liveText}\n` : `${finalText}\nsecond final line\n` : ordinal === 0 ? "ROOT SPAWNING CHILD\n" : "ROOT FINAL DONE\n";
				return new Response(new ReadableStream<Uint8Array>({
					async start(controller) {
						const encoder = new TextEncoder();
						const event = (delta: Json, finishReason: string | null = null, billed?: Json) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `smoke-${body.model}-${ordinal}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(billed ? { usage: billed } : {}) })}\n\n`));
						try {
							event({ role: "assistant", content: text });
							if (isChild && ordinal === 0) {
								// Enough real stream time/tokens for OMP's native rate evidence gate.
								for (let index = 0; index < 25 && !stop; index++) {
									await Bun.sleep(320);
									event({ content: `stream ${index}: ${"observing independent native session telemetry ".repeat(10)}🧪\n` });
								}
							}
							if (tool) {
								event({ tool_calls: [{ index: 0, id: `smoke-call-${body.model}-${ordinal}`, type: "function", function: { name: tool, arguments: JSON.stringify(callArgs) } }] });
								if (isChild && ordinal === 0) await finishChildStream.promise;
							}
							await Bun.sleep(150);
							event({}, tool ? "tool_calls" : "stop", { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output });
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
						} catch (error) {
							if (!stop) failedProvider = error instanceof Error ? error : new Error(String(error));
							try { controller.error(error); } catch {}
						}
					},
				}), { headers: { "content-type": "text/event-stream" } });
			} catch (error) {
				failedProvider = error instanceof Error ? error : new Error(String(error));
				return new Response("Smoke provider rejected unexpected native request", { status: 500 });
			}
		},
	});
	writeFileSync(join(agentDir, "models.yml"), JSON.stringify({ providers: { [provider]: { api: "openai-completions", baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, apiKey: "CHILD_SMOKE_LOCAL_KEY", models: [rootModel, childModel].map(id => ({ id, name: id, reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"] }, input: ["text"], contextWindow: id === rootModel ? 32768 : 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, supportsStrictMode: false, supportsDeveloperRole: false, supportsStore: false } })) } } }));
	writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ modelRoles: { default: `${provider}/${rootModel}:low`, smol: `${provider}/${rootModel}:low` }, task: { agentIdleTtlMs: 1800, batch: true, prewalk: false, isolation: { enabled: false } }, async: { enabled: false }, providers: { cacheWarming: "off" }, advisor: { enabled: false }, memory: { backend: "off" }, compaction: { enabled: false }, browser: { enabled: false }, mcp: { enabled: false }, telemetry: { enabled: false } }));
	// Explicit allowlist: inherited credentials, gateway/profile/overlay variables cannot escape.
	const environment: Record<string, string> = {
		PATH: process.env.PATH ?? "", HOME: home, TMPDIR: temporary, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
		LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1", CI: "1", PI_NO_PTY: "1", PI_PYTHON_SKIP_CHECK: "1",
		CHILD_SMOKE_LOCAL_KEY: "local-fixture-not-a-credential", CHILD_SMOKE_OBSERVER_SOCKET: observerSocket,
		NOLI_BRIDGE_DIR: bridgeDir, NOLI_BRIDGE_TOKEN: bridgeToken,
	};
	subprocess = Bun.spawn([binary, "--mode", "rpc", "--no-ui", "--profile", profile, "--cwd", workdir, "--model", `${provider}/${rootModel}`, "--thinking", "low", "--no-lsp", "--no-pty", "--no-title", "--no-skills", "--no-rules", "--no-extensions", "--approval-mode", "yolo", "--tools", "read,task,child_smoke_gate", "-e", packageRoot, "-e", join(scriptDir, "fixtures", "child-observer.ts")], { cwd: workdir, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	rpc = new JsonClient(text => { subprocess!.stdin.write(text); subprocess!.stdin.flush(); });
	const pump = async (stream: ReadableStream<Uint8Array>, client?: JsonClient) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			if (client) client.feed(text);
			else stderrDiagnostic = (stderrDiagnostic + text).slice(-16_384);
		}
	};
	const stdoutDrain = pump(subprocess.stdout, rpc);
	const stderrDrain = pump(subprocess.stderr);
	await until("installed OMP RPC ready", async () => rpc!.events.some(event => event.type === "ready") ? true : undefined);
	await until("native companion socket", async () => existsSync(observerSocket) ? true : undefined);
	observer = await socketClient(observerSocket);
	const bridgePath = await until("plugin Unix socket", async () => readdirSync(bridgeDir).find(file => file.endsWith(".sock")));
	bridge = await socketClient(join(bridgeDir, bridgePath));
	const hello = await bridge.call({ method: "hello", params: { token: bridgeToken } }, validateHello);
	assert.equal(hello.protocol, 1);
	assert(hello.capabilities["agents.output"]?.available, "installed extension does not advertise agents.output");
	function bridgeCall(method: "agents.list", params?: Json): Promise<AgentList>;
	function bridgeCall(method: "agents.output", params: Json): Promise<AgentOutputResult>;
	function bridgeCall(method: "agents.list" | "agents.output", params: Json = {}): Promise<AgentList | AgentOutputResult> {
		const request = { method, sessionId: hello.sessionId, params };
		return method === "agents.list" ? bridge!.call(request, validateList) : bridge!.call(request, validateOutput);
	}
	const nativeSnapshot = (): Promise<NativeSnapshot> => observer!.call({ op: "snapshot" }, validateSnapshot);
	await rpc.call({ type: "prompt", message: "ROOT CHILD SMOKE: spawn the requested native smoke-child with known high effort, await its required terminal yield, and finish." });
	const child = await until("genuine task child registration", async () => (await nativeSnapshot()).agents.find(agent => agent.kind === "sub"));
	assert(child.parentId, "child parent identity missing");
	const active = await until("live stream and native tool call", async () => {
		const snapshot = await nativeSnapshot();
		const ref = snapshot.agents.find(agent => agent.id === child.id);
		const stream = ref?.native?.streamMessage;
		return ref && Array.isArray(stream?.content) && stream.content.some(block => block.type === "toolCall" && block.name === "child_smoke_gate") ? ref : undefined;
	});
	assert(active.live && active.native?.streaming);
	const liveOutput: AgentOutputResult = await bridgeCall("agents.output", { agentId: child.id, limit: 500 });
	compareSpans(liveOutput, active, [`CHILD PROMPT ${marker}`, liveText]);
	assert(liveOutput.spans.some(span => span.role === "assistant" && span.tool === "child_smoke_gate"), "active native tool call absent from plugin spans");
	const activeView = (await bridgeCall("agents.list", { persisted: false })).agents.find((agent: AgentView) => agent.id === child.id);
	assert(activeView);
	assert(activeView.contextWindow !== null && activeView.contextTokens !== null, "live native context telemetry missing");
	compareTelemetry(activeView, active);
	assert.equal(activeView.model, expectedChildModel);
	assert.equal(activeView.effort, "high");
	assert(activeView.tokensPerSecond !== null && activeView.tokensPerSecond > 0, "native positive stream-rate evidence was not observed");
	finishChildStream.resolve();
	const held = await until("native tool execution", async () => {
		const ref = (await nativeSnapshot()).agents.find(agent => agent.id === child.id);
		return ref?.held ? ref : undefined;
	});
	assert(held.native?.messages.some(message => message.role === "assistant" && Array.isArray(message.content) && message.content.some(block => block.type === "toolCall" && block.name === "child_smoke_gate")));
	const heldView = (await bridgeCall("agents.list", { persisted: false })).agents.find((agent: AgentView) => agent.id === child.id);
	assert(heldView && heldView.requests !== null && activeView.requests !== null && heldView.outputTokens !== null && activeView.outputTokens !== null);
	compareTelemetry(heldView, held);
	assert(heldView.requests > activeView.requests && heldView.outputTokens > activeView.outputTokens, "active telemetry did not update after completed request");
	await observer.call({ op: "release", agentId: child.id });
	const completed = await until("required yield accepted", async () => {
		const ref = (await nativeSnapshot()).agents.find(agent => agent.id === child.id);
		return ref?.live && ref.status === "idle" && ref.lifecycle?.acceptedAt ? ref : undefined;
	});
	const completeOutput: AgentOutputResult = await bridgeCall("agents.output", { agentId: child.id, limit: 500 });
	compareSpans(completeOutput, completed, [liveText, toolText, finalText]);
	assert(completed.native?.messages.some(message => message.role === "toolResult" && message.toolName === "yield" && !message.isError), "native required yield did not produce a real success result");
	const newest: AgentOutputResult = await bridgeCall("agents.output", { agentId: child.id, limit: 3 });
	assert(newest.nextOffset !== null, "newest page lacks older cursor");
	let olderOffset: number | null = newest.nextOffset;
	let assembled = newest.text;
	while (olderOffset !== null) {
		const older: AgentOutputResult = await bridgeCall("agents.output", { agentId: child.id, offset: olderOffset, limit: 3 });
		assert(older.nextOffset === null || older.nextOffset < olderOffset, "older pagination does not progress");
		assembled = older.text + (older.text && assembled ? "\n" : "") + assembled;
		olderOffset = older.nextOffset;
	}
	assert.equal(assembled, completeOutput.text, "newest/older pages do not reconstruct oldest-first output");
	const parked = await until("short native idle TTL parking", async () => {
		const ref = (await nativeSnapshot()).agents.find(agent => agent.id === child.id);
		return ref?.status === "parked" && ref.native === null && !ref.live ? ref : undefined;
	});
	assert.equal(parked.identity, child.identity, "native child registry identity changed");
	const diskEntries = readFileSync(parked.sessionFile, "utf8").split("\n").filter(Boolean).map(line => parse(JSON.parse(line), validateDiskEntry));
	const diskMessages = diskEntries.flatMap(entry => entry.type === "message" && entry.message ? [entry.message] : []);
	const persisted = await bridgeCall("agents.output", { agentId: child.id, limit: 500 });
	compareSpans(persisted, { id: child.id, messages: diskMessages, entries: diskEntries }, [liveText, toolText, finalText]);
	assert.equal(persisted.text, completeOutput.text, "parked disk output differs from native live output");
	const parkedList = await bridgeCall("agents.list", { persisted: true });
	const parkedView = parkedList.agents.find((agent: AgentView) => agent.id === child.id);
	assert(parkedView);
	compareTelemetry(parkedView, parked, true);
	assert.equal(parkedView.sessionCost, 0, "real zero spend was not preserved");
	await until("root final response", async () => rpc!.events.some(event => event.type === "agent_end" && event.isTerminal !== false) ? true : undefined);
	const rootSnapshot = await nativeSnapshot();
	const nativeRoot = rootSnapshot.agents.find(agent => agent.id === rootSnapshot.rootId)!;
	const rootView = (await bridgeCall("agents.list", { persisted: false })).agents.find((agent: AgentView) => agent.id === nativeRoot.id);
	assert(rootView);
	compareTelemetry(rootView, nativeRoot);
	assert.equal(rootView.model, `${provider}/${rootModel}`);
	assert.equal(rootView.effort, "low");
	assert.equal(rootView.requests, requests.filter(item => item.model === rootModel).length);
	assert.equal(parkedView.requests, requests.filter(item => item.model === childModel).length);
	const taskResults = nativeRoot.native!.messages.filter(message => message.role === "toolResult" && message.toolName === "task");
	assert(taskResults.some(message => (message.details?.usage?.output ?? 0) > 0), "root task result did not include independently observed child usage");
	assert.equal(requests.filter(item => item.model === childModel).length, 2, "child must perform tool request and final/yield request");
	assert.equal(requests.filter(item => item.model === rootModel).length, 2, "root must perform task request and final request");
	assert(requests.filter(item => item.model === childModel).every(item => item.effort === "high"), "child provider effort differs from native high preference");
	assert(requests.filter(item => item.model === rootModel).every(item => item.effort === "low"), "root provider effort differs from native low preference");
	assert(rootView.outputTokens !== null && rootView.outputTokens > requests.filter(item => item.model === rootModel).reduce((sum, item) => sum + item.output, 0), "root total should include child task-result usage without adding requests");
	assert.notEqual(rootView.contextWindow, parkedView.contextWindow, "root/child capacities are not independent");
	const before = transcriptStamp(parked.sessionFile);
	const rootBefore = transcriptStamp(nativeRoot.sessionFile);
	const requestCount = requests.length + labelRequests;
	for (let index = 0; index < 5; index++) {
		assert.deepEqual(await bridgeCall("agents.output", { agentId: child.id, limit: 500 }), persisted);
		const view = (await bridgeCall("agents.list", { persisted: index % 2 === 0 })).agents.find((agent: AgentView) => agent.id === child.id);
		assert.deepEqual(view, parkedView, "read changed parked telemetry/identity/lifecycle");
		const ref = (await nativeSnapshot()).agents.find(agent => agent.id === child.id)!;
		assert.equal(ref.identity, parked.identity);
		assert.equal(ref.native, null);
		assert.equal(ref.live, false);
		assert.equal(ref.status, "parked");
		await Bun.sleep(100);
	}
	assert.equal(requests.length + labelRequests, requestCount, "read-only parked access triggered model requests");
	assert.deepEqual(transcriptStamp(parked.sessionFile), before, "parked read mutated disk transcript/hash/stat");
	assert.deepEqual(transcriptStamp(nativeRoot.sessionFile), rootBefore, "child read mutated root transcript");
	assert(!failedProvider);
	console.log(JSON.stringify({ binary: version, bun: Bun.version, packageVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, childRequests: parkedView.requests, rootRequests: rootView.requests, childInput: parkedView.inputTokens, childOutput: parkedView.outputTokens, rootInput: rootView.inputTokens, rootOutput: rootView.outputTokens, childCost: parkedView.sessionCost, observedTokensPerSecond: Math.round((activeView.tokensPerSecond ?? 0) * 100) / 100, transcriptBytes: before.size, transcriptSha256: before.sha256, parkedReads: 5, spans: persisted.spans.length, extensionLoaded: true }));
	// Drain the compiled host's actual shutdown path before declaring success.
	for (const socket of clients) socket.destroy();
	subprocess.stdin.end();
	assert.equal(await bounded(subprocess.exited, "installed OMP clean shutdown", 15_000), 0);
	await Promise.all([stdoutDrain, stderrDrain]);
	console.log("CHILD SMOKE PASSED");
} catch (error) {
	console.error(`CHILD SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
	if (stderrDiagnostic) {
		const safe = stderrDiagnostic.replaceAll(bridgeToken, "[redacted]").replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]").replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^\s,}]+/gi, "$1[redacted]");
		console.error(`Installed OMP diagnostic (isolated credential-free environment):\n${safe}`);
	}
	process.exitCode = 1;
} finally {
	stop = true;
	finishChildStream.resolve();
	for (const socket of clients) socket.destroy();
	rpc?.fail(new Error("Smoke cleanup"));
	bridge?.fail(new Error("Smoke cleanup"));
	observer?.fail(new Error("Smoke cleanup"));
	if (subprocess) {
		try { subprocess.stdin.end(); } catch {}
		try { await bounded(subprocess.exited, "shutdown cleanup", 3000); }
		catch { subprocess.kill("SIGKILL"); await subprocess.exited; }
	}
	endpoint?.stop(true);
	rmSync(temporary, { recursive: true, force: true });
}

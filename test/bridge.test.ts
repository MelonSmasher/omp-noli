import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { RpcHostToolCallRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { installThreadControl } from "../src/thread-control";
import { type Bridge, type BridgeHost, BridgeError, startBridge } from "../src/bridge";
import { available, unavailable } from "../src/capabilities";
import { type AgentView, type Capabilities, CAPABILITY_NAMES, type CapabilityName, type CapabilityReason, type TurnResult } from "../src/protocol";
import { assertValidFrame } from "./schema";

const TOKEN = "t".repeat(32);

interface Frame {
	type?: string;
	id?: string | number | null;
	ok?: boolean;
	result?: unknown;
	error?: { code: string; message: string; capability?: string; reason?: string };
	event?: string;
	capabilities?: Capabilities;
    method?: string;
    params?: { sessionId: string };
}

function view(over: Partial<AgentView>): AgentView {
	return {
		id: "0-Child",
		name: "Child",
		kind: "sub",
		parentId: "Main",
		state: "running",
		live: true,
		streaming: true,
		definition: "task",
		activity: null,
		model: null,
		effort: null,
		requests: null,
		contextTokens: null,
		contextWindow: null,
		inputTokens: null,
		outputTokens: null,
		sessionCost: null,
		tokensPerSecond: null,
		createdAt: 1,
		lastActivity: 1,
		...over,
	};
}

function allAvailable(): Capabilities {
	return Object.fromEntries(CAPABILITY_NAMES.map(name => [name, available(name === "host.thread_read" ? "main-only-v2" : name === "host.thread_open" ? "main-only-v1" : name.startsWith("host.forge_") ? "session-v2" : "public", "test")])) as Capabilities; // Every key is filled from CAPABILITY_NAMES.
}

interface Harness {
	agents: AgentView[];
	/** Persisted children only surfaced by list({ includePersisted: true }). */
	persisted: AgentView[];
	session: string;
	calls: string[];
	listeners: Array<(a: AgentView) => void>;
	capabilityListeners: Array<(c: Capabilities) => void>;
	caps: Capabilities;
	host: BridgeHost;
}

const h: Harness = {
	agents: [],
	persisted: [],
	session: "sess-1",
	calls: [],
	listeners: [],
	capabilityListeners: [],
	caps: allAvailable(),
	host: {
		sessionId: () => h.session,
		capabilities: () => h.caps,
		refreshCapabilities: () => h.caps,
		onCapabilitiesChanged: listener => {
			h.capabilityListeners.push(listener);
			return () => {
				h.capabilityListeners = h.capabilityListeners.filter(x => x !== listener);
			};
		},
		list: async ({ includePersisted }) => {
			if (!includePersisted) return { agents: h.agents, discovery: { status: "not_requested", reason: null, detail: "", restored: [], pending: [] } };
			h.calls.push("discover");
			const restored = h.persisted.map(a => a.id);
			h.agents.push(...h.persisted);
			h.persisted = [];
			return { agents: h.agents, discovery: { status: restored.length ? "complete" : "none", reason: null, detail: "", restored, pending: [] } };
		},
		output: async ({ agentId }) => {
			h.calls.push(`output:${agentId}`);
			return { agentId, text: "prompt", spans: [{ id: "u1", role: "user", tool: null, created_ms: 1, start: 0, end: 6 }], nextOffset: null, revision: "sha256:test" };
		},
		subscribe: listener => {
			h.listeners.push(listener);
			return () => {
				h.listeners = h.listeners.filter(x => x !== listener);
			};
		},
		definitions: async () => {
			h.calls.push("definitions");
			return [{ name: "task", description: "General task", source: "bundled" }];
		},
		steer: async (id, text) => void h.calls.push(`steer:${id}:${text}`),
		followUp: async (id, text) => void h.calls.push(`followUp:${id}:${text}`),
		turn: async (id, text, definition) => {
			h.calls.push(`turn:${id}:${definition}:${text}`);
			return { output: "done", exitCode: 0, aborted: false };
		},
		killLive: async id => {
			h.calls.push(`killLive:${id}`);
			return true;
		},
		killParked: async id => {
			h.calls.push(`killParked:${id}`);
			return true;
		},
		work: () => ({
			settled: false,
			streaming: false,
			admittedSubmission: false,
			queued: 1,
			hiddenQueued: 1,
			pendingAsyncWork: true,
			jobs: [{ id: "bg_1", kind: "bash", label: "cargo test", startedAt: 1, agentId: null }],
			undeliveredResults: 0,
		}),
		cancelJob: async id => {
			h.calls.push(`cancelJob:${id}`);
			return id === "bg_1";
		},
		nativeControl: async (method, params) => {
			h.calls.push(`native:${method}:${JSON.stringify(params)}`);
			return { cancelled: true };
		},
	},
};

function disable(name: CapabilityName, reason: CapabilityReason = "tool_missing"): void {
	h.caps = { ...h.caps, [name]: unavailable("internal", reason, "probe failed") };
}
const defaultTurn = h.host.turn;

/** Test client. Handles partial writes: Bun's socket.write may accept only a prefix of a large buffer. */
class Client {
	#inbound = "";
	#pendingOut = Buffer.alloc(0);
	#waiters: Array<(frame: Frame) => void> = [];
	#queue: Frame[] = [];
	readonly closedPromise: Promise<void>;
	#markClosed!: () => void;
	#socket: Socket<undefined> | undefined;

	private constructor() {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closedPromise = promise;
		this.#markClosed = resolve;
	}

	static async connect(path: string): Promise<Client> {
		const client = new Client();
		client.#socket = await Bun.connect<undefined>({
			unix: path,
			socket: {
				data: (_s, chunk) => client.#feed(chunk.toString()),
				drain: () => client.#flush(),
				close: () => client.#markClosed(),
			},
		});
		return client;
	}

	#feed(text: string): void {
		this.#inbound += text;
		for (let i = this.#inbound.indexOf("\n"); i !== -1; i = this.#inbound.indexOf("\n")) {
			const frame: Frame = JSON.parse(this.#inbound.slice(0, i));
			// Every frame the bridge emits must satisfy the protocol schema.
			assertValidFrame(frame);
			this.#inbound = this.#inbound.slice(i + 1);
			const waiter = this.#waiters.shift();
			if (waiter) waiter(frame);
			else this.#queue.push(frame);
		}
	}

	#flush(): void {
		if (!this.#socket || this.#pendingOut.length === 0) return;
		const written = this.#socket.write(this.#pendingOut);
		this.#pendingOut = this.#pendingOut.subarray(written);
	}

	raw(text: string): void {
		this.#pendingOut = Buffer.concat([this.#pendingOut, Buffer.from(text)]);
		this.#flush();
	}

	next(): Promise<Frame> {
		const queued = this.#queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push(resolve);
		return promise;
	}

	call(frame: Record<string, unknown>): Promise<Frame> {
		this.raw(`${JSON.stringify(frame)}\n`);
		return this.next();
	}

	async disconnect(): Promise<void> {
		this.#socket?.end();
		await this.closedPromise;
	}
}

let dir: string;
let bridge: Bridge;

beforeEach(() => {
	h.agents = [];
	h.persisted = [];
	h.session = "sess-1";
	h.calls = [];
	h.listeners = [];
	h.capabilityListeners = [];
	h.caps = allAvailable();
	h.host.turn = defaultTurn;
	dir = mkdtempSync(join(tmpdir(), "noli-test-"));
	bridge = startBridge({ dir, token: TOKEN, host: h.host });
});

test("agent control authentication is revoked on adoption and disconnect", async () => {
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(false);
	const client = await Client.connect(bridge.socketPath);
	await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(true);
	const admittedGeneration = bridge.authenticatedGeneration("sess-1");
	expect(typeof admittedGeneration).toBe("number");
	expect(bridge.hasAuthenticatedSession("sess-2")).toBe(false);
	bridge.invalidateAuthentication();
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(false);
	expect(bridge.authenticatedGeneration("sess-1")).toBeUndefined();
	const replacement = await Client.connect(bridge.socketPath);
	expect((await replacement.call({ id: 2, method: "hello", params: { token: TOKEN } })).ok).toBe(true);
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(true);
	expect(bridge.authenticatedGeneration("sess-1")).not.toBe(admittedGeneration);
    expect((await call(client, "session.adopt", { sessionId: "sess-1" })).ok).toBe(true);
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(true);
	bridge.close();
	await replacement.closedPromise;
	expect(bridge.hasAuthenticatedSession("sess-1")).toBe(false);
});

/** A guarded consumer call uses real socket authentication, not a capability-only mock. */
function forgeConsumer() {
	let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
	const pi = {
		on(name: string, handler: unknown) { if (name === "tool_call") call = handler as typeof call; if (name === "tool_result") result = handler as typeof result; },
		getAllTools: () => [{ name: "noli_forge_resource", sourceInfo: { source: "sdk" } }],
	} as unknown as ExtensionAPI;
	installThreadControl(pi, sessionId => bridge.authenticatedGeneration(sessionId));
	const ctx = { agent: { kind: "main" }, sessionManager: { getSessionId: () => h.session } } as unknown as ExtensionContext;
	const request: ToolCallEvent = { type: "tool_call", toolName: "noli_forge_resource", toolCallId: "pending-forge-read", input: { action: "resolve_review", number: "42" } };
	const reply: ToolResultEvent = { ...request, type: "tool_result", content: [{ type: "text", text: "bounded current provider content" }], details: { snapshot: "current account snapshot" }, isError: false };
	let admittedInput = request.input;
	return {
		admit: () => {
			const admission = call(request, ctx);
			if (admission?.input) admittedInput = admission.input;
			return admission;
		},
		reply: (isError = false) => result({ ...reply, input: admittedInput, isError }, ctx),
	};
}

test.each([false, true])("review forge reads survive unrelated secondary hello and disconnect, preconnected=%s", async preconnected => {
	const waiting = preconnected ? await Client.connect(bridge.socketPath) : undefined;
	const owner = await Client.connect(bridge.socketPath);
	await owner.call({ id: 1, method: "hello", params: { token: TOKEN } });
	const consumer = forgeConsumer();
	expect(consumer.admit()).toHaveProperty("input");
	const ownerGeneration = bridge.authenticatedGeneration(h.session);
	const secondary = waiting ?? await Client.connect(bridge.socketPath);
	await secondary.call({ id: 2, method: "hello", params: { token: TOKEN } });
	expect(bridge.authenticatedGeneration(h.session)).toBe(ownerGeneration);
	expect(consumer.reply()).toBeUndefined();
	expect(consumer.admit()).toHaveProperty("input");
	await secondary.disconnect();
	await owner.call({ id: 3, method: "capabilities.get", sessionId: h.session });
	expect(bridge.authenticatedGeneration(h.session)).toBe(ownerGeneration);
	expect(consumer.reply()).toBeUndefined();
});

test("review forge owner disconnect revokes success and error despite a remaining authenticated socket", async () => {
	const owner = await Client.connect(bridge.socketPath);
	await owner.call({ id: 1, method: "hello", params: { token: TOKEN } });
	const secondary = await Client.connect(bridge.socketPath);
	await secondary.call({ id: 2, method: "hello", params: { token: TOKEN } });
	const consumer = forgeConsumer();
	expect(consumer.admit()).toHaveProperty("input");
	const ownerGeneration = bridge.authenticatedGeneration(h.session);
	await owner.disconnect();
	await secondary.call({ id: 3, method: "capabilities.get", sessionId: h.session });
	expect(bridge.hasAuthenticatedSession(h.session)).toBe(true);
	expect(bridge.authenticatedGeneration(h.session)).not.toBe(ownerGeneration);
	const stale = consumer.reply();
	expect(stale?.isError).toBe(true); expect(stale?.details).toEqual({});
	expect(consumer.admit()).toHaveProperty("input");
	bridge.invalidateAuthentication();
	await secondary.call({ id: 4, method: "session.adopt", params: { sessionId: h.session } });
	expect(bridge.hasAuthenticatedSession(h.session)).toBe(true);
	const staleError = consumer.reply(true);
	expect(staleError?.isError).toBe(true); expect(staleError?.details).toEqual({});
	expect(JSON.stringify(staleError)).not.toContain("bounded current provider content");
});

// The socket authenticates the guard; proposal bytes go through the SDK stdout
// encoder/decoder. Replies here are transport fixtures, not native journal proof.
test("forge SDK transport rejects oversized serialized proposals without losing the authenticated connection", async () => {
	const client = await authed();
	const generation = bridge.authenticatedGeneration(h.session);
	let admit!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
	installThreadControl({
		on(name: string, handler: unknown) {
			if (name === "tool_call") admit = handler as typeof admit;
			if (name === "tool_result") result = handler as typeof result;
		},
		getAllTools: () => [{ name: "noli_forge_write_v1", sourceInfo: { source: "sdk" } }],
	} as unknown as ExtensionAPI, session => bridge.authenticatedGeneration(session));
	const ctx = { agent: { kind: "main" }, sessionManager: { getSessionId: () => h.session } } as unknown as ExtensionContext;
	const encoder = new RpcFrameEncoder();
	encoder.setProtocolVersion(2);
	const decoder = new RpcFrameDecoder();
	let outputCalls = 0;
	let physicalFrames = 0;
	let delivered: RpcHostToolCallRequest | undefined;
	let overflow: Record<string, unknown> | undefined;
	const sdkBridge = new RpcHostToolBridge(frame => {
		outputCalls++;
		for (const line of encoder.encodeFrames(frame)) {
			physicalFrames++;
			expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			const decoded = decoder.push(JSON.parse(line)) as Record<string, unknown> | undefined;
			if (decoded?.type === "host_tool_call") delivered = decoded as unknown as RpcHostToolCallRequest;
			if (decoded?.type === "rpc_frame_error") overflow = decoded;
		}
	});
	const forwardedCall = (): RpcHostToolCallRequest => {
		if (!delivered) throw new Error("SDK did not deliver the host call");
		return delivered;
	};
	const [tool] = sdkBridge.setTools([{ name: "noli_forge_write_v1", label: "Propose forge write", description: "Transport fixture", parameters: { type: "object" } }]);
	const toolCallId = 'bounds-é-"\\';
	const proposal = (body: string) => ({
		target: { origin: "github", account: "selected", repository: { provider: "github", repository_id: "123", node_id: "R_123" },
			kind: "issue", resource: { type: "github", id: "456", node_id: "I_456", number: "7" }, web_url: "https://github.com/owner/repository/issues/7" },
		payload: { kind: "issue", mutation: { action: "comment", body } },
		precondition: { kind: "updated_at", value: "2026-10-12T00:00:00Z" },
	});
	const envelope = (input: Record<string, unknown>) => ({ type: "host_tool_call", id: "0000000000000000", toolCallId, toolName: tool!.name, arguments: input });
	const overhead = Buffer.byteLength(JSON.stringify(envelope(proposal(""))), "utf8");
	const atom = 'é\n"\\';
	const atomBytes = Buffer.byteLength(JSON.stringify(atom), "utf8") - 2;
	const content = [{ type: "text" as const, text: "Transport fixture pending admission" }];
	const details = { status: "pending_approval", operation_id: "transport-operation" };
	for (const delta of [-1, 0, 1]) {
		const bodyBytes = MAX_RPC_REASSEMBLED_BYTES + delta - overhead;
		const input = proposal(atom.repeat(Math.floor(bodyBytes / atomBytes)) + "x".repeat(bodyBytes % atomBytes));
		expect(Buffer.byteLength(JSON.stringify(envelope(input)), "utf8")).toBe(MAX_RPC_REASSEMBLED_BYTES + delta);
		const event: ToolCallEvent = { type: "tool_call", toolName: tool!.name, toolCallId, input };
		if (delta === 1) {
			// Positive control: the SDK drops an unguarded oversize call without an
			// ID-bearing result. Abort releases its otherwise unresolved pending call.
			const abort = new AbortController();
			const unguarded = tool!.execute(toolCallId, input, abort.signal);
			let settled = false;
			void unguarded.then(() => { settled = true; }, () => { settled = true; });
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(overflow?.originalType).toBe("host_tool_call");
			expect(overflow).not.toHaveProperty("id");
			expect(delivered).toBeUndefined();
			abort.abort();
			await expect(unguarded).rejects.toThrow(/aborted/);
			const previousCalls = outputCalls;
			expect(admit(event, ctx)?.block).toBe(true);
			expect(outputCalls).toBe(previousCalls);
		} else {
			const admission = admit(event, ctx);
			expect(admission?.input).toBeDefined();
			expect(admission?.input).not.toBe(input);
			const pending = tool!.execute(toolCallId, admission!.input!);
			expect(physicalFrames).toBeGreaterThan(1);
			expect(overflow).toBeUndefined();
			const forwarded = forwardedCall();
			expect(forwarded.toolCallId).toBe(toolCallId);
			expect(forwarded.id).toMatch(/^[0-9a-f]{16}$/);
			const payload = forwarded.arguments.payload as { mutation: { body: string } };
			expect(payload.mutation.body.length).toBe(input.payload.mutation.body.length);
			expect(payload.mutation.body === input.payload.mutation.body).toBe(true);
			expect(sdkBridge.handleResult({ type: "host_tool_result", id: forwarded.id, result: { content, details } })).toBe(true);
			const reply = await pending;
			expect(result({ ...event, input: admission!.input!, type: "tool_result", ...reply, isError: false }, ctx)).toBeUndefined();
		}
		delivered = undefined;
		physicalFrames = 0;
	}
	// No reconnect, reauthentication or bridge replacement after the rejection.
	expect((await call(client, "capabilities.get", { hostTools: true })).ok).toBe(true);
	expect(bridge.authenticatedGeneration(h.session)).toBe(generation);
	const event: ToolCallEvent = { type: "tool_call", toolName: tool!.name, toolCallId: "subsequent-valid", input: proposal("Small valid request") };
	const admission = admit(event, ctx);
	expect(admission?.input).toBeDefined();
	const pending = tool!.execute(event.toolCallId, admission!.input!);
	const forwarded = forwardedCall();
	expect(forwarded.toolCallId).toBe(event.toolCallId);
	expect(sdkBridge.handleResult({ type: "host_tool_result", id: forwarded.id, result: { content, details } })).toBe(true);
	const reply = await pending;
	expect(result({ ...event, input: admission!.input!, type: "tool_result", ...reply, isError: false }, ctx)).toBeUndefined();
}, 60_000);

afterEach(() => {
	bridge.close();
	rmSync(dir, { recursive: true, force: true });
});

async function authed(): Promise<Client> {
	const client = await Client.connect(bridge.socketPath);
	const hello = await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
	expect(hello.ok).toBe(true);
	return client;
}

test("authenticated id-less response without a pending bind fails safely", async () => {
	const client = await authed();
	client.raw(`${JSON.stringify({ type: "response", ok: true })}\n`);
	expect((await client.next()).error?.code).toBe("bad_request");
	expect((await call(client, "capabilities.get")).ok).toBe(true);
});

function call(client: Client, method: string, params: Record<string, unknown> = {}, sessionId = h.session): Promise<Frame> {
	return client.call({ id: 2, sessionId, method, params });
}

describe("supplemental native authentication", () => {
	test("native calls require hello and current session", async () => {
		const unauthenticated = await Client.connect(bridge.socketPath);
		expect((await call(unauthenticated, "tree.navigate", { targetId: "e1" })).error?.code).toBe("unauthorized");
		const client = await authed();
		expect((await call(client, "tree.navigate", { targetId: "e1" }, "other")).error?.code).toBe("stale_session");
		expect(h.calls).toEqual([]);
		const result = await call(client, "tree.navigate", { targetId: "e1" });
		expect(result.result).toEqual({ cancelled: true });
		expect(h.calls).toEqual(['native:tree.navigate:{"targetId":"e1"}']);
		h.session = "replacement";
		expect((await call(client, "memory.status")).error?.code).toBe("stale_session");
		expect(h.calls).toHaveLength(1);
	});
	test("disabled and unsupported methods never reach host", async () => {
		const client = await authed();
		disable("goal.budget", "export_missing");
		expect((await call(client, "goal.budget", { tokenBudget: 10 })).error?.code).toBe("capability_unavailable");
		for (const method of ["plan.propose", "plan.approve", "memory.clear", "mcp.control", "lsp.control", "dap.control", "input.secret"]) expect((await call(client, method)).error?.code).toBe("capability_unavailable");
		expect(h.calls).toEqual([]);
	});
	test("oversized native result returns bounded failure without fake acknowledgement", async () => {
		const original = h.host.nativeControl;
		try {
			h.host.nativeControl = async () => ({ cancelled: false, editorText: "x".repeat(2 * 1024 * 1024) });
			const client = await authed();
			const response = await call(client, "tree.navigate", { targetId: "e" });
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("frame_too_large");
			expect(response.error?.message).toContain("do not replay");
		} finally { h.host.nativeControl = original; }
	});
});

describe("authentication", () => {
	test("wrong token is rejected and the connection is closed", async () => {
		const client = await Client.connect(bridge.socketPath);
		const reply = await client.call({ id: 1, method: "hello", params: { token: "nope" } });
		expect(reply.ok).toBe(false);
		expect(reply.error?.code).toBe("unauthorized");
		await client.closedPromise;
	});

	test("a method before hello never reaches the host", async () => {
		h.agents = [view({})];
		const client = await Client.connect(bridge.socketPath);
		const reply = await client.call({ id: 1, sessionId: h.session, method: "agents.kill", params: { agentId: "0-Child" } });
		expect(reply.ok).toBe(false);
		expect(h.calls).toEqual([]);
	});

	test("oversized unauthenticated input closes the connection", async () => {
		const client = await Client.connect(bridge.socketPath);
		client.raw("x".repeat(8192));
		const reply = await client.next();
		expect(reply.error?.code).toBe("frame_too_large");
		await client.closedPromise;
	});

	test.each([["a number", "42"], ["an array", "[1,2]"], ["null", "null"], ["a string", '"hello"']])(
		"%s before hello is rejected and the connection is closed",
		async (_label, json) => {
			const client = await Client.connect(bridge.socketPath);
			client.raw(`${json}\n`);
			expect((await client.next()).error?.code).toBe("bad_frame");
			await client.closedPromise;
		},
	);

	test("socket and directory are private to the owner", () => {
		expect(statSync(bridge.socketPath).mode & 0o077).toBe(0);
		expect(statSync(dir).mode & 0o077).toBe(0);
	});

	test("refuses a group/other-accessible directory", () => {
		const loose = mkdtempSync(join(tmpdir(), "noli-loose-"));
		try {
			chmodSync(loose, 0o755);
			expect(() => startBridge({ dir: loose, token: TOKEN, host: h.host })).toThrow(/must not be accessible/);
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
	});
});

describe("session scope", () => {
	test("a request carrying a stale session id is rejected without side effects", async () => {
		h.agents = [view({})];
		const client = await authed();
		h.session = "sess-2";
		const reply = await call(client, "agents.steer", { agentId: "0-Child", text: "hi" }, "sess-1");
		expect(reply.error?.code).toBe("stale_session");
		expect(h.calls).toEqual([]);
	});

	test("a request with no session id is rejected", async () => {
		h.agents = [view({})];
		const client = await authed();
		const reply = await client.call({ id: 3, method: "agents.list" });
		expect(reply.error?.code).toBe("stale_session");
	});
});

describe("control semantics", () => {
	test("main and advisor agents are never controllable", async () => {
		h.agents = [view({ id: "Main", kind: "main" }), view({ id: "adv", kind: "advisor" })];
		const client = await authed();
		for (const id of ["Main", "adv"]) {
			for (const method of ["agents.steer", "agents.followUp", "agents.turn", "agents.kill"]) {
				const reply = await call(client, method, { agentId: id, text: "x" });
				expect(reply.error?.code).toBe("forbidden_kind");
			}
		}
		expect(h.calls).toEqual([]);
	});

	test("unknown agent id is reported, not coerced", async () => {
		const client = await authed();
		const reply = await call(client, "agents.kill", { agentId: "ghost" });
		expect(reply.error?.code).toBe("unknown_agent");
	});

	test("live agents accept steer and followUp", async () => {
		h.agents = [view({})];
		const client = await authed();
		expect((await call(client, "agents.steer", { agentId: "0-Child", text: "a" })).ok).toBe(true);
		expect((await call(client, "agents.followUp", { agentId: "0-Child", text: "b" })).ok).toBe(true);
		expect(h.calls).toEqual(["steer:0-Child:a", "followUp:0-Child:b"]);
	});

	test("steer/followUp on a parked agent point at agents.turn instead of silently reviving", async () => {
		h.agents = [view({ state: "parked", live: false, streaming: false })];
		const client = await authed();
		for (const method of ["agents.steer", "agents.followUp"]) {
			const reply = await call(client, method, { agentId: "0-Child", text: "x" });
			expect(reply.error?.code).toBe("parked");
		}
		expect(h.calls).toEqual([]);
	});

	test("agents.turn revives a parked agent using its recorded definition", async () => {
		h.agents = [view({ state: "parked", live: false, streaming: false })];
		const client = await authed();
		const reply = await call(client, "agents.turn", { agentId: "0-Child", text: "continue" });
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ output: "done", exitCode: 0, aborted: false });
		expect(h.calls).toEqual(["turn:0-Child:task:continue"]);
	});

	test("an explicit params.agent overrides the recorded definition", async () => {
		h.agents = [view({ state: "parked", live: false, streaming: false })];
		const client = await authed();
		expect((await call(client, "agents.turn", { agentId: "0-Child", agent: "explore", text: "go" })).ok).toBe(true);
		expect(h.calls).toEqual(["turn:0-Child:explore:go"]);
	});

	test("agents.turn without any known definition fails with definition_required", async () => {
		h.agents = [view({ state: "parked", live: false, streaming: false, definition: null })];
		const client = await authed();
		expect((await call(client, "agents.turn", { agentId: "0-Child", text: "go" })).error?.code).toBe("definition_required");
		expect(h.calls).toEqual([]);
	});

	test("a second concurrent turn on the same agent is refused, and the lock is released afterwards", async () => {
		h.agents = [view({ state: "idle", streaming: false })];
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		h.host.turn = async (): Promise<TurnResult> => {
			started.resolve();
			await gate.promise;
			return { output: "ok", exitCode: 0, aborted: false };
		};
		const client = await authed();
		client.raw(`${JSON.stringify({ id: 10, sessionId: h.session, method: "agents.turn", params: { agentId: "0-Child", text: "a" } })}\n`);
		await started.promise;
		const second = await call(client, "agents.turn", { agentId: "0-Child", text: "b" });
		expect(second.error?.code).toBe("busy");
		gate.resolve();
		expect((await client.next()).ok).toBe(true);
		h.host.turn = defaultTurn;
		expect((await call(client, "agents.turn", { agentId: "0-Child", text: "c" })).ok).toBe(true);
	});

	test("kill on an already-terminated agent is not repeated", async () => {
		h.agents = [view({ id: "a", state: "terminated", live: false })];
		const client = await authed();
		expect((await call(client, "agents.kill", { agentId: "a" })).error?.code).toBe("already_terminal");
		expect(h.calls).toEqual([]);
	});

	test("kill routes live agents to killLive and parked agents to killParked, never reviving", async () => {
		h.agents = [view({ id: "live" }), view({ id: "parked", state: "parked", live: false, streaming: false })];
		const client = await authed();
		expect((await call(client, "agents.kill", { agentId: "live" })).result).toEqual({ killed: true, mode: "live" });
		expect((await call(client, "agents.kill", { agentId: "parked" })).result).toEqual({ killed: true, mode: "parked" });
		expect(h.calls).toEqual(["killLive:live", "killParked:parked"]);
	});

	test("parked kill is refused while a bridge turn is reviving that agent", async () => {
		h.agents = [view({ state: "parked", live: false, streaming: false })];
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		h.host.turn = async (): Promise<TurnResult> => {
			started.resolve();
			await gate.promise;
			return { output: "ok", exitCode: 0, aborted: false };
		};
		const client = await authed();
		client.raw(`${JSON.stringify({ id: 10, sessionId: h.session, method: "agents.turn", params: { agentId: "0-Child", text: "a" } })}\n`);
		await started.promise;
		expect((await call(client, "agents.kill", { agentId: "0-Child" })).error?.code).toBe("busy");
		gate.resolve();
		await client.next();
		expect(h.calls.some(c => c.startsWith("kill"))).toBe(false);
	});

	test("text over the size cap is rejected after a large frame is fully received", async () => {
		h.agents = [view({})];
		const client = await authed();
		const reply = await call(client, "agents.steer", { agentId: "0-Child", text: "x".repeat(300 * 1024) });
		expect(reply.error?.code).toBe("bad_request");
		expect(h.calls).toEqual([]);
	});

	test("a frame over the hard cap closes the connection", async () => {
		const client = await authed();
		client.raw("y".repeat(1024 * 1024 + 16));
		const reply = await client.next();
		expect(reply.error?.code).toBe("frame_too_large");
		await client.closedPromise;
	});
});

/** Narrow a socket response before inspecting negotiated capability fields. */
function responseCapabilities(frame: Frame): Record<string, unknown> {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("capabilities" in result) || !result.capabilities || typeof result.capabilities !== "object") throw new Error("Missing capability response");
	return Object.fromEntries(Object.entries(result.capabilities));
}

describe("capabilities", () => {
	test("hello and capabilities.get advertise the host capability set", async () => {
		disable("agents.kill.parked");
		const client = await Client.connect(bridge.socketPath);
		const hello = await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
		const advertised = hello.result as { protocol: number; capabilities: Capabilities };
		expect(advertised.protocol).toBe(1);
		expect(advertised.capabilities["agents.kill.parked"]).toEqual({ available: false, api: "internal", reason: "tool_missing", detail: "probe failed" });
		expect(advertised.capabilities["agents.kill.live"].available).toBe(true);
	});

	test("attachment policy is returned only on explicit authenticated bootstrap requests", async () => {
		h.caps["host.attach_file"] = available("main-only-v1", "trusted main-agent guard");
		const client = await Client.connect(bridge.socketPath);
		const hello = await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
		expect(responseCapabilities(hello)).not.toHaveProperty("host.attach_file");
		const legacy = await call(client, "capabilities.get");
		expect(responseCapabilities(legacy)).not.toHaveProperty("host.attach_file");
		const negotiated = await call(client, "capabilities.get", { hostTools: true });
		expect(responseCapabilities(negotiated)["host.attach_file"]).toEqual(h.caps["host.attach_file"]);
		for (const listener of h.capabilityListeners) listener(h.caps);
		expect((await client.next()).capabilities).not.toHaveProperty("host.attach_file");
	});

	test.each(["host.forge_resource", "host.forge_read", "host.forge_write"] as const)("%s policy requires explicit authenticated bootstrap negotiation", async capability => {
		h.caps[capability] = available("session-v2", "owning-main forge guard");
		const client = await Client.connect(bridge.socketPath);
		const hello = await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
		expect(responseCapabilities(hello)).not.toHaveProperty(capability);
		expect(responseCapabilities(await call(client, "capabilities.get"))).not.toHaveProperty(capability);
		const negotiated = await call(client, "capabilities.get", { hostTools: true });
		expect(responseCapabilities(negotiated)[capability]).toEqual({ available: true, api: "session-v2", detail: "owning-main forge guard" });
		for (const listener of h.capabilityListeners) listener(h.caps);
		expect((await client.next()).capabilities).not.toHaveProperty(capability);
	});

	test("parked kill is closed off when its capability is unavailable; live kill still works", async () => {
		disable("agents.kill.parked", "hook_changed");
		h.agents = [view({ id: "live" }), view({ id: "parked", state: "parked", live: false, streaming: false })];
		const client = await authed();
		const refused = await call(client, "agents.kill", { agentId: "parked" });
		expect(refused.error).toMatchObject({ code: "capability_unavailable", capability: "agents.kill.parked", reason: "hook_changed" });
		expect((await call(client, "agents.kill", { agentId: "live" })).ok).toBe(true);
		expect(h.calls).toEqual(["killLive:live"]);
	});

	test("definitions.list returns the host definitions and is gated", async () => {
		const client = await authed();
		expect((await call(client, "definitions.list")).result).toEqual({ definitions: [{ name: "task", description: "General task", source: "bundled" }] });
		disable("definitions.list", "export_missing");
		expect((await call(client, "definitions.list")).error).toMatchObject({ code: "capability_unavailable", reason: "export_missing" });
		expect(h.calls).toEqual(["definitions"]);
	});

	test("work.get reports settlement state and work.cancel cancels by job id, each gated", async () => {
		const client = await authed();
		expect((await call(client, "work.get")).result).toMatchObject({ settled: false, hiddenQueued: 1, jobs: [{ id: "bg_1", kind: "bash" }] });
		expect((await call(client, "work.cancel", { jobId: "bg_1" })).result).toEqual({ cancelled: true });
		expect((await call(client, "work.cancel", { jobId: "gone" })).result).toEqual({ cancelled: false });
		expect((await call(client, "work.cancel", {})).error).toMatchObject({ code: "bad_request" });
		disable("work.cancel", "hook_changed");
		expect((await call(client, "work.cancel", { jobId: "bg_1" })).error).toMatchObject({ code: "capability_unavailable", capability: "work.cancel" });
		disable("work.get", "not_ready");
		expect((await call(client, "work.get")).error).toMatchObject({ code: "capability_unavailable", capability: "work.get" });
		expect(h.calls).toEqual(["cancelJob:bg_1", "cancelJob:gone"]);
	});

	test("agents.list includes persisted children by default when discovery is available", async () => {
		h.agents = [view({ id: "Main", kind: "main" })];
		h.persisted = [view({ id: "Old", state: "parked", live: false, streaming: false })];
		const client = await authed();
		const reply = await call(client, "agents.list");
		const result = reply.result as { agents: AgentView[]; discovery: { status: string; restored: string[] } };
		expect(result.discovery).toMatchObject({ status: "complete", restored: ["Old"] });
		expect(result.agents.map(a => a.id)).toEqual(["Main", "Old"]);
	});

	test("without persisted discovery, agents.list still lists in-process agents and says so", async () => {
		disable("agents.list.persisted");
		h.agents = [view({ id: "Main", kind: "main" })];
		h.persisted = [view({ id: "Old", state: "parked", live: false })];
		const client = await authed();
		const reply = await call(client, "agents.list");
		expect(reply.result).toMatchObject({ agents: [h.agents[0]], discovery: { status: "not_requested" } });
		expect(h.calls).toEqual([]);
		expect((await call(client, "agents.list", { persisted: true })).error?.code).toBe("capability_unavailable");
	});

	test("persisted: false skips discovery even when it is available", async () => {
		h.persisted = [view({ id: "Old", state: "parked", live: false })];
		const client = await authed();
		expect((await call(client, "agents.list", { persisted: false })).result).toMatchObject({ agents: [], discovery: { status: "not_requested" } });
		expect(h.calls).toEqual([]);
	});

	test("every gated method refuses without touching the host when its capability is down", async () => {
		h.agents = [view({})];
		for (const name of ["agents.steer", "agents.followUp", "agents.turn", "agents.list"] as const) disable(name);
		const client = await authed();
		for (const method of ["agents.steer", "agents.followUp", "agents.turn", "agents.list"]) {
			expect((await call(client, method, { agentId: "0-Child", text: "x" })).error?.code).toBe("capability_unavailable");
		}
		expect(h.calls).toEqual([]);
	});

	test("capability changes are pushed to authenticated clients", async () => {
		const client = await authed();
		disable("agents.list.persisted");
		for (const listener of h.capabilityListeners) listener(h.caps);
		const frame = await client.next();
		expect(frame.event).toBe("capabilities.changed");
		expect(frame.capabilities?.["agents.list.persisted"].available).toBe(false);
	});
});

describe("events and shutdown", () => {
	test("registry changes reach authenticated clients only", async () => {
		const quiet = await Client.connect(bridge.socketPath);
		const client = await authed();
		for (const listener of h.listeners) listener(view({ state: "idle" }));
		expect((await client.next()).event).toBe("agent.changed");
		// Ordering: any event written to `quiet` would precede this reply on the same stream.
		const first = await quiet.call({ id: 1, method: "hello", params: { token: "bad" } });
		expect(first.event).toBeUndefined();
		expect(first.error?.code).toBe("unauthorized");
	});

    test.each(["session switch", "same-session adoption"])("%s revokes events until authenticated transport adopts", async reason => {
		const old = await authed();
		if (reason === "session switch") h.session = "sess-2";
		bridge.invalidateAuthentication();
        for (const listener of h.listeners) listener(view({ id: "not-adopted", state: "idle" }));
        expect((await call(old, "capabilities.get")).error?.code).toBe("stale_session");
        expect((await call(old, "session.adopt", { sessionId: h.session })).ok).toBe(true);
        const current = old;
		for (const listener of h.listeners) listener(view({ id: "new-session-child", state: "idle" }));
		for (const listener of h.capabilityListeners) listener(h.caps);
		expect((await current.next()).event).toBe("agent.changed");
		expect((await current.next()).event).toBe("capabilities.changed");
        expect((await call(current, "capabilities.get")).ok).toBe(true);
	});

	test("close removes the socket and unsubscribes", () => {
		const path = bridge.socketPath;
		bridge.close();
		expect(() => statSync(path)).toThrow();
		expect(h.listeners.length).toBe(0);
		expect(h.capabilityListeners.length).toBe(0);
		bridge = startBridge({ dir, token: TOKEN, host: h.host });
	});
});

describe("child output requests", () => {
	test("revoked connections cannot read a newly adopted session even with its ID", async () => {
		const client = await authed();
		h.session = "sess-2";
		bridge.invalidateAuthentication();
		const reply = await call(client, "agents.output", { agentId: "C" });
		expect(reply.error?.code).toBe("stale_session");
		expect(h.calls).toEqual([]);
	});
	test.each([{ offset: -1 }, { offset: 1.5 }, { offset: null }, { offset: "2" }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: null }, { limit: "2" }, { revision: "" }, { revision: 7 }, { revision: null }, { revision: "r".repeat(257) }])("rejects malformed pagination %j before any host read", async params => {
		const client = await authed();
		const reply = await call(client, "agents.output", { agentId: "C", ...params });
		expect(reply.error?.code).toBe("bad_request");
		expect(h.calls).toEqual([]);
	});
	test("an absent child is a distinct, schema-valid error", async () => {
		const client = await authed();
		const original = h.host.output;
		h.host.output = async ({ agentId }) => { throw new BridgeError("agent_absent", `agent "${agentId}" is no longer registered in this OMP process`); };
		try {
			const reply = await call(client, "agents.output", { agentId: "C" });
			expect(reply.error).toEqual({ code: "agent_absent", message: 'agent "C" is no longer registered in this OMP process' });
		} finally { h.host.output = original; }
	});
	test("a frozen read forwards its revision, and an expired one is a distinct, schema-valid error", async () => {
		const client = await authed();
		const original = h.host.output;
		const seen: (string | undefined)[] = [];
		h.host.output = async ({ revision }) => { seen.push(revision); throw new BridgeError("snapshot_expired", "the requested transcript revision is no longer retained; read the newest page again"); };
		try {
			const reply = await call(client, "agents.output", { agentId: "C", offset: 3, revision: "sha256:abc" });
			expect(reply.error).toEqual({ code: "snapshot_expired", message: "the requested transcript revision is no longer retained; read the newest page again" });
			expect(seen).toEqual(["sha256:abc"]);
		} finally { h.host.output = original; }
	});
	test("output is explicitly gated when native API is missing", async () => {
		const client = await authed();
		disable("agents.output", "export_missing");
		const reply = await call(client, "agents.output", { agentId: "C" });
		expect(reply.error).toMatchObject({ code: "capability_unavailable", capability: "agents.output", reason: "export_missing" });
		expect(h.calls).toEqual([]);
	});
});

test("gateway binds after hello, refreshes on adoption and revokes on close", async () => {
    bridge.close();
    const credentials: string[] = [];
    let revocations = 0;
    bridge = startBridge({ dir, token: TOKEN, host: h.host, gateway: {
        bind: value => { credentials.push(value.token); }, revoke: () => { revocations++; },
    } });
    const client = await authed();
    const request = await client.next();
    expect(request.method).toBe("gateway.bind");
    expect(request.params).toEqual({ sessionId: "sess-1" });
    client.raw(`${JSON.stringify({ type: "response", id: request.id, ok: true, result: { token: "a".repeat(43), expires_ms: Date.now() + 3_600_000 } })}\n`);
    expect((await call(client, "gateway.ready")).result).toEqual({ bound: true });
    expect(credentials).toEqual(["a".repeat(43)]);
    h.session = "sess-2";
    bridge.invalidateAuthentication();
    client.raw(`${JSON.stringify({ id: 3, method: "session.adopt", sessionId: "sess-1", params: { sessionId: "sess-2" } })}\n`);
    const rebound = await client.next();
    expect(rebound.params).toEqual({ sessionId: "sess-2" });
    client.raw(`${JSON.stringify({ type: "response", id: rebound.id, ok: true, result: { token: "b".repeat(43), expires_ms: Date.now() + 3_600_000 } })}\n`);
    expect((await client.next()).result).toEqual({ bound: true });
    expect(credentials).toEqual(["a".repeat(43), "b".repeat(43)]);
    const before = revocations;
    bridge.close();
    expect(revocations).toBeGreaterThan(before);
});

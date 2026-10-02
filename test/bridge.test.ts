import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { type Bridge, type BridgeHost, startBridge } from "../src/bridge";
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
		createdAt: 1,
		lastActivity: 1,
		...over,
	};
}

function allAvailable(): Capabilities {
	return Object.fromEntries(CAPABILITY_NAMES.map(name => [name, available("public", "test")])) as Capabilities; // Every key is filled from CAPABILITY_NAMES.
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

function call(client: Client, method: string, params: Record<string, unknown> = {}, sessionId = h.session): Promise<Frame> {
	return client.call({ id: 2, sessionId, method, params });
}

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

describe("capabilities", () => {
	test("hello and capabilities.get advertise the host capability set", async () => {
		disable("agents.kill.parked");
		const client = await Client.connect(bridge.socketPath);
		const hello = await client.call({ id: 1, method: "hello", params: { token: TOKEN } });
		const advertised = hello.result as { protocol: number; capabilities: Capabilities };
		expect(advertised.protocol).toBe(1);
		expect(advertised.capabilities["agents.kill.parked"]).toEqual({ available: false, api: "internal", reason: "tool_missing", detail: "probe failed" });
		expect(advertised.capabilities["agents.kill.live"].available).toBe(true);
		const got = await call(client, "capabilities.get");
		expect(got.result).toEqual({ capabilities: h.caps });
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

	test("close removes the socket and unsubscribes", () => {
		const path = bridge.socketPath;
		bridge.close();
		expect(() => statSync(path)).toThrow();
		expect(h.listeners.length).toBe(0);
		expect(h.capabilityListeners.length).toBe(0);
		bridge = startBridge({ dir, token: TOKEN, host: h.host });
	});
});

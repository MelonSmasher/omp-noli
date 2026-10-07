import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync, truncateSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ListResult } from "../src/protocol";
import { createOmpHost, type OmpHost } from "../src/omp-host";

/**
 * Fake OMP host. Mirrors the upstream behaviors the adapter depends on:
 * - the read tool's history:// lookup runs a per-root roster scan that registers
 *   only complete transcripts (header-only stubs are skipped, persisted-agents.ts),
 * - the scan tags the registry with a per-root latch map keyed by root session file,
 * - the task tool's ToolSession exposes agentLifecycle().
 */
interface FakeRef {
	id: string;
	displayName: string;
	kind: string;
	parentId?: string;
	status: string;
	session: unknown;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	history?: { agent?: string };
}

const LATCHES = Symbol("persistedRosterLatches");

class FakeRegistry {
	refs = new Map<string, FakeRef>();
	[LATCHES]?: Map<string, unknown>;
	listeners = new Set<(event: { type: string; ref: FakeRef }) => void>();
	get(id: string) {
		return this.refs.get(id);
	}
	list() {
		return [...this.refs.values()];
	}
	onChange(listener: (event: { type: string; ref: FakeRef }) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(type: string, ref: FakeRef) {
		for (const listener of this.listeners) listener({ type, ref });
	}
}

let dir: string;
let rootFile: string;
let artifactDir: string;
let registry: FakeRegistry;
let readCalls: number;
let scanBehavior: "real" | "noop" | "throws";
let notices: string[];
let omp: OmpHost;

const header = '{"type":"session","id":"x"}\n';
const complete = `${header}{"type":"session_init","task":"t"}\n{"type":"message","message":{}}\n`;

function writeChild(id: string, body: string) {
	writeFileSync(join(artifactDir, `${id}.jsonl`), body);
}

/**
 * Upstream ensurePersistedRoster + registerPersistedSubagents, one directory level:
 * scans once per root (settled latch), skips header-only stubs.
 */
function realScan() {
	registry[LATCHES] ??= new Map();
	if (registry[LATCHES].has(rootFile)) return;
	registry[LATCHES].set(rootFile, { settled: true });
	for (const name of readdirSync(artifactDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const id = name.slice(0, -6);
		if (registry.refs.has(id)) continue;
		const text = readFileSync(join(artifactDir, name), "utf8");
		const incomplete = !text.includes('"session_init"') && !text.includes('"message"');
		if (incomplete) continue;
		registry.refs.set(id, { id, displayName: id, kind: "sub", parentId: "Main", status: "parked", session: null, sessionFile: join(artifactDir, name), createdAt: 1, lastActivity: 1 });
	}
}

/** A new OMP process resuming the same root: fresh registry, no latches. */
function restartProcess() {
	const main = registry.refs.get("Main");
	registry = new FakeRegistry();
	if (main) registry.refs.set("Main", main);
	omp = makeOmp();
	omp.adopt(ctx);
}

/** Mirrors the AgentSession members the work view and queued-control capabilities read. */
const work = {
	streaming: false,
	admitted: false,
	queued: 0,
	visible: { steering: [] as unknown[], followUp: [] as unknown[] },
	queues: { steering: [] as Array<{ role: string; attribution?: string; display?: boolean }>, followUp: [] as Array<{ role: string; attribution?: string; display?: boolean }> },
	pending: false,
	jobs: [] as Array<{ id: string; type: string; label: string; startTime: number; agentId?: string }>,
	undelivered: 0,
	cancelled: [] as Array<{ id: string; filter: unknown }>,
};

const mainSession = {
	sessionManager: { getSessionId: () => "sess-1" },
	get isStreaming() {
		return work.streaming;
	},
	get hasAdmittedSubmission() {
		return work.admitted;
	},
	get queuedMessageCount() {
		return work.queued;
	},
	hasPendingAsyncWork: () => work.pending,
	getQueuedMessages: () => work.visible,
	agent: {
		peekSteeringQueue: () => work.queues.steering,
		peekFollowUpQueue: () => work.queues.followUp,
	},
	getAsyncJobSnapshot: () => ({ running: work.jobs, recent: [], delivery: { queued: work.undelivered, delivering: false } }),
	getAgentId: () => "Main",
	asyncJobManager: {
		getJob: (id: string): unknown => {
			const job = work.jobs.find(job => job.id === id);
			return job ? { ...job, ownerId: "Main", status: "running", promise: Promise.resolve() } : undefined;
		},
		cancel: (id: string, filter: unknown) => {
			work.cancelled.push({ id, filter });
			return work.jobs.some(job => job.id === id);
		},
	},
	getToolByName: (name: string): unknown => {
		if (name === "read") {
			return {
				execute: async () => {
					readCalls++;
					if (scanBehavior === "throws") throw new Error("Unknown agent");
					if (scanBehavior === "real") realScan();
					return { content: [] };
				},
			};
		}
		if (name === "task") return { session: { agentLifecycle: () => ({ release: async () => true }) } };
		return undefined;
	},
};

/** Minimal stand-in for OMP's EventBus (utils/event-bus.ts): synchronous emit to channel listeners. */
class FakeEventBus {
	#listeners = new Map<string, Set<(data: unknown) => void>>();
	get size() { return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.#listeners.get(channel) ?? new Set();
		set.add(handler);
		this.#listeners.set(channel, set);
		return () => set.delete(handler);
	}
	emit(channel: string, data: unknown): void {
		for (const handler of this.#listeners.get(channel) ?? []) handler(data);
	}
}
let events: FakeEventBus;
let runtimeExports: Record<string, unknown>;
let transcriptLoader: (path: string) => Promise<unknown[]> = async () => [];

function makeOmp(): OmpHost {
	events = new FakeEventBus();
	const pi = {
		pi: {
			AgentRegistry: { global: () => registry },
			discoverAgents: async () => ({ agents: definitions }),
			finalizeSubagentLifecycle: async () => {},
			runSubagentFollowUpTurn: async () => ({}),
			USER_INTERRUPT_LABEL: "interrupt",
			VERSION: "test",
			loadSessionMessagesReadOnly: (path: string) => transcriptLoader(path),
			loadEntriesFromFile: async () => [],
		},
		events,
		logger: { warn: () => {} },
	} as unknown as ExtensionAPI; // Test seam: only the members the adapter reads are provided.
	runtimeExports = pi.pi;
	return createOmpHost(pi);
}

const ctx = {
	agent: { kind: "main", id: "Main", name: "main", depth: 0 },
	sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => rootFile },
	ui: { notify: (message: string) => notices.push(message), setStatus: (key: string, value: string | undefined) => { statuses[key] = value; } },
	cwd: "/",
	getContextUsage: () => ({ contextWindow: 1000 }),
} as unknown as ExtensionContext; // Test seam: minimal context the adapter reads.

let definitions: Array<{ name: string; description: string; source: string; systemPrompt: string }> = [];

let stderrWrite: typeof process.stderr.write;
let statuses: Record<string, string | undefined>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "noli-host-"));
	rootFile = join(dir, "root.jsonl");
	artifactDir = join(dir, "root");
	mkdirSync(artifactDir);
	writeFileSync(rootFile, header);
	registry = new FakeRegistry();
	registry.refs.set("Main", { id: "Main", displayName: "main", kind: "main", status: "running", session: mainSession, sessionFile: rootFile, createdAt: 1, lastActivity: 1 });
	Object.assign(work, { streaming: false, admitted: false, queued: 0, visible: { steering: [], followUp: [] }, queues: { steering: [], followUp: [] }, pending: false, jobs: [], undelivered: 0, cancelled: [] });
	statuses = {};
	readCalls = 0;
	scanBehavior = "real";
	transcriptLoader = async () => [{ role: "user", content: "child prompt", timestamp: 10 }];
	notices = [];
	stderrWrite = process.stderr.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	omp = makeOmp();
	omp.adopt(ctx);
});

afterEach(() => {
	omp.release();
	vi.useRealTimers();
	process.stderr.write = stderrWrite;
	rmSync(dir, { recursive: true, force: true });
});

const list = () => omp.host.list({ includePersisted: true });
const listLive = () => omp.host.list({ includePersisted: false });
const ids = (r: ListResult) => r.agents.map(a => a.id);

test("thread-read negotiation advertises only reference_id main-only-v2 and tracks root lifetime", () => {
	expect(omp.host.capabilities()["host.thread_read"]).toMatchObject({ available: true, api: "main-only-v2" });
	omp.release();
	expect(omp.host.capabilities()["host.thread_read"]).toMatchObject({ available: false, api: "main-only-v2", reason: "not_ready" });
	omp.adopt(ctx);
	registry.refs.delete("Main");
	expect(omp.host.capabilities()["host.thread_read"]).toMatchObject({ available: false, api: "main-only-v2", reason: "not_ready" });
});


describe("persisted discovery", () => {
	test("a stub-only root keeps discovery available and still returns live rows", async () => {
		writeChild("Fresh", header);
		const first = await list();
		expect(ids(first)).toEqual(["Main"]);
		expect(first.discovery).toMatchObject({ status: "skipped", pending: ["Fresh"] });
		expect(omp.host.capabilities()["agents.list.persisted"].available).toBe(true);
		expect(notices.every(notice => !notice.includes("agents.list.persisted"))).toBe(true);
	});

	test("stub later completed by its live spawn: discovery stays on and the child is listed", async () => {
		writeChild("Fresh", header);
		await list();
		await list();
		expect(readCalls).toBe(1);
		// The spawn claims the id and writes its transcript in this same process.
		writeChild("Fresh", complete);
		registry.refs.set("Fresh", { id: "Fresh", displayName: "Fresh", kind: "sub", parentId: "Main", status: "running", session: {}, sessionFile: join(artifactDir, "Fresh.jsonl"), createdAt: 1, lastActivity: 1 });
		const later = await list();
		expect(ids(later)).toEqual(["Main", "Fresh"]);
		expect(later.discovery.status).toBe("none");
		expect(omp.host.capabilities()["agents.list.persisted"].available).toBe(true);
	});

	test("stub later completed, then process restart: the child is restored", async () => {
		writeChild("Fresh", header);
		expect((await list()).discovery.status).toBe("skipped");
		writeChild("Fresh", complete);
		restartProcess();
		const after = await list();
		expect(ids(after)).toEqual(["Main", "Fresh"]);
		expect(after.discovery).toMatchObject({ status: "complete", restored: ["Fresh"] });
	});

	test("a changed declined transcript is looked up again (cheap) without disabling anything", async () => {
		writeChild("Fresh", header);
		await list();
		writeChild("Fresh", complete);
		const again = await list();
		expect(readCalls).toBe(2);
		// OMP's settled latch means no rescan in this process; that is skipped, not broken.
		expect(again.discovery).toMatchObject({ status: "skipped", pending: ["Fresh"] });
		expect(omp.host.capabilities()["agents.list.persisted"].available).toBe(true);
	});

	test("a mixed root restores complete children and reports the stub as pending", async () => {
		writeChild("Done", complete);
		writeChild("Stub", header);
		const result = await list();
		expect(ids(result)).toEqual(["Main", "Done"]);
		expect(result.discovery).toMatchObject({ status: "skipped", restored: ["Done"], pending: ["Stub"] });
	});

	test("no evidence the scan ran is inconclusive: no disable, retried next call", async () => {
		writeChild("Done", complete);
		scanBehavior = "noop";
		const first = await list();
		expect(first.discovery.status).toBe("inconclusive");
		expect(ids(first)).toEqual(["Main"]);
		expect(omp.host.capabilities()["agents.list.persisted"].available).toBe(true);
		scanBehavior = "real";
		const second = await list();
		expect(readCalls).toBe(2);
		expect(ids(second)).toEqual(["Main", "Done"]);
	});

	test("a throwing lookup does not fail the listing", async () => {
		writeChild("Done", complete);
		scanBehavior = "throws";
		const result = await list();
		expect(result.discovery.status).toBe("inconclusive");
		expect(result.discovery.detail).toContain("Unknown agent");
		expect(ids(result)).toEqual(["Main"]);
	});

	test("a missing read tool reports unavailable, closes the capability, and warns", async () => {
		writeChild("Done", complete);
		const original = mainSession.getToolByName;
		mainSession.getToolByName = (name: string) => (name === "read" ? undefined : original(name));
		try {
			const result = await list();
			expect(result.discovery.status).toBe("unavailable");
			expect(ids(result)).toEqual(["Main"]);
			expect(omp.host.capabilities()["agents.list.persisted"].available).toBe(false);
			expect(notices.some(n => n.includes("agents.list.persisted"))).toBe(true);
			mainSession.getToolByName = original;
			// Recovers as soon as the shape is back; no session switch needed.
			expect(omp.host.refreshCapabilities()["agents.list.persisted"].available).toBe(true);
		} finally {
			mainSession.getToolByName = original;
		}
	});

	test("session adoption clears declined transcripts", async () => {
		writeChild("Fresh", header);
		await list();
		omp.adopt(ctx);
		await list();
		expect(readCalls).toBe(2);
	});
});

describe("mapping OMP data onto the protocol", () => {
	const child = (over: Partial<FakeRef>): FakeRef => ({
		id: "C",
		displayName: "C",
		kind: "sub",
		parentId: "Main",
		status: "idle",
		session: null,
		sessionFile: join(artifactDir, "C.jsonl"),
		createdAt: 1,
		lastActivity: 1,
		...over,
	});

	test("OMP statuses map to protocol states, with no session paths exposed", async () => {
		for (const [omp, state] of [["running", "running"], ["idle", "idle"], ["parked", "parked"], ["aborted", "terminated"]] as const) {
			registry.refs.set("C", child({ status: omp }));
			const view = (await listLive()).agents.find(a => a.id === "C");
			expect(view?.state).toBe(state);
			expect(view && "sessionFile" in view).toBe(false);
		}
	});

	test("an unrecognized OMP status or kind becomes unknown instead of passing through", async () => {
		registry.refs.set("C", child({ status: "hibernating" }));
		expect((await listLive()).agents.find(a => a.id === "C")?.state).toBe("unknown");
		registry.refs.set("C", child({ kind: "daemon" }));
		expect((await listLive()).agents.find(a => a.id === "C")?.kind).toBe("unknown");
	});

	test("the recorded agent definition is exposed", async () => {
		registry.refs.set("C", child({ history: { agent: "explore" } }));
		registry.refs.set("D", child({ id: "D", sessionFile: join(artifactDir, "D.jsonl") }));
		const agents = (await listLive()).agents;
		expect(agents.find(a => a.id === "C")?.definition).toBe("explore");
		expect(agents.find(a => a.id === "D")?.definition).toBeNull();
	});

	test("a live child's definition comes from OMP's spawn lifecycle event", async () => {
		registry.refs.set("L", child({ id: "L", sessionFile: join(artifactDir, "L.jsonl") }));
		expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBeNull();
		events.emit("task:subagent:lifecycle", { id: "L", agent: "scout", agentSource: "bundled", status: "started", index: 0 });
		expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBe("scout");
		// Malformed payloads are ignored rather than trusted.
		events.emit("task:subagent:lifecycle", { id: "L", agent: 42 });
		expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBe("scout");
	});

	test("a session switch keeps definitions of children that are still running", async () => {
		const file = join(artifactDir, "L.jsonl");
		registry.refs.set("L", child({ id: "L", sessionFile: file }));
		events.emit("task:subagent:lifecycle", { id: "L", agent: "scout", status: "started", sessionFile: file, index: 0 });
		omp.adopt(ctx); // e.g. a branch or tree navigation: same root, same live children.
		expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBe("scout");
	});

	test("a ref replaced under the same id does not inherit the old definition, with or without a path", async () => {
		const file = join(artifactDir, "L.jsonl");
		for (const sessionFile of [undefined, file]) {
			registry.refs.set("L", child({ id: "L", sessionFile: file }));
			events.emit("task:subagent:lifecycle", { id: "L", agent: "scout", status: "started", index: 0, ...(sessionFile ? { sessionFile } : {}) });
			expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBe("scout");
			// Same id, same transcript path, new ref: OMP reused the id for a new spawn.
			registry.refs.set("L", child({ id: "L", sessionFile: file }));
			expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBeNull();
		}
	});

	test("a start event with no registered ref is ignored rather than cached by id", async () => {
		events.emit("task:subagent:lifecycle", { id: "L", agent: "scout", status: "started", index: 0 });
		registry.refs.set("L", child({ id: "L", sessionFile: join(artifactDir, "L.jsonl") }));
		expect((await listLive()).agents.find(a => a.id === "L")?.definition).toBeNull();
	});

	test("the spawn event pushes a corrected agent row once", async () => {
		const pushed: Array<{ id: string; definition: string | null }> = [];
		const unsubscribe = omp.host.subscribe(agent => pushed.push({ id: agent.id, definition: agent.definition }));
		const file = join(artifactDir, "L.jsonl");
		registry.refs.set("L", child({ id: "L", sessionFile: file }));
		const started = { id: "L", agent: "scout", status: "started", sessionFile: file, index: 0 };
		events.emit("task:subagent:lifecycle", started);
		events.emit("task:subagent:lifecycle", { ...started, status: "completed" });
		expect(pushed).toEqual([{ id: "L", definition: "scout" }]);
		unsubscribe();
		events.emit("task:subagent:lifecycle", { ...started, agent: "explore" });
		expect(pushed).toHaveLength(1);
	});

	test("definitions map to name, description and a closed source", async () => {
		definitions = [
			{ name: "task", description: "General", source: "bundled", systemPrompt: "secret" },
			{ name: "mine", description: "Mine", source: "plugin-v9", systemPrompt: "secret" },
		];
		expect(await omp.host.definitions()).toEqual([
			{ name: "task", description: "General", source: "bundled" },
			{ name: "mine", description: "Mine", source: "unknown" },
		]);
	});

	test("capability probes report reason codes", () => {
		const original = mainSession.getToolByName;
		mainSession.getToolByName = (name: string) => (name === "task" ? { session: {} } : original(name));
		try {
			const caps = omp.host.refreshCapabilities();
			expect(caps["agents.kill.parked"]).toMatchObject({ available: false, reason: "hook_changed" });
			mainSession.getToolByName = (name: string) => (name === "read" ? undefined : original(name));
			expect(omp.host.refreshCapabilities()["agents.list.persisted"]).toMatchObject({ available: false, reason: "tool_missing" });
		} finally {
			mainSession.getToolByName = original;
		}
	});

	test("unavailable memory capabilities stay negotiated but never appear in UI or stderr warnings", async () => {
		const oldMemory = ctx.memory;
		const manager = mainSession.sessionManager;
		const writes: string[] = [];
		process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
		try {
			Object.assign(mainSession, { sessionManager: { ...manager, getCwd: () => "/" } });
			for (const backend of ["off", "local", "hindsight"] as const) {
				ctx.memory = { status: async () => ({ backend, active: backend !== "off", searchable: false, writable: backend === "local" }), search: async query => ({ backend, query, count: 0, items: [] }), save: async () => ({ backend, stored: 0 }) };
				await omp.host.nativeControl!("memory.status", {});
				expect(omp.host.refreshCapabilities()["memory.search"].available).toBe(false);
			}
			ctx.memory = undefined;
			expect(omp.host.refreshCapabilities()["memory.status"].available).toBe(false);
			expect(omp.host.refreshCapabilities()["memory.save"].available).toBe(false);
			expect(notices.every(notice => !notice.includes("memory."))).toBe(true);
			expect(writes.every(message => !message.includes("memory."))).toBe(true);
			const original = mainSession.getToolByName;
			mainSession.getToolByName = name => name === "read" ? undefined : original(name);
			try {
				omp.host.refreshCapabilities();
				expect(notices.some(notice => notice.includes("agents.list.persisted"))).toBe(true);
				expect(writes.some(message => message.includes("agents.list.persisted"))).toBe(true);
			} finally { mainSession.getToolByName = original; }
		} finally {
			ctx.memory = oldMemory;
			mainSession.sessionManager = manager;
		}
	});

	test("main is idle when its registry status is stale but nothing streams or is queued; hidden queued input keeps it running", async () => {
		const main = async () => (await listLive()).agents.find(a => a.id === "Main")?.state;
		expect(await main()).toBe("idle");
		work.queued = 1;
		expect(await main()).toBe("running");
		work.queued = 0;
		work.streaming = true;
		expect(await main()).toBe("running");
	});
});

describe("work", () => {
	test("reports OMP's settlement fields, counts hidden queued messages and maps running jobs", () => {
		expect(omp.host.work()).toEqual({ settled: true, streaming: false, admittedSubmission: false, queued: 0, hiddenQueued: 0, pendingAsyncWork: false, jobs: [], undeliveredResults: 0 });
		work.queued = 2;
		work.visible = { steering: ["visible"], followUp: [] };
		work.queues.steering = [{ role: "user" }];
		work.pending = true;
		work.undelivered = 1;
		work.jobs = [{ id: "bg_1", type: "bash", label: "cargo test", startTime: 5 }, { id: "T", type: "vibe", label: "x", startTime: 6, agentId: "Child" }];
		expect(omp.host.work()).toEqual({
			settled: false,
			streaming: false,
			admittedSubmission: false,
			queued: 2,
			hiddenQueued: 1,
			pendingAsyncWork: true,
			jobs: [
				{ id: "bg_1", kind: "bash", label: "cargo test", startedAt: 5, agentId: null },
				{ id: "T", kind: "unknown", label: "x", startedAt: 6, agentId: "Child" },
			],
			undeliveredResults: 1,
		});
	});

	test("live-steered chips cannot hide a pending next-turn message", () => {
		work.queued = 2; // One real queued user message and one hidden next-turn message.
		work.visible = { steering: ["live-steered", "queued user"], followUp: [] };
		work.queues.steering = [{ role: "user" }];
		expect(omp.host.work()).toMatchObject({ queued: 2, hiddenQueued: 1, settled: false });
	});

	test("queue visibility excludes agent-authored prompts and hidden custom companions", () => {
		work.queued = 4; // Two user chips, an advisor, and an agent-authored prompt.
		work.queues.steering = [{ role: "user" }, { role: "custom", attribution: "user" }, { role: "user", attribution: "agent" }, { role: "custom" }, { role: "custom", attribution: "user", display: false }];
		expect(omp.host.work().hiddenQueued).toBe(2);
	});

	test("an admitted submission alone keeps the session unsettled", () => {
		work.admitted = true;
		expect(omp.host.work().settled).toBe(false);
	});

	test("cancelJob is scoped to the root session's agent id", async () => {
		work.jobs = [{ id: "bg_1", type: "bash", label: "x", startTime: 1 }];
		expect(await omp.host.cancelJob("bg_1")).toBe(true);
		expect(await omp.host.cancelJob("other")).toBe(false);
		expect(work.cancelled).toEqual([{ id: "bg_1", filter: { ownerId: "Main" } }]);
	});
	test("native mutations refuse owned cancellation cleanup after native pending work clears", async () => {
		const gate = Promise.withResolvers<void>();
		const original = mainSession.asyncJobManager.getJob;
		const additions = { isBusyForSnapshot: false, isSessionTransitioning: false, isDisposed: false, navigateTree: async () => ({ cancelled: true }), getGoalModeState: () => ({ goal: { id: "g" } }), goalRuntime: { onBudgetMutated: async () => ({ goal: { id: "g", tokenBudget: 10 } }) } };
		Object.assign(mainSession, additions);
		mainSession.asyncJobManager.getJob = () => ({ ownerId: "Main", status: "running", promise: gate.promise, type: "bash", label: "cleanup", startTime: 1 });
		const cancellation = omp.host.cancelJob("bg_1");
		try {
			expect(work.pending).toBe(false);
			for (const method of ["tree.navigate", "goal.budget"] as const) await expect(omp.host.nativeControl!(method, method === "tree.navigate" ? { targetId: "e" } : { tokenBudget: 10 })).rejects.toThrow("cleanup is still draining");
			gate.resolve();
			await cancellation;
			expect(await omp.host.nativeControl!("tree.navigate", { targetId: "e" })).toEqual({ cancelled: true });
			const budgetGate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const calls: string[] = [];
			Object.assign(mainSession, { goalRuntime: { onBudgetMutated: async () => { calls.push("budget"); entered.resolve(); await budgetGate.promise; return { goal: { id: "g", tokenBudget: 10 } }; } }, navigateTree: async () => { calls.push("tree"); return { cancelled: true }; } });
			const budget = omp.host.nativeControl!("goal.budget", { tokenBudget: 10 });
			await entered.promise;
			const tree = omp.host.nativeControl!("tree.navigate", { targetId: "e" });
			await Promise.resolve();
			expect(calls).toEqual(["budget"]);
			budgetGate.resolve();
			await Promise.all([budget, tree]);
			expect(calls).toEqual(["budget", "tree"]);
			calls.length = 0;
			const oldGate = Promise.withResolvers<void>();
			const oldEntered = Promise.withResolvers<void>();
			Object.assign(mainSession, { goalRuntime: { onBudgetMutated: async () => { oldEntered.resolve(); await oldGate.promise; return { goal: { id: "g", tokenBudget: 10 } }; } } });
			const oldBudget = omp.host.nativeControl!("goal.budget", { tokenBudget: 10 });
			const oldRejected = oldBudget.catch(error => error);
			await oldEntered.promise;
			const root = registry.refs.get("Main")!;
			root.session = { ...mainSession };
			omp.adopt(ctx);
			expect(await omp.host.nativeControl!("tree.navigate", { targetId: "new" })).toEqual({ cancelled: true });
			root.session = mainSession;
			omp.adopt(ctx);
			const recalled = omp.host.nativeControl!("tree.navigate", { targetId: "recalled" });
			await Promise.resolve();
			expect(calls).toEqual(["tree"]);
			oldGate.resolve();
			expect(String(await oldRejected)).toContain("Root session changed");
			await recalled;
			expect(calls).toEqual(["tree", "tree"]);
		} finally {
			gate.resolve();
			await cancellation;
			mainSession.asyncJobManager.getJob = original;
			for (const key of Object.keys(additions)) Reflect.deleteProperty(mainSession, key);
		}
	});

	test("without an owner id, cancellation is refused and never reaches the job manager unscoped", async () => {
		const original = mainSession.getAgentId;
		for (const missing of [() => undefined, () => ""]) {
			mainSession.getAgentId = missing as () => string;
			try {
				expect(omp.host.refreshCapabilities()["work.cancel"]).toMatchObject({ available: false, reason: "hook_changed" });
				await expect(omp.host.cancelJob("bg_1")).rejects.toThrow(/work.cancel is unavailable/);
			} finally {
				mainSession.getAgentId = original;
			}
		}
		expect(work.cancelled).toEqual([]);
		expect(omp.host.refreshCapabilities()["work.cancel"].available).toBe(true);
	});

	test("cancellation fails closed when the native job completion is unobservable", async () => {
		const original = mainSession.asyncJobManager.getJob;
		mainSession.asyncJobManager.getJob = () => ({ ownerId: "Main", status: "running" });
		try {
			await expect(omp.host.cancelJob("bg_1")).rejects.toThrow(/cannot observe job termination/);
			expect(work.cancelled).toEqual([]);
		} finally {
			mainSession.asyncJobManager.getJob = original;
		}
	});
});

describe("telemetry lifecycle", () => {
	test("an invalid cost clears a previously published value", () => {
		let cost = 1.25;
		registry.refs.get("Main")!.session = { ...mainSession, getSessionStats: () => ({ cost, tokens: {} }) };
		omp.adopt(ctx);
		expect(statuses["noli.cost"]).toBe("1.25");
		for (const invalid of [NaN, Infinity, undefined]) {
			cost = invalid as number;
			omp.adopt(ctx);
			expect(statuses["noli.cost"]).toBeUndefined();
		}
	});

	test("release clears every published bridge telemetry value", () => {
		registry.refs.get("Main")!.session = {
			...mainSession,
			getPrewalkState: () => ({ target: { name: "implementation" } }),
			getSessionStats: () => ({ cost: 1.25, tokens: { input: 10, output: 20 } }),
			settings: { rawValue: ({ id }: { id: string }) => id === "compaction.thresholdPercent" ? 80 : undefined },
			autoCompactionEnabled: true,
			tokenRate: { rate: () => 12 },
		};
		omp.adopt(ctx);
		expect(statuses).toMatchObject({ "noli.prewalk": "Prewalk armed → implementation", "noli.cost": "1.25", "noli.input": "10", "noli.output": "20", "noli.context-threshold": "80", "noli.throughput": "12" });
		omp.release();
		expect(statuses).toEqual({ "noli.prewalk": undefined, "noli.cost": undefined, "noli.input": undefined, "noli.output": undefined, "noli.context-threshold": undefined, "noli.throughput": undefined });
	});
});

describe("read-only child output isolation", () => {
	function child(id = "C", over: Partial<FakeRef> = {}) {
		writeChild(id, complete);
		const ref: FakeRef = { id, displayName: id, kind: "sub", parentId: "Main", status: "parked", session: null, sessionFile: join(artifactDir, `${id}.jsonl`), createdAt: 1, lastActivity: 1, ...over };
		registry.refs.set(id, ref);
		return ref;
	}
	test("live and parked output use native messages without invoking control", async () => {
		const ref = child();
		const calls: string[] = [];
		transcriptLoader = async path => { calls.push(path); return [{ role: "user", content: "parked prompt", timestamp: 10 }]; };
		expect((await omp.host.output({ agentId: "C" })).text).toContain("parked prompt");
		expect(ref.session).toBeNull();
		ref.session = { messages: [{ role: "user", content: "live prompt", timestamp: 20 }], agent: { state: { streamMessage: { role: "assistant", content: [{ type: "text", text: "streaming text" }], timestamp: 30 } } } };
		const live = await omp.host.output({ agentId: "C" });
		expect(live.text).toContain("live prompt");
		expect(live.text).toContain("streaming text");
		expect(calls).toEqual([realpathSync(ref.sessionFile!)]);
	});
	test("rejects root, advisor, unknown and foreign children", async () => {
		child("Advisor", { kind: "advisor" });
		child("Foreign", { parentId: "DifferentRoot" });
		child("Outside", { sessionFile: join(dir, "outside.jsonl") });
		for (const agentId of ["Main", "Advisor"]) await expect(omp.host.output({ agentId })).rejects.toMatchObject({ body: { code: "forbidden_kind" } });
		for (const agentId of ["ghost", "Foreign", "Outside"]) await expect(omp.host.output({ agentId })).rejects.toMatchObject({ body: { code: "unknown_agent" } });
	});
	test("canonical symlink escape never reaches the loader", async () => {
		const ref = child();
		const outside = join(dir, "outside.jsonl");
		writeFileSync(outside, complete);
		unlinkSync(ref.sessionFile!);
		symlinkSync(outside, ref.sessionFile!);
		let loaded = false;
		transcriptLoader = async () => { loaded = true; return []; };
		await expect(omp.host.output({ agentId: "C" })).rejects.toMatchObject({ body: { code: "unknown_agent" } });
		expect(loaded).toBe(false);
	});
	test("persisted input above 64 MiB is rejected before loading", async () => {
		const ref = child();
		truncateSync(ref.sessionFile!, 64 * 1024 * 1024 + 1);
		let loaded = false;
		transcriptLoader = async () => { loaded = true; return []; };
		await expect(omp.host.output({ agentId: "C" })).rejects.toMatchObject({ body: { code: "bad_request" } });
		expect(loaded).toBe(false);
	});
	test.each(["adoption", "ref", "path", "symlink", "parent"])("rechecks %s after asynchronous loading", async kind => {
		const ref = child();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		transcriptLoader = async () => { entered.resolve(); await gate.promise; return [{ role: "user", content: "private stale output", timestamp: 10 }]; };
		const reading = omp.host.output({ agentId: "C" });
		await entered.promise;
		if (kind === "adoption") omp.adopt(ctx);
		if (kind === "ref") registry.refs.set("C", { ...ref });
		if (kind === "parent") ref.parentId = "DifferentRoot";
		if (kind === "path") ref.sessionFile = join(artifactDir, "replacement.jsonl");
		if (kind === "symlink") {
			const outside = join(dir, "outside.jsonl");
			writeFileSync(outside, complete);
			unlinkSync(ref.sessionFile!);
			symlinkSync(outside, ref.sessionFile!);
		}
		gate.resolve();
		await expect(reading).rejects.toMatchObject({ body: { code: "stale_session" } });
	});
	test("missing read-only export explicitly disables output", () => {
		delete runtimeExports.loadSessionMessagesReadOnly;
		expect(omp.host.refreshCapabilities()["agents.output"]).toMatchObject({ available: false, reason: "export_missing" });
	});
});

describe("agent telemetry observer lifetime", () => {
	test("publishes active usage changes and retains final telemetry on the actual parked ref", async () => {
		vi.useFakeTimers();
		omp.adopt(ctx);
		let input = 11;
		const listeners = new Set<(event: { type: string }) => void>();
		const session = {
			isStreaming: true, queuedMessageCount: 0,
			servingModel: { modelIdentity: "child/model", thinkingLevel: "high" },
			getSessionStats: () => ({ assistantMessages: 1, tokens: { input, output: 7 }, cost: 0, contextUsage: { tokens: 50, contextWindow: 100 } }),
			tokenRate: { rate: () => 3 },
			subscribe: (listener: (event: { type: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
			waitForIdle: async () => {},
		};
		writeChild("C", complete);
		const ref: FakeRef = { id: "C", displayName: "C", kind: "sub", parentId: "Main", status: "running", session, sessionFile: join(artifactDir, "C.jsonl"), createdAt: 1, lastActivity: 1 };
		registry.refs.set("C", ref);
		const changed: Array<{ inputTokens: number | null }> = [];
		const off = omp.host.subscribe(agent => { if (agent.id === "C") changed.push(agent); });
		registry.emit("registered", ref);
		input = 25;
		vi.advanceTimersByTime(300);
		expect(changed.map(agent => agent.inputTokens)).toContain(25);
		input = 31;
		for (const listener of listeners) listener({ type: "message_end" });
		ref.session = null;
		ref.status = "parked";
		registry.emit("status_changed", ref);
		const parked = (await listLive()).agents.find(agent => agent.id === "C")!;
		expect(parked).toMatchObject({ model: "child/model", effort: "high", inputTokens: 31, outputTokens: 7, sessionCost: 0, contextWindow: 100, tokensPerSecond: null });
		expect(listeners.size).toBe(0);
		omp.release();
		expect(registry.listeners.size).toBe(0);
		expect(events.size).toBe(0);
		const length = changed.length;
		vi.advanceTimersByTime(300);
		expect(changed).toHaveLength(length);
		off();
		vi.useRealTimers();
	});
	test("optional telemetry exceptions never break listing or root work", async () => {
		registry.refs.get("Main")!.session = { ...mainSession, getSessionStats: () => { throw new Error("optional stats unavailable"); } };
		omp.adopt(ctx);
		const main = (await listLive()).agents.find(agent => agent.id === "Main")!;
		expect(main.sessionCost).toBeNull();
		expect(omp.host.work().settled).toBe(true);
	});
});

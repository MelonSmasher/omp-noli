import { describe, expect, test } from "bun:test";
import type { AgentRef, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { assistantTurnProducedOutput } from "@oh-my-pi/pi-coding-agent/session/messages";
import { migrateToCurrentVersion } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { AgentTelemetry } from "../src/agent-telemetry";
import type { AgentTelemetryView } from "../src/protocol";

const EMPTY: AgentTelemetryView = {
	model: null, effort: null, requests: null, contextTokens: null, contextWindow: null,
	inputTokens: null, outputTokens: null, sessionCost: null, tokensPerSecond: null,
};
const HEADER = { type: "session", version: 3, id: "session", timestamp: "2026-10-03T00:00:00Z", cwd: "/fixture" };
type ReadChild = <T>(ref: AgentRef, loader: (file: string) => Promise<T>) => Promise<T>;

function ref(id: string, session: unknown = null): AgentRef {
	return {
		id, displayName: id, kind: id === "Main" ? "main" : "sub", parentId: id === "Main" ? undefined : "Main",
		status: session ? "running" : "parked", session, sessionFile: `/fixture/${id}.jsonl`, createdAt: 1, lastActivity: 1,
	} as AgentRef;
}

function live(options: {
	model?: unknown; thinkingLevel?: unknown; servingModel?: unknown; stats?: unknown; rate?: unknown;
} = {}) {
	return {
		model: options.model ?? { provider: "provider", id: "configured" },
		thinkingLevel: options.thinkingLevel ?? "medium",
		servingModel: options.servingModel,
		getSessionStats() { return options.stats; },
		tokenRate: { rate() { return options.rate; } },
	};
}

function usage(input: number, output: number, cost = 0) {
	return {
		input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant", provider: "provider", model: "served", api: "openai-completions", timestamp: 1,
		content: [{ type: "text", text: "completed" }], stopReason: "stop", ...overrides,
	};
}

function entry(type: string, id: string, parentId: string | null, payload: Record<string, unknown> = {}) {
	return { type, id, parentId, timestamp: "2026-10-03T00:00:00Z", ...payload };
}

/** Exercise the actual SDK branch/context builder, not a copied approximation of its accounting window. */
function cold(records: unknown[], options: {
	readChild?: ReadChild; api?: Record<string, unknown>;
} = {}) {
	let loads = 0;
	const api = {
		buildSessionContext,
		assistantTurnProducedOutput,
		migrateToCurrentVersion,
		loadEntriesFromFile: async () => { loads++; return records; },
		...options.api,
	};
	const readChild: ReadChild = options.readChild ?? ((agent, loader) => loader(agent.sessionFile!));
	return { telemetry: new AgentTelemetry(api, readChild), loads: () => loads };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

const noRead: ReadChild = async () => { throw new Error("unexpected persisted read"); };

describe("independent live telemetry", () => {
	test("root and children use their own serving attribution, stats and token rate", () => {
		const telemetry = new AgentTelemetry({}, noRead);
		const root = ref("Main", live({
			servingModel: { modelIdentity: "root/model@route", selector: "root/model@route:max", thinkingLevel: "low" },
			stats: { assistantMessages: 7, tokens: { input: 200, output: 31 }, cost: 0.8,
				contextUsage: { tokens: 1200, contextWindow: 16000 } }, rate: 8.5,
		}));
		const child = ref("Child", live({
			servingModel: { modelIdentity: "child/model", selector: "child/model:low", thinkingLevel: "high" },
			stats: { assistantMessages: 2, tokens: { input: 40, output: 11 }, cost: 0,
				contextUsage: { tokens: 700, contextWindow: 4000 } }, rate: 15.25,
		}));
		expect(telemetry.sample(root)).toEqual({ model: "root/model@route", effort: "low", requests: 7,
			contextTokens: 1200, contextWindow: 16000, inputTokens: 200, outputTokens: 31, sessionCost: 0.8, tokensPerSecond: 8.5 });
		expect(telemetry.sample(child)).toEqual({ model: "child/model", effort: "high", requests: 2,
			contextTokens: 700, contextWindow: 4000, inputTokens: 40, outputTokens: 11, sessionCost: 0, tokensPerSecond: 15.25 });
		child.session = live({ stats: { assistantMessages: 3, tokens: { input: 60, output: 18 }, cost: 0.1 }, rate: 22 }) as unknown as AgentRef["session"];
		expect(telemetry.sample(child)).toMatchObject({ requests: 3, inputTokens: 60, outputTokens: 18, tokensPerSecond: 22 });
		expect(telemetry.sample(root).requests).toBe(7);
	});

	test("fallback getters never derive identity or effort from serving selector", () => {
		const telemetry = new AgentTelemetry({}, noRead);
		const child = ref("Child", live({
			model: { provider: "fallback", id: "model:nitro" }, thinkingLevel: "minimal",
			servingModel: { selector: "wrong/model:max", modelIdentity: " ", thinkingLevel: "" },
		}));
		expect(telemetry.sample(child)).toEqual({ ...EMPTY, model: "fallback/model:nitro", effort: "minimal" });
		child.session = { servingModel: { selector: "wrong/model:high" } } as unknown as AgentRef["session"];
		expect(telemetry.sample(child)).toEqual(EMPTY);
	});

	test("invalid and missing numbers stay null; actual observed zero is valid", () => {
		const telemetry = new AgentTelemetry({}, noRead);
		const child = ref("Child", live({
			stats: { assistantMessages: 1.5, tokens: { input: NaN, output: -1 }, cost: Infinity,
				contextUsage: { tokens: "100", contextWindow: 0 } }, rate: -3,
		}));
		expect(telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/configured", effort: "medium" });
		child.session = live({ stats: { assistantMessages: 0, tokens: { input: 0, output: 0 }, cost: 0,
			contextUsage: { tokens: 0, contextWindow: 2048 } }, rate: 0 }) as unknown as AgentRef["session"];
		expect(telemetry.sample(child)).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0,
			contextTokens: 0, contextWindow: 2048, sessionCost: 0, tokensPerSecond: 0 });
	});

	test("throwing optional getters/methods do not suppress independent fields", () => {
		const telemetry = new AgentTelemetry({}, noRead);
		const child = ref("Child", {
			get servingModel() { throw new Error("disposed attribution"); },
			model: { provider: "p", id: "m" }, thinkingLevel: "off",
			getSessionStats() { throw new Error("optional statistics"); },
			tokenRate: { rate() { return 6; } },
		});
		expect(telemetry.sample(child)).toEqual({ ...EMPTY, model: "p/m", effort: "off", tokensPerSecond: 6 });
		child.session = { get model() { throw new Error("disposed"); }, get thinkingLevel() { throw new Error("disposed"); },
			getSessionStats: () => ({ assistantMessages: 4, cost: 0 }), tokenRate: { rate() { throw new Error("meter"); } },
		} as unknown as AgentRef["session"];
		expect(telemetry.sample(child)).toEqual({ ...EMPTY, requests: 4, sessionCost: 0 });
	});

	test("parking retains observed telemetry but never stale throughput or another ref's data", async () => {
		const fixture = cold([HEADER]);
		const child = ref("Child", live({ servingModel: { modelIdentity: "p/m", thinkingLevel: "high" },
			stats: { assistantMessages: 3, tokens: { input: 90, output: 20 }, cost: 0,
				contextUsage: { tokens: 800, contextWindow: 4000 } }, rate: 30 }));
		const observed = fixture.telemetry.sample(child);
		child.session = null;
		child.status = "parked";
		const parked = fixture.telemetry.sample(child);
		expect(parked).toEqual({ ...observed, tokensPerSecond: null });
		expect(Object.isFrozen(parked)).toBe(true);
		expect(observed.tokensPerSecond).toBe(30);
		await fixture.telemetry.restore(child);
		expect(fixture.loads()).toBe(0);
		expect(fixture.telemetry.sample(ref("Child"))).toEqual(EMPTY);
		fixture.telemetry.clear();
		expect(fixture.telemetry.sample(child)).toEqual(EMPTY);
	});
});

describe("cold persisted telemetry", () => {
	test("requests are assistant counts, usage includes only native task results and model_usage", async () => {
		const fixture = cold([
			HEADER,
			entry("thinking_level_change", "effort", null, { thinkingLevel: "low", configured: "auto" }),
			entry("model_change", "model", "effort", { model: "provider/served@route:high" }),
			entry("message", "a1", "model", { message: assistant({ usage: usage(10, 2, 0.25) }) }),
			entry("message", "a2", "a1", { message: assistant({ usage: undefined, timestamp: 2 }) }),
			entry("message", "task", "a2", { message: { role: "toolResult", toolName: "task", toolCallId: "t",
				content: [{ type: "text", text: "child done" }], timestamp: 3, details: { usage: usage(20, 4, 0.5) } } }),
			entry("message", "bash", "task", { message: { role: "toolResult", toolName: "bash", toolCallId: "b",
				content: [{ type: "text", text: "done" }], timestamp: 4, details: { usage: usage(1000, 1000, 50) } } }),
			entry("model_usage", "hidden", "bash", { usage: usage(5, 1, 0.125), model: "judgment", provider: "p" }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/served@route", effort: "low",
			requests: 2, inputTokens: 35, outputTokens: 7, sessionCost: 0.875 });
		await fixture.telemetry.restore(child);
		expect(fixture.loads()).toBe(1);
	});

	test("latest persisted leaf parent chain excludes abandoned models, efforts, usage and anchors", async () => {
		const fixture = cold([
			HEADER,
			entry("session_init", "init", null, { resolvedModel: "provider/initial:high" }),
			entry("message", "abandoned", "init", { message: assistant({ provider: "other", model: "abandoned",
				usage: { ...usage(900, 90, 9), contextTokens: 7000 } }) }),
			entry("thinking_level_change", "wrong-effort", "abandoned", { thinkingLevel: "max" }),
			entry("model_usage", "wrong-usage", "wrong-effort", { usage: usage(999, 99, 99) }),
			entry("thinking_level_change", "effort", "init", { thinkingLevel: "medium" }),
			entry("model_change", "model", "effort", { model: "provider/served" }),
			entry("message", "a", "model", { message: assistant({ usage: usage(7, 3, 0) }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/served", effort: "medium",
			requests: 1, inputTokens: 7, outputTokens: 3, sessionCost: 0 });
	});

	test("failed fallback candidate never replaces the most recent model that produced output", async () => {
		const fixture = cold([
			HEADER,
			entry("model_change", "served-model", null, { model: "provider/served@route", resolvedModelIsFallback: true }),
			entry("message", "served", "served-model", { message: assistant({ usage: usage(4, 2, 0.1) }) }),
			entry("model_change", "candidate", "served", { model: "other/candidate:high", role: "fallback" }),
			entry("message", "failed", "candidate", { message: assistant({ provider: "other", model: "candidate",
				stopReason: "aborted", content: [{ type: "text", text: "partial" }], usage: usage(3, 1, 0.05) }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ model: "provider/served@route", effort: null,
			requests: 1, inputTokens: 4, outputTokens: 2, sessionCost: 0.1 });
	});

	test("legacy entries use native in-memory migration without writing or deriving selector effort", async () => {
		const fixture = cold([
			{ ...HEADER, version: 1 },
			{ type: "thinking_level_change", thinkingLevel: "off", timestamp: HEADER.timestamp },
			{ type: "model_change", model: "provider/served:high", timestamp: HEADER.timestamp },
			{ type: "message", message: assistant({ usage: usage(3, 2, 0) }), timestamp: HEADER.timestamp },
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/served", effort: "off",
			requests: 1, inputTokens: 3, outputTokens: 2, sessionCost: 0 });
	});

	test("latest unknown applied effort stays null despite configured auto or selector hints", async () => {
		const fixture = cold([
			HEADER,
			entry("thinking_level_change", "known", null, { thinkingLevel: "high" }),
			entry("model_change", "model", "known", { model: "p/m:max" }),
			entry("thinking_level_change", "unknown", "model", { thinkingLevel: null, configured: "auto" }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ model: "p/m", effort: null });
	});

	test("native compaction active window retains adjacent model_usage but drops discarded messages", async () => {
		const records = [
			HEADER,
			entry("message", "discarded", null, { message: assistant({ usage: usage(100, 10, 10) }) }),
			entry("model_usage", "adjacent", "discarded", { usage: usage(6, 2, 0.25) }),
			entry("thinking_level_change", "effort", "adjacent", { thinkingLevel: "high" }),
			entry("message", "kept", "effort", { message: assistant({ usage: usage(12, 3, 0.5) }) }),
			entry("message", "task", "kept", { message: { role: "toolResult", toolName: "task", toolCallId: "t",
				content: [{ type: "text", text: "done" }], timestamp: 2, details: { usage: usage(20, 4, 0.5) } } }),
			entry("compaction", "compact", "task", { firstKeptEntryId: "kept", summary: "summary", tokensBefore: 900, tokensAfter: 100 }),
			entry("model_usage", "after-hidden", "compact", { usage: usage(1, 1, 0.125) }),
			entry("message", "after", "after-hidden", { message: assistant({ usage: usage(8, 2, 0.25), timestamp: 3 }) }),
		];
		const fixture = cold(records);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		const messages = buildSessionContext(records.slice(1) as SessionEntry[]).messages;
		expect(messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/served", effort: "high",
			requests: 2, inputTokens: 47, outputTokens: 12, sessionCost: 1.625 });
	});

	test("reset after compaction overrides its kept window for messages and hidden model calls", async () => {
		const fixture = cold([
			HEADER,
			entry("message", "old", null, { message: assistant({ usage: usage(100, 50, 9),
				contextSnapshot: { promptTokens: 5000, nonMessageTokens: 100 } }) }),
			entry("compaction", "compact", "old", { firstKeptEntryId: "old", summary: "summary", tokensBefore: 5000 }),
			entry("reset_boundary", "reset", "compact"),
			entry("model_usage", "hidden", "reset", { usage: usage(4, 1, 0) }),
			entry("message", "new", "hidden", { message: assistant({ usage: usage(6, 2, 0), timestamp: 2 }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 3,
			sessionCost: 0, contextTokens: null, contextWindow: null });
	});

	test("native remote compaction does not re-account provider replacement history as assistant requests", async () => {
		const fixture = cold([
			HEADER,
			entry("message", "old", null, { message: assistant({ usage: usage(100, 50, 9) }) }),
			entry("reset_boundary", "reset", "old"),
			entry("message", "retained", "reset", { message: assistant({ usage: usage(20, 4, 0.5) }) }),
			entry("model_usage", "hidden", "retained", { usage: usage(2, 1, 0.125) }),
			entry("compaction", "compact", "hidden", { firstKeptEntryId: "retained", summary: "summary", tokensBefore: 200,
				preserveData: { openaiRemoteCompaction: { provider: "provider", replacementHistory: [{ role: "assistant", content: "remote" }] } } }),
			entry("message", "after", "compact", { message: assistant({ usage: usage(6, 2, 0.25), timestamp: 2 }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ requests: 1, inputTokens: 8, outputTokens: 3, sessionCost: 0.375 });
	});

	test("retry-recovered and empty-error assistants follow the native active message projection", async () => {
		const fixture = cold([
			HEADER,
			entry("message", "recovered", null, { message: assistant({ usage: usage(100, 10, 5),
				retryRecovery: { kind: "auto-retry", status: "recovered" } }) }),
			entry("message", "empty", "recovered", { message: assistant({ usage: usage(100, 0, 5), content: [], stopReason: "error" }) }),
			entry("message", "good", "empty", { message: assistant({ usage: usage(7, 3, 0), timestamp: 2 }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 3, sessionCost: 0 });
	});

	test("cold context uses only explicit persisted observations, never capacity or total tokens", async () => {
		const fixture = cold([
			HEADER,
			entry("message", "older", null, { message: assistant({ usage: { ...usage(100, 20, 0), contextTokens: 900 } }) }),
			entry("message", "anchor", "older", { message: assistant({ usage: usage(40, 30, 0),
				contextSnapshot: { promptTokens: 1500, nonMessageTokens: 200, historyRewriteTokensRemoved: 100 } }) }),
			entry("message", "failed", "anchor", { message: assistant({ stopReason: "aborted", usage: { ...usage(10, 2, 0), contextTokens: 9999 } }) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ contextTokens: 1400, contextWindow: null, tokensPerSecond: null });
		const explicit = cold([HEADER, entry("message", "a", null, { message: assistant({ usage: { ...usage(20, 10, 0), contextTokens: 0 } }) })]);
		const other = ref("Other");
		await explicit.telemetry.restore(other);
		expect(explicit.telemetry.sample(other).contextTokens).toBe(0);
	});

	test("pre-compaction anchors and estimated tokensAfter do not fabricate current cold context", async () => {
		const fixture = cold([
			HEADER,
			entry("message", "a", null, { message: assistant({ usage: { ...usage(20, 10, 0), contextTokens: 999 } }) }),
			entry("compaction", "c", "a", { firstKeptEntryId: "a", summary: "summary", tokensBefore: 999, tokensAfter: 123 }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child).contextTokens).toBeNull();
	});

	test("unknown or invalid cold usage stays null while valid zero spend remains zero", async () => {
		const missing = cold([HEADER, entry("message", "a", null, { message: assistant() })]);
		const first = ref("First");
		await missing.telemetry.restore(first);
		expect(missing.telemetry.sample(first)).toMatchObject({ requests: 1, inputTokens: null, outputTokens: null, sessionCost: null });
		const invalid = cold([HEADER,
			entry("message", "a", null, { message: assistant({ usage: { ...usage(-1, 2, 0), cost: { total: NaN } } }) }),
			entry("model_usage", "u", "a", { usage: usage(5, 3, 0) }),
		]);
		const second = ref("Second");
		await invalid.telemetry.restore(second);
		expect(invalid.telemetry.sample(second)).toMatchObject({ requests: 1, inputTokens: null, outputTokens: 5, sessionCost: null });
		const zero = cold([HEADER, entry("model_usage", "u", null, { usage: usage(0, 0, 0) })]);
		const third = ref("Third");
		await zero.telemetry.restore(third);
		expect(zero.telemetry.sample(third)).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0, sessionCost: 0 });
	});

	test("incomplete task-result shapes are ignored like native accounting, never assigned requests", async () => {
		const fixture = cold([HEADER,
			entry("message", "t", null, { message: { role: "toolResult", toolName: "task", toolCallId: "t", timestamp: 1,
				content: [{ type: "text", text: "done" }], details: { usage: { input: 20, output: 10, cost: { total: 1 } } } } }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, requests: 0 });
	});

	test("numeric cold usage without cost never becomes zero spend through other free calls", async () => {
		const fixture = cold([HEADER,
			entry("message", "a", null, { message: assistant({ usage: { input: 4, output: 2,
				cacheRead: 0, cacheWrite: 0, totalTokens: 6 } }) }),
			entry("model_usage", "u", "a", { usage: usage(0, 0, 0) }),
		]);
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toMatchObject({ requests: 1, inputTokens: 4, outputTokens: 2, sessionCost: null });
	});

	test("cycles stop at the first repeated entry; a replacement object does its own restoration", async () => {
		const fixture = cold([HEADER,
			entry("message", "a", "b", { message: assistant({ usage: usage(1, 2, 0) }) }),
			entry("model_usage", "b", "a", { usage: usage(3, 4, 0) }),
		]);
		const first = ref("Child");
		await fixture.telemetry.restore(first);
		expect(fixture.telemetry.sample(first)).toMatchObject({ requests: 1, inputTokens: 4, outputTokens: 6 });
		const replacement = ref("Child");
		expect(fixture.telemetry.sample(replacement)).toEqual(EMPTY);
		await fixture.telemetry.restore(replacement);
		expect(fixture.loads()).toBe(2);
	});
});

describe("restore failure and lifecycle isolation", () => {
	test("missing exports, unreadable files, empty records and failed builders never reject", async () => {
		const child = ref("Child");
		const missing = new AgentTelemetry({}, noRead);
		await expect(missing.restore(child)).resolves.toBeUndefined();
		expect(missing.sample(child)).toEqual(EMPTY);
		for (const failure of [
			cold([], { readChild: async () => { throw new Error("canonical ownership lost"); } }),
			cold([], { api: { loadEntriesFromFile: async () => { throw new Error("read failed"); } } }),
			cold([]),
			cold([HEADER, entry("model_change", "m", null, { model: "p/m:high" })], { api: { buildSessionContext: undefined } }),
			cold([HEADER, entry("model_change", "m", null, { model: "p/m:high" })], { api: { buildSessionContext() { throw new Error("bad context"); } } }),
		]) {
			await expect(failure.telemetry.restore(child)).resolves.toBeUndefined();
			expect(failure.telemetry.sample(child)).toMatchObject({ inputTokens: null, outputTokens: null, sessionCost: null,
				contextTokens: null, contextWindow: null, tokensPerSecond: null });
		}
	});

	test("throwing nested live telemetry properties are isolated per observation", () => {
		const telemetry = new AgentTelemetry({}, noRead);
		const child = ref("Child", {
			servingModel: { get modelIdentity() { throw new Error("identity"); }, thinkingLevel: "unsupported" },
			model: { provider: "p", id: "m" }, thinkingLevel: "auto",
			getSessionStats: () => ({ assistantMessages: 2, get tokens() { throw new Error("tokens"); },
				cost: 0, contextUsage: { get tokens() { throw new Error("context"); }, contextWindow: 4096 } }),
			get tokenRate() { throw new Error("rate"); },
		});
		expect(telemetry.sample(child)).toEqual({ ...EMPTY, model: "p/m", requests: 2, sessionCost: 0, contextWindow: 4096 });
	});

	test("optional attribution failure still recovers independently available usage", async () => {
		const fixture = cold([HEADER,
			entry("model_change", "m", null, { model: "p/m:high" }),
			entry("message", "a", "m", { message: assistant({ usage: usage(2, 1, 0) }) }),
		], { api: { assistantTurnProducedOutput() { throw new Error("optional identity failure"); } } });
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "p/m", requests: 1, inputTokens: 2, outputTokens: 1, sessionCost: 0 });
	});

	test("pending restore is single-flight and clear invalidates completion before a new restore", async () => {
		const first = deferred<unknown[]>();
		const second = deferred<unknown[]>();
		let calls = 0;
		const fixture = cold([], { api: { loadEntriesFromFile: () => ++calls === 1 ? first.promise : second.promise } });
		const child = ref("Child");
		const pending = fixture.telemetry.restore(child);
		expect(fixture.telemetry.restore(child)).toBe(pending);
		expect(calls).toBe(1);
		fixture.telemetry.clear();
		const newPending = fixture.telemetry.restore(child);
		expect(calls).toBe(2);
		first.resolve([HEADER, entry("model_change", "m", null, { model: "old/model" })]);
		await pending;
		expect(fixture.telemetry.sample(child)).toEqual(EMPTY);
		expect(fixture.telemetry.restore(child)).toBe(newPending);
		second.resolve([HEADER, entry("model_change", "m", null, { model: "new/model" })]);
		await newPending;
		expect(fixture.telemetry.sample(child).model).toBe("new/model");
	});

	test("failed reads are retryable rather than cached as fabricated empty telemetry", async () => {
		let attempt = 0;
		const fixture = cold([], { api: { loadEntriesFromFile: async () => {
			if (++attempt === 1) throw new Error("transient read");
			return [HEADER, entry("model_change", "m", null, { model: "p/m" })];
		} } });
		const child = ref("Child");
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child)).toEqual(EMPTY);
		await fixture.telemetry.restore(child);
		expect(fixture.telemetry.sample(child).model).toBe("p/m");
		expect(attempt).toBe(2);
	});

	test("post-read ref replacement rejection cannot attach telemetry to either object", async () => {
		const records = deferred<unknown[]>();
		const original = ref("Child");
		let registered = original;
		const readChild: ReadChild = async (agent, loader) => {
			const result = await loader(agent.sessionFile!);
			if (registered !== agent) throw new Error("stale ref");
			return result;
		};
		const fixture = cold([], { readChild, api: { loadEntriesFromFile: () => records.promise } });
		const pending = fixture.telemetry.restore(original);
		registered = ref("Child");
		records.resolve([HEADER, entry("model_change", "m", null, { model: "stale/model" })]);
		await pending;
		expect(fixture.telemetry.sample(original)).toEqual(EMPTY);
		expect(fixture.telemetry.sample(registered)).toEqual(EMPTY);
	});

	test("revival or session-path change during restore cannot overwrite live/new identity", async () => {
		for (const mode of ["live", "path"] as const) {
			const records = deferred<unknown[]>();
			const fixture = cold([], { api: { loadEntriesFromFile: () => records.promise } });
			const child = ref("Child");
			const pending = fixture.telemetry.restore(child);
			if (mode === "live") child.session = live({ stats: { assistantMessages: 9 }, rate: 7 }) as unknown as AgentRef["session"];
			else child.sessionFile = "/fixture/replaced.jsonl";
			records.resolve([HEADER, entry("model_change", "m", null, { model: "stale/model" })]);
			await pending;
			expect(fixture.telemetry.sample(child)).toEqual(mode === "live"
				? { ...EMPTY, model: "provider/configured", effort: "medium", requests: 9, tokensPerSecond: 7 } : EMPTY);
		}
	});

	test("live observation during a pending restore wins even if ref is parked again before read returns", async () => {
		const records = deferred<unknown[]>();
		const fixture = cold([], { api: { loadEntriesFromFile: () => records.promise } });
		const child = ref("Child");
		const pending = fixture.telemetry.restore(child);
		child.session = live({ stats: { assistantMessages: 8, cost: 0.5 } }) as unknown as AgentRef["session"];
		fixture.telemetry.sample(child);
		child.session = null;
		records.resolve([HEADER, entry("model_change", "m", null, { model: "stale/model" })]);
		await pending;
		expect(fixture.telemetry.sample(child)).toEqual({ ...EMPTY, model: "provider/configured", effort: "medium", requests: 8, sessionCost: 0.5 });
	});
});

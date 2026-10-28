import { describe, expect, test } from "bun:test";
import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { EPOCH_ENTRY_TYPE, type FactsIdentity, type ToolTiming, branchFacts, derivedUuid, epochEntryId, firstInputSample, hasConversation, prevToolDurations, requestFacts, resetEntryIds } from "../src/claude-facts";

// Vectors ported from the archived 8.1 OMP tree: coding-agent/test/session-claude-code-provenance.test.ts,
// ai/test/claude-code-provenance.test.ts ("source snapshot selection") and
// agent/test/agent-side-request-context.test.ts ("Agent producer provenance"). All inputs are synthetic.

type AgentMessage = ContextEvent["messages"][number];
const identity: Omit<FactsIdentity, "ompSessionId"> = { agentId: "Main", parentOmpSessionId: null, requestClass: "main", querySource: "agent" };
const user = (content: string | { type: "text"; text: string }[], timestamp: number, extra: Record<string, unknown> = { attribution: "user" }) =>
	({ role: "user", content, timestamp, ...extra }) as AgentMessage & { role: "user" };
const assistant = (timestamp = 3) => ({
	role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "anthropic", model: "local-fixture",
	responseId: "msg_local", stopReason: "stop", timestamp,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as AgentMessage & { role: "assistant" };
const epoch = (manager: SessionManager) => manager.appendCustomEntry(EPOCH_ENTRY_TYPE, { ompVersion: "18.13.2" });
const facts = (manager: SessionManager, tail: AgentMessage[] = []) =>
	requestFacts([...manager.buildSessionContext().messages, ...tail], manager.getBranch(), { ...identity, ompSessionId: manager.getSessionId() });
const factsOf = (manager: SessionManager, id: string) => branchFacts(manager.getBranch()).get(id);
const persist = (manager: SessionManager, message: AgentMessage) => manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);

describe("durable producer facts (session vectors)", () => {
	test("reselects summary T0 while retaining absolute positions and source ids through restart", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/fixture", "/fixture/sessions", storage);
		epoch(manager);
		const first = user("first source input with distinct fingerprint", 1);
		const firstId = manager.appendMessage(first);
		const secondId = manager.appendMessage(user("second source input", 2));
		const retained = manager.appendMessage(assistant());
		const before = facts(manager);
		expect(before.firstEligible).toEqual({ messageId: factsOf(manager, firstId)!.sourceMessageId, textBlockIndex: null, sample: firstInputSample(first.content as string) });
		expect(before.previousMessageId).toBe("msg_local");
		expect(before.prompt.position).toEqual({ promptIndex: 2, turnIndex: 2 });
		const summary = "summary is the new first eligible source input";
		const summaryId = manager.appendCompaction(summary, undefined, retained, 100);
		const compacted = facts(manager);
		expect(compacted.firstEligible).toEqual({ messageId: derivedUuid("omp-noli/summary", summaryId), textBlockIndex: null, sample: firstInputSample(summary) });
		expect(compacted.prompt).toEqual({ id: factsOf(manager, secondId)!.promptId!, origin: "human", position: { promptIndex: 2, turnIndex: 2 } });
		expect(factsOf(manager, summaryId)?.summarizedTurnPromptUuids).toEqual([factsOf(manager, secondId)!.sourceMessageId]);
		const nextId = manager.appendMessage(user("after compaction", 4));
		expect(factsOf(manager, nextId)?.turnPosition).toEqual({ promptIndex: 3, turnIndex: 3 });
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!, "/fixture/sessions", storage);
		expect(facts(reopened)).toEqual(facts(manager));
		expect(factsOf(reopened, nextId)).toEqual(factsOf(manager, nextId));
	});

	test("keeps history before the epoch unknown rather than inventing absolute counters", async () => {
		const storage = new MemorySessionStorage();
		const file = "/fixture/sessions/legacy.jsonl";
		storage.writeTextSync(file, [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "legacy-producer", cwd: "/fixture", timestamp: "2026-01-01T00:00:00Z" },
			{ type: "message", id: "old-input", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: user("imported without producer facts", 1) },
		].map(value => JSON.stringify(value)).join("\n") + "\n");
		const manager = await SessionManager.open(file, "/fixture/sessions", storage);
		expect(hasConversation(manager.getBranch())).toBe(true);
		expect(facts(manager).firstEligible).toBeNull();
		epoch(manager);
		const nextId = manager.appendMessage(user("delivered after import", 2));
		expect(factsOf(manager, nextId)?.sourceMessageId).toBeTruthy();
		expect(factsOf(manager, nextId)?.turnPosition).toBeUndefined();
		expect(factsOf(manager, "old-input")).toBeNull();
		expect(facts(manager).firstEligible).toBeNull();
		expect(facts(manager).prompt.position).toBeNull();
		expect(facts(manager, [user("unpersisted after import", 3)]).prompt.position).toBeNull();
	});

	test("reset boundaries restart counters, follow tree navigation, and survive a full fork", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		const firstId = manager.appendMessage(user("before clear", 1));
		const resetId = manager.appendResetBoundary();
		expect(resetEntryIds(manager.getBranch())).toEqual([resetId]);
		const after = user("after clear", 2);
		const afterId = manager.appendMessage(after);
		const afterSource = factsOf(manager, afterId)!;
		expect(afterSource.turnPosition).toEqual({ promptIndex: 1, turnIndex: 1 });
		manager.branch(firstId);
		expect(resetEntryIds(manager.getBranch())).toEqual([]);
		expect(facts(manager).prompt.position).toEqual({ promptIndex: 1, turnIndex: 1 });
		manager.createBranchedSession(afterId);
		expect(epochEntryId(manager.getBranch())).not.toBeNull();
		expect(resetEntryIds(manager.getBranch())).toHaveLength(1);
		// Ids derive from the message itself, so a fork that copies entries keeps T0 and the prompt.
		expect(facts(manager).firstEligible).toEqual({ messageId: afterSource.sourceMessageId, textBlockIndex: null, sample: firstInputSample("after clear") });
		expect(facts(manager).prompt).toEqual({ id: afterSource.promptId!, origin: "human", position: { promptIndex: 1, turnIndex: 1 } });
	});
});

describe("source snapshot selection (ai vectors)", () => {
	test("distinguishes unknown history from a known empty or no-text first input", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		expect(facts(manager).firstEligible).toEqual({ messageId: null, textBlockIndex: null, sample: firstInputSample("") });
		const imageOnly = { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], attribution: "user", timestamp: 1 } as AgentMessage;
		const imageId = persist(manager, imageOnly);
		manager.appendMessage(user("later text must not win", 2));
		expect(facts(manager).firstEligible).toEqual({ messageId: factsOf(manager, imageId)!.sourceMessageId, textBlockIndex: null, sample: "000" });
	});

	test("skips meta input, keeps the first empty text block, and retains a zero prompt index", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		manager.appendMessage({ role: "developer", content: "metadata", timestamp: 1 });
		const emptyId = manager.appendMessage(user([{ type: "text", text: "" }, { type: "text", text: "must not win" }], 2, {}));
		const snapshot = facts(manager);
		expect(snapshot.firstEligible).toEqual({ messageId: factsOf(manager, emptyId)!.sourceMessageId, textBlockIndex: 0, sample: firstInputSample("") });
		// An Agent.prompt(string)-shaped input is "sdk" under the design §5.3 mapping (wt classified it "unknown").
		expect(snapshot.prompt).toEqual({ id: factsOf(manager, emptyId)!.sourceMessageId, origin: "sdk", position: { promptIndex: 0, turnIndex: 1 } });
	});

	test("samples UTF-16 code units 4, 7 and 20 with lone surrogates as U+FFFD", () => {
		expect(firstInputSample("")).toBe("000");
		expect(firstInputSample("abcdefgh")).toBe("eh0");
		expect(firstInputSample("abcdefghijklmnopqrstuvwxyz")).toBe("ehu");
		expect(firstInputSample("abcd\u{1F600}")).toBe("\uFFFD00");
	});
});

describe("delivery before persistence (agent vectors)", () => {
	test("an unpersisted delivered prompt continues the walk and equals its persisted facts", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		manager.appendMessage(user("first", 1));
		manager.appendMessage(assistant(2));
		const meta = { role: "developer", content: "meta", timestamp: 3 } as AgentMessage;
		const prompt = user([{ type: "text", text: "" }, { type: "text", text: "not T0" }], 4);
		const live = facts(manager, [meta, prompt]);
		expect(live.prompt.position).toEqual({ promptIndex: 2, turnIndex: 2 });
		persist(manager, meta);
		const promptId = persist(manager, prompt);
		expect(facts(manager)).toEqual({ ...live, branchAnchor: promptId, historyRevision: manager.getBranch().length });
		expect(live.prompt.id).toBe(factsOf(manager, promptId)!.promptId!);
	});

	test("a fresh session's first prompt is T0 at position 1/1 even before an epoch exists", () => {
		const manager = SessionManager.inMemory("/fixture");
		const fresh = facts(manager, [{ role: "developer", content: "meta", timestamp: 1 } as AgentMessage, user([{ type: "text", text: "" }, { type: "text", text: "not T0" }], 2)]);
		expect(fresh.firstEligible).toEqual({ messageId: expect.any(String), textBlockIndex: 0, sample: firstInputSample("") });
		expect(fresh.prompt.position).toEqual({ promptIndex: 1, turnIndex: 1 });
	});

	test("a message injected for one call only is not a source input", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		const firstId = manager.appendMessage(user("persisted first", 1));
		manager.appendMessage(assistant(2));
		const [persistedFirst, ...rest] = manager.buildSessionContext().messages;
		const injected = user("per-call extension context", 0, { attribution: "agent" });
		const snapshot = requestFacts([injected, persistedFirst!, ...rest], manager.getBranch(), { ...identity, ompSessionId: manager.getSessionId() });
		expect(snapshot.firstEligible?.messageId).toBe(factsOf(manager, firstId)!.sourceMessageId);
	});
});

describe("origin mapping from observable fields (design §5.3)", () => {
	test("each stock source maps to its origin and position", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		const ids = [
			manager.appendMessage(user("human", 1)),
			manager.appendCustomMessageEntry("irc:incoming", "wake", true, { wakeRelay: true }, "agent", 2),
			manager.appendCustomMessageEntry("irc:incoming", "from parent", true, { fromParent: true }, "agent", 3),
			manager.appendCustomMessageEntry("irc:incoming", "peer", true, { from: "peer" }, "agent", 4),
			manager.appendMessage(user("parent steer", 5, { attribution: "agent", steering: true })),
			manager.appendCustomMessageEntry("launch-completion", "daemon exited", true, { daemons: [] }, "agent", 6),
			manager.appendMessage({ role: "developer", content: [{ type: "text", text: "continue" }], attribution: "agent", synthetic: true, timestamp: 7 }),
			manager.appendMessage(user("synthetic", 8, { attribution: "agent", synthetic: true })),
			manager.appendMessage(user("sdk prompt", 9, { attribution: "agent" })),
			manager.appendMessage({ role: "developer", content: "reminder", attribution: "agent", timestamp: 10 }),
			manager.appendCustomMessageEntry("extension-note", "note", false, undefined, "agent", 11),
			manager.appendMessage(user("human again", 12)),
		];
		const all = ids.map(id => factsOf(manager, id)!);
		expect(all.map(entry => entry.turnOrigin ?? null)).toEqual([
			"human", "task_notification", "peer", "peer", "peer", "task_notification", "auto_continuation", "host_synthetic", "sdk", null, null, "human",
		]);
		expect(all.map(entry => entry.turnPosition ?? null)).toEqual([
			{ promptIndex: 1, turnIndex: 1 }, { promptIndex: 1, turnIndex: 2 }, { promptIndex: 1, turnIndex: 3 }, { promptIndex: 1, turnIndex: 4 },
			{ promptIndex: 1, turnIndex: 5 }, { promptIndex: 1, turnIndex: 6 }, { promptIndex: 1, turnIndex: 7 }, { promptIndex: 1, turnIndex: 8 },
			{ promptIndex: 1, turnIndex: 9 }, null, null, { promptIndex: 2, turnIndex: 10 },
		]);
		expect(all.map(entry => entry.isMeta)).toEqual([false, false, false, false, false, false, false, false, false, true, true, false]);
		expect(all[8]!.promptId).toBe(all[8]!.sourceMessageId);
		expect(all[1]!.promptId).toBeUndefined();
	});

	test("compaction facts come from the preparation's summarized messages", () => {
		const manager = SessionManager.inMemory("/fixture");
		epoch(manager);
		const firstId = manager.appendMessage(user("summarized input", 1));
		manager.appendMessage(assistant(2));
		const messages = manager.buildSessionContext().messages;
		const compaction = requestFacts(messages, manager.getBranch(), { ...identity, ompSessionId: manager.getSessionId(), requestClass: "compaction", querySource: "compaction" });
		expect(compaction).toMatchObject({ requestClass: "compaction", querySource: "compaction", previousMessageId: "msg_local", firstEligible: { messageId: factsOf(manager, firstId)!.sourceMessageId } });
	});
});

describe("previous tool durations (Claude Code prevToolDurations)", () => {
	const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
	const batch = (calls: ReturnType<typeof call>[], stopReason = "toolUse") => ({ ...assistant(10), content: calls, stopReason }) as unknown as AgentMessage;
	const result = (id: string, name: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp: 11 }) as unknown as AgentMessage;
	const timing = (start: number, end: number | undefined, executed = true, epoch = 0): ToolTiming => ({ start, end, executed, epoch });
	const durations = (messages: AgentMessage[], timings: Record<string, ToolTiming>, epoch = 0, branch: SessionEntry[] = []) =>
		prevToolDurations(messages, branch, new Map(Object.entries(timings)), epoch);

	test("a single executed tool yields max(0, round(end - start))", () => {
		expect(durations([user("go", 1), batch([call("t1", "read")]), result("t1", "read")], { t1: timing(1000, 1005) })).toEqual([{ toolName: "read", durationMs: 5 }]);
		expect(durations([batch([call("t1", "read")])], { t1: timing(1000, 999.4) })).toEqual([{ toolName: "read", durationMs: 0 }]);
	});

	test("parallel tools are ordered by completion, ties in tool_use order", () => {
		const messages = [batch([call("a", "grep"), call("b", "read"), call("c", "bash")])];
		expect(durations(messages, { a: timing(0, 30), b: timing(0, 10), c: timing(5, 10) })).toEqual([
			{ toolName: "read", durationMs: 10 }, { toolName: "bash", durationMs: 5 }, { toolName: "grep", durationMs: 30 },
		]);
	});

	test("more than 32 executed tools keep the first 32 to complete", () => {
		const calls = Array.from({ length: 40 }, (_, index) => call(`t${index}`, `tool_${index}`));
		const timings = Object.fromEntries(calls.map((entry, index) => [entry.id, timing(0, 100 - index)]));
		const result32 = durations([batch(calls)], timings)!;
		expect(result32).toHaveLength(32);
		expect(result32[0]).toEqual({ toolName: "tool_39", durationMs: 61 });
		expect(result32.at(-1)).toEqual({ toolName: "tool_8", durationMs: 92 });
	});

	test("a tool that threw is included; denied, unknown or unfinished tools are not", () => {
		const messages = [batch([call("err", "bash"), call("denied", "write"), call("unknown", "no_such_tool"), call("running", "read")])];
		expect(durations(messages, { err: timing(0, 7), denied: timing(0, 1, false), unknown: timing(0, 1, false), running: timing(0, undefined) })).toEqual([{ toolName: "bash", durationMs: 7 }]);
		expect(durations(messages, { denied: timing(0, 1, false) })).toBeUndefined();
	});

	test("timings from before a reset (new prompt, overflow compaction) are never emitted", () => {
		expect(durations([batch([call("t1", "read")])], { t1: timing(0, 5, true, 0) }, 1)).toBeUndefined();
	});

	test("only the batch the request directly follows counts; retries repeat it; an error reply is skipped", () => {
		const timings = { t1: timing(0, 5), t2: timing(10, 12) };
		const first = [batch([call("t1", "read")]), result("t1", "read")];
		const retried = [...first, { ...assistant(12), stopReason: "error", content: [] } as unknown as AgentMessage];
		expect(durations(first, timings)).toEqual(durations(retried, timings));
		const second = [...first, batch([call("t2", "edit")]), result("t2", "edit")];
		expect(durations(second, timings)).toEqual([{ toolName: "edit", durationMs: 2 }]);
		expect(durations([...second, assistant(13)], timings)).toBeUndefined();
	});

	test("a start persisted on the branch wins over the in-memory delivery time", () => {
		const manager = SessionManager.inMemory("/fixture");
		manager.appendCustomEntry("tool_execution_start", { toolCallId: "t1", toolName: "read", startedAt: new Date(1_000).toISOString() });
		expect(durations([batch([call("t1", "read")])], { t1: timing(1_002, 1_009) }, 0, manager.getBranch())).toEqual([{ toolName: "read", durationMs: 9 }]);
	});
});

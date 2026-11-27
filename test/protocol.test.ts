import { describe, expect, test } from "bun:test";
import { CAPABILITY_NAMES } from "../src/protocol";
import { assertValidFrame } from "./schema";

describe("schema matches src/protocol.ts", () => {
	test("producer registration requires protocol 1 and its nonoptional capability", () => {
		const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { available: true, api: name === "gateway.native.provenance" ? "native-provenance-v1" : name === "host.thread_read" ? "main-only-v1" : name === "host.thread_open" || name === "host.attach_file" || name === "host.forge_watch" ? "main-only-v1" : name === "host.model_roles" ? "session-v1" : name.startsWith("host.forge_") ? "session-v1" : "public", detail: "synthetic" }]));
		const hello = (protocol: number, caps = capabilities) => ({ type: "response", id: 1, ok: true, result: { protocol, sessionId: "s", pid: 1, capabilities: caps } });
		expect(() => assertValidFrame(hello(1))).not.toThrow();
		expect(() => assertValidFrame(hello(0))).toThrow();
		for (const state of [{ available: true, detail: "invalid API" }, { available: false, reason: "not_ready", detail: "invalid API" }]) {
			expect(() => assertValidFrame(hello(1, { ...capabilities, "gateway.native.provenance": { ...state, api: "public" } }))).toThrow();
		}
		const { "gateway.request.register": _registration, ...missing } = capabilities;
		expect(() => assertValidFrame(hello(1, missing))).toThrow();
	});
	test("thread-opening rejects incompatible APIs even while unavailable", () => {
		const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { available: true, api: name === "gateway.native.provenance" ? "native-provenance-v1" : name === "host.thread_read" ? "main-only-v1" : name === "host.attach_file" || name === "host.forge_watch" ? "main-only-v1" : name === "host.model_roles" ? "session-v1" : name.startsWith("host.forge_") ? "session-v1" : "public", detail: "public" }]));
		for (const state of [{ available: true, detail: "opening" }, { available: false, reason: "not_ready", detail: "not ready" }]) {
			const frame = (api: string) => ({ type: "event", event: "capabilities.changed", sessionId: "s", capabilities: { ...capabilities, "host.thread_open": { ...state, api } } });
			expect(() => assertValidFrame(frame("main-only-v1"))).not.toThrow();
			for (const api of ["public", "internal", "session-v1"]) expect(() => assertValidFrame(frame(api))).toThrow();
		}
	});
	test.each(["host.forge_resource", "host.forge_read", "host.forge_write", "host.forge_watch", "host.model_roles"] as const)("optional %s requires its negotiated API in both availability states", capability => {
		const capabilities = Object.fromEntries(CAPABILITY_NAMES.filter(name => name !== capability).map(name => [name, { available: true, api: name === "gateway.native.provenance" ? "native-provenance-v1" : name === "host.thread_read" ? "main-only-v1" : name === "host.thread_open" || name === "host.attach_file" ? "main-only-v1" : name === "host.forge_watch" ? "main-only-v1" : name === "host.model_roles" ? "session-v1" : name.startsWith("host.forge_") ? "session-v1" : "public", detail: "test" }]));
		const expectedApi = capability === "host.forge_watch" ? "main-only-v1" : capability === "host.model_roles" ? "session-v1" : "session-v1";
		const frame = (caps: unknown) => ({ type: "event", event: "capabilities.changed", sessionId: "s", capabilities: caps });
		expect(() => assertValidFrame(frame(capabilities))).not.toThrow();
		for (const state of [{ available: true, detail: "guard" }, { available: false, reason: "not_ready", detail: "not ready" }]) {
			expect(() => assertValidFrame(frame({ ...capabilities, [capability]: { ...state, api: expectedApi } }))).not.toThrow();
			for (const api of ["public", "internal", "main-only-v1", "session-v1", undefined].filter(api => api !== expectedApi)) expect(() => assertValidFrame(frame({ ...capabilities, [capability]: { ...state, api } }))).toThrow();
		}
	});
});

describe("schema rejects frames that would leak host internals or drift", () => {
	const agent = {
		id: "a",
		name: "a",
		kind: "sub",
		parentId: "Main",
		state: "idle",
		live: true,
		streaming: false,
		activity: null,
		definition: "task",
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
	};
	const event = (a: unknown) => ({ type: "event", event: "agent.changed", sessionId: "s", agent: a });

	test("an extra field such as sessionFile is rejected", () => {
		expect(() => assertValidFrame(event({ ...agent, sessionFile: "/tmp/x.jsonl" }))).toThrow();
	});

	test("a raw host status such as aborted is rejected", () => {
		expect(() => assertValidFrame(event({ ...agent, state: "aborted" }))).toThrow();
	});

	test("unadvertised unsupported methods allow bare errors; capability metadata remains paired", () => {
		const response = (error: unknown) => ({ type: "response", id: 1, ok: false, error });
		expect(() => assertValidFrame(response({ code: "capability_unavailable", message: "x" }))).not.toThrow();
		expect(() => assertValidFrame(response({ code: "capability_unavailable", message: "x", capability: "goal.budget" }))).toThrow();
		expect(() => assertValidFrame(response({ code: "capability_unavailable", message: "x", capability: "agents.kill.parked", reason: "tool_missing" }))).not.toThrow();
		expect(() => assertValidFrame(response({ code: "busy", message: "x", reason: "tool_missing" }))).toThrow();
	});
});

describe("protocol-1 producer frames", () => {
	const facts = {
		version: 1, producerSessionId: "root", branchAnchor: "leaf", historyRevision: 3, producerAgentId: "Main", parentProducerSessionId: null,
		requestClass: "main", querySource: "agent", previousMessageId: "msg_01abc",
		firstEligible: { messageId: "6f1c0b8e-6d0e-4b9a-8f43-2f6a1c7d9e10", textBlockIndex: 0, sample: "ts0" },
		prompt: { id: "6f1c0b8e-6d0e-4b9a-8f43-2f6a1c7d9e10", origin: "human", position: { promptIndex: 1, turnIndex: 1 } },
	};
	const request = (method: string, params: unknown) => ({ type: "request", id: "producer:1", method, params });
	test("compaction begin requires bounded dispatch ownership and end cannot carry it", () => {
		const begin = { ompSessionId: "root", phase: "begin", dispatchSessionId: "root:side:compaction",
			facts: { ...facts, requestClass: "compaction", querySource: "compaction", compactionKind: "reactive" } };
		assertValidFrame(request("producer.compaction", begin));
		for (const dispatchSessionId of [undefined, null, "", 3, "x".repeat(1025)]) {
			expect(() => assertValidFrame(request("producer.compaction", { ...begin, dispatchSessionId }))).toThrow();
		}
		const end = { ompSessionId: "root", phase: "end", facts: null };
		assertValidFrame(request("producer.compaction", end));
		expect(() => assertValidFrame(request("producer.compaction", { ...end, dispatchSessionId: begin.dispatchSessionId }))).toThrow();
		expect(() => assertValidFrame(request("producer.compaction", { ...end, facts: begin.facts }))).toThrow();
	});
	test("producer-minted ownership and malformed native facts do not validate", () => {
		expect(() => assertValidFrame(request("gateway.request.register", { ompSessionId: "root", facts: { ...facts, ownership: { conversationId: "c" } } }))).toThrow();
		expect(() => assertValidFrame(request("gateway.request.register", { ompSessionId: "root", facts: { ...facts, firstEligible: { messageId: null, textBlockIndex: null, fingerprint: "abc" } } }))).toThrow();
		expect(() => assertValidFrame(request("gateway.request.register", { ompSessionId: "root", facts: { ...facts, prompt: { ...facts.prompt, position: { promptIndex: 1, turnIndex: 0 } } } }))).toThrow();
		expect(() => assertValidFrame(request("producer.session", { ompSessionId: "root", parentOmpSessionId: null, agentKind: "advisor", agentId: "Main", epochEntryId: null, ompVersion: "18.13.2", systemPrefix: null }))).toThrow();
	});
});

import { describe, expect, test } from "bun:test";
import {
	AGENT_KINDS,
	AGENT_STATES,
	CAPABILITY_NAMES,
	CAPABILITY_REASONS,
	DEFINITION_SOURCES,
	DISCOVERY_REASONS,
	DISCOVERY_STATUSES,
	ERROR_CODES,
	JOB_KINDS,
} from "../src/protocol";
import { assertValidFrame, schema } from "./schema";
import type { ServerFrame } from "../src/protocol";

describe("schema matches src/protocol.ts", () => {
	test("typed server frames include reverse gateway bind requests", () => {
		const frame: ServerFrame = { type: "request", id: "gateway:1", method: "gateway.bind", params: { sessionId: "s" } };
		expect(() => assertValidFrame(frame)).not.toThrow();
	});
	test.each([
		["CapabilityName", CAPABILITY_NAMES],
		["CapabilityReason", CAPABILITY_REASONS],
		["AgentKind", AGENT_KINDS],
		["AgentState", AGENT_STATES],
		["DiscoveryStatus", DISCOVERY_STATUSES],
		["DiscoveryReason", DISCOVERY_REASONS],
		["DefinitionSource", DEFINITION_SOURCES],
		["ErrorCode", ERROR_CODES],
		["JobKind", JOB_KINDS],
	] as const)("%s enum", (def, values) => {
		expect([...(schema.$defs[def]?.enum ?? [])].sort()).toEqual([...values].sort());
	});

	test("non-bootstrap capabilities are required while attachment remains explicitly negotiated", () => {
		const caps = schema.$defs.Capabilities as { required?: string[] };
		expect([...(caps.required ?? [])].sort()).toEqual(CAPABILITY_NAMES.filter(name => name !== "host.attach_file").sort());
	});
	test("thread-read capabilities validate v2 and reject legacy v1 for available and unavailable states", () => {
		const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { available: true, api: name === "host.thread_open" ? "main-only-v1" : "public", detail: "public" }]));
		for (const state of [{ available: true, detail: "reference reads" }, { available: false, reason: "not_ready", detail: "not ready" }]) {
			const frame = (api: string) => ({ type: "event", event: "capabilities.changed", sessionId: "s", capabilities: { ...capabilities, "host.thread_read": { ...state, api } } });
			expect(() => assertValidFrame(frame("main-only-v2"))).not.toThrow();
			expect(() => assertValidFrame(frame("main-only-v1"))).toThrow();
		}
	});
	test("thread-opening rejects incompatible APIs even while unavailable", () => {
		const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { available: true, api: name === "host.thread_read" ? "main-only-v2" : "public", detail: "public" }]));
		for (const state of [{ available: true, detail: "opening" }, { available: false, reason: "not_ready", detail: "not ready" }]) {
			const frame = (api: string) => ({ type: "event", event: "capabilities.changed", sessionId: "s", capabilities: { ...capabilities, "host.thread_open": { ...state, api } } });
			expect(() => assertValidFrame(frame("main-only-v1"))).not.toThrow();
			for (const api of ["public", "internal", "main-only-v2"]) expect(() => assertValidFrame(frame(api))).toThrow();
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

	test("a well-formed agent event validates", () => {
		expect(() => assertValidFrame(event(agent))).not.toThrow();
	});

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

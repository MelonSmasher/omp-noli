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

describe("schema matches src/protocol.ts", () => {
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

	test("every capability is required in a capability map", () => {
		const caps = schema.$defs.Capabilities as { required?: string[] };
		expect([...(caps.required ?? [])].sort()).toEqual([...CAPABILITY_NAMES].sort());
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

import { describe, expect, test } from "bun:test";
import { probeLifecycle, probeRosterReader } from "../src/capabilities";

const manager = { release: async () => true };
const sessionWith = (tools: Record<string, unknown>) => ({ getToolByName: (name: string) => tools[name] });

describe("probeLifecycle", () => {
	test("finds the host lifecycle manager through the task tool's ToolSession", () => {
		const result = probeLifecycle(sessionWith({ task: { session: { agentLifecycle: () => manager } } }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(manager);
	});

	test.each([
		["no session", undefined, /getToolByName/],
		["task tool absent", sessionWith({}), /task tool is not registered/],
		["task tool lost its session", sessionWith({ task: {} }), /no longer carries its ToolSession/],
		["agentLifecycle renamed", sessionWith({ task: { session: {} } }), /no agentLifecycle/],
		["agentLifecycle throws", sessionWith({ task: { session: { agentLifecycle: () => { throw new Error("boom"); } } } }), /threw: boom/],
		["manager lost release()", sessionWith({ task: { session: { agentLifecycle: () => ({}) } } }), /release\(\)/],
	])("reports unavailable instead of throwing: %s", (_label, session, detail) => {
		const result = probeLifecycle(session);
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(detail);
	});
});

describe("probeRosterReader", () => {
	test("finds an executable read tool", () => {
		const read = { execute: async () => ({}) };
		const result = probeRosterReader(sessionWith({ read }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(read);
	});

	test.each([
		["no session", undefined, /getToolByName/],
		["read tool absent (e.g. --no-tools)", sessionWith({}), /read tool is not registered/],
		["read tool lost execute()", sessionWith({ read: {} }), /no execute/],
	])("reports unavailable instead of throwing: %s", (_label, session, detail) => {
		const result = probeRosterReader(session);
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(detail);
	});
});

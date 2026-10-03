import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@oh-my-pi/pi-coding-agent";
import { installThreadControl } from "../src/thread-control";

function harness() {
	let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
	let prompt!: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined;
	let authed = true;
	let session = "owning-session";
	let source = "sdk";
	// Test seam supplies only the API members the guard consumes.
	const pi = {
		on(name: string, handler: unknown) {
			if (name === "tool_call") call = handler as typeof call;
			if (name === "tool_result") result = handler as typeof result;
			if (name === "before_agent_start") prompt = handler as typeof prompt;
		},
		getAllTools: () => ["noli_thread_get", "noli_thread_finish"].map(name => ({ name, sourceInfo: { source } })),
	} as unknown as ExtensionAPI;
	installThreadControl(pi, id => authed && id === "owning-session");
	const ctx = (kind = "main") => ({ agent: { kind }, sessionManager: { getSessionId: () => session } }) as unknown as ExtensionContext;
	const event: ToolCallEvent = { type: "tool_call", toolName: "noli_thread_finish", toolCallId: "call", input: { action: "archive" } };
	const reply: ToolResultEvent = { ...event, type: "tool_result", content: [{ type: "text", text: "scheduled" }], details: { status: "scheduled", requestId: "request", action: "archive" }, isError: false };
	return { call, result, prompt, ctx, event, reply, setAuth: (value: boolean) => { authed = value; }, setSession: (value: string) => { session = value; }, setSource: (value: string) => { source = value; } };
}

describe("current-thread host tool guard", () => {
	test("children and advisors cannot mutate or inspect the parent", () => {
		const h = harness();
		for (const kind of ["sub", "advisor", "unknown"]) for (const toolName of ["noli_thread_get", "noli_thread_finish"]) {
			expect(h.call({ ...h.event, toolName }, h.ctx(kind))?.block).toBe(true);
		}
	});
	test("unavailable authentication or non-host tools fail closed", () => {
		const h = harness(); h.setAuth(false);
		expect(h.call(h.event, h.ctx())?.reason).toContain("unavailable");
		h.setAuth(true); h.setSource("extension");
		expect(h.call(h.event, h.ctx())?.block).toBe(true);
	});
	test("target and caller injection and invalid actions are rejected", () => {
		const h = harness();
		for (const input of [{ action: "delete" }, { action: "archive", threadId: "foreign" }, { action: "settle", caller: "Main" }, { action: { toString: () => "archive" } }]) expect(h.call({ ...h.event, input }, h.ctx())?.block).toBe(true);
		expect(h.call({ ...h.event, toolName: "noli_thread_get", input: { threadId: "foreign" } }, h.ctx())?.block).toBe(true);
	});
	test("only matching backend scheduling acknowledgements count", () => {
		const h = harness();
		for (const details of [undefined, { status: "archived" }, { status: "scheduled", action: "settle", requestId: "request" }]) {
			h.call(h.event, h.ctx());
			expect(h.result({ ...h.reply, details }, h.ctx())?.isError).toBe(true);
		}
		h.call(h.event, h.ctx()); expect(h.result(h.reply, h.ctx())).toBeUndefined();
	});
	test("backend errors and cancellation cannot become success", () => {
		const h = harness();
		for (const text of ["permission denied", "Host tool was aborted"]) {
			h.call(h.event, h.ctx());
			expect(h.result({ ...h.reply, isError: true, content: [{ type: "text", text }], details: undefined }, h.ctx())).toBeUndefined();
			expect(h.result(h.reply, h.ctx())?.isError).toBe(true);
		}
	});
	test("old session and disconnected acknowledgement never succeed", () => {
		const h = harness(); h.call(h.event, h.ctx()); h.setSession("other");
		expect(h.result(h.reply, h.ctx())?.isError).toBe(true);
		expect(h.call(h.event, h.ctx())?.block).toBe(true);
		h.setSession("owning-session"); h.call(h.event, h.ctx()); h.setAuth(false);
		expect(h.result(h.reply, h.ctx())?.isError).toBe(true);
	});
	test("guidance is request-local deduplicated and authenticated main only", () => {
		const h = harness(); const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "done", systemPrompt: ["base"] };
		const first = h.prompt(event, h.ctx())!;
		expect(first.systemPrompt?.join()).toContain("skill://noli");
		expect(h.prompt({ ...event, systemPrompt: first.systemPrompt! }, h.ctx())?.systemPrompt).toEqual(first.systemPrompt);
		expect(h.prompt(event, h.ctx("sub"))).toBeUndefined(); h.setAuth(false);
		expect(h.prompt(event, h.ctx())).toBeUndefined();
	});
});

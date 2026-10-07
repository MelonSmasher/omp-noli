import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@oh-my-pi/pi-coding-agent";
import { installThreadControl } from "../src/thread-control";

/** Capture guard hooks with independently mutable authentication, session and SDK tool state. */
function harness() {
	let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
	let prompt!: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined;
	let authed = true;
	let session = "owning-session";
	let source = "sdk";
	let tools = ["noli_thread_get", "noli_thread_finish", "noli_attach_file", "noli_thread_read"];
	let readSource: string | undefined = "sdk";
	const lifecycle = new Map<string, () => void>();
	// Test seam supplies only the API members the guard consumes.
	const pi = {
		on(name: string, handler: unknown) {
			if (name === "tool_call") call = handler as typeof call;
			if (name === "tool_result") result = handler as typeof result;
			if (name === "before_agent_start") prompt = handler as typeof prompt;
			if (["session_switch", "session_branch", "session_tree", "session_shutdown"].includes(name)) lifecycle.set(name, handler as () => void);
		},
		getAllTools: () => tools.filter(name => name !== "noli_thread_read" || readSource !== undefined).map(name => ({ name, sourceInfo: { source: name === "noli_thread_read" ? readSource : source } })),
	} as unknown as ExtensionAPI;
	installThreadControl(pi, id => authed && id === "owning-session");
	const ctx = (kind = "main") => ({ agent: { kind }, sessionManager: { getSessionId: () => session } }) as unknown as ExtensionContext;
	const event: ToolCallEvent = { type: "tool_call", toolName: "noli_thread_finish", toolCallId: "call", input: { action: "archive" } };
	const reply: ToolResultEvent = { ...event, type: "tool_result", content: [{ type: "text", text: "scheduled" }], details: { status: "scheduled", requestId: "request", action: "archive" }, isError: false };
	return { call, result, prompt, ctx, event, reply, lifecycle, setTools: (value: string[]) => { tools = value; }, setAuth: (value: boolean) => { authed = value; }, setSession: (value: string) => { session = value; }, setSource: (value: string) => { source = value; }, setReadSource: (value: string | undefined) => { readSource = value; } };
}

describe("current-thread host tool guard", () => {
	test("children and advisors cannot mutate or inspect the parent", () => {
		const h = harness();
		for (const kind of ["sub", "advisor", "unknown"]) for (const toolName of ["noli_thread_get", "noli_thread_finish", "noli_attach_file"]) {
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
	test("attachments require an authenticated main caller and a durable acknowledgement", () => {
		const h = harness();
		const event = { ...h.event, toolName: "noli_attach_file", input: { path: "report.html", caption: "Report" } };
		for (const input of [{ path: "" }, { path: 42 }, { path: "report.pdf", threadId: "foreign" }, { path: "report.pdf", caption: 42 }]) {
			expect(h.call({ ...event, input }, h.ctx())?.block).toBe(true);
		}
		expect(h.call(event, h.ctx())).toBeUndefined();
		expect(h.result({ ...h.reply, ...event, type: "tool_result", details: { status: "attached", attachmentId: "owned" } }, h.ctx())).toBeUndefined();
		h.call(event, h.ctx());
		expect(h.result({ ...h.reply, ...event, type: "tool_result", details: { status: "submitted" } }, h.ctx())?.isError).toBe(true);
		h.setAuth(false); expect(h.call(event, h.ctx())?.block).toBe(true);
		h.setAuth(true); h.setSource("extension"); expect(h.call(event, h.ctx())?.block).toBe(true);
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
	test("mixed-version SDK registrations only recommend tools that can be called", () => {
		const h = harness(); const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "done", systemPrompt: ["base"] };
		h.setTools(["noli_thread_get", "noli_thread_finish"]);
		expect(h.prompt(event, h.ctx())?.systemPrompt?.join()).not.toContain("noli_attach_file");
		h.setTools(["noli_attach_file"]);
		const onlyAttachment = h.prompt(event, h.ctx())!.systemPrompt!;
		expect(onlyAttachment.join()).toContain("noli_attach_file");
		expect(onlyAttachment.join()).not.toContain("settle/archive");
		h.setTools([]);
		expect(h.prompt({ ...event, systemPrompt: onlyAttachment }, h.ctx())?.systemPrompt).toEqual(["base"]);
	});
	test("referenced reads require authenticated main ownership and the SDK host tool", () => {
		const h = harness();
		const event = { ...h.event, toolName: "noli_thread_read", input: { reference_id: "reference", limit: 20 } };
		expect(h.call(event, h.ctx())).toBeUndefined();
		for (const kind of ["sub", "advisor", "unknown"]) expect(h.call(event, h.ctx(kind))?.block).toBe(true);
		h.setAuth(false); expect(h.call(event, h.ctx())?.block).toBe(true);
		h.setAuth(true); h.setSession("foreign"); expect(h.call(event, h.ctx())?.block).toBe(true);
		h.setSession("owning-session");
		for (const source of [undefined, "extension"]) {
			h.setReadSource(source); expect(h.call(event, h.ctx())?.block).toBe(true);
		}
	});
	test("only reference IDs and bounded pagination are accepted; no legacy alias or authority fields", () => {
		const h = harness();
		const event = { ...h.event, toolName: "noli_thread_read" };
		for (const input of [{ reference_id: "reference" }, { reference_id: "r".repeat(512), before: "c".repeat(4096), limit: 1 }, { reference_id: "reference", limit: 50 }]) {
			expect(h.call({ ...event, input }, h.ctx())).toBeUndefined();
		}
		for (const input of [{}, { thread_id: "target" }, { reference_id: "reference", thread_id: "target" }, { reference_id: "" }, { reference_id: "r".repeat(513) }, { reference_id: 7 }, { reference_id: "reference", before: 7 }, { reference_id: "reference", before: "c".repeat(4097) }, ...[0, 51, 1.5, "20", null, NaN, Infinity].map(limit => ({ reference_id: "reference", limit })), ...["action", "caller", "server_id", "machine_id", "endpoint", "token", "grant"].map(key => ({ reference_id: "reference", [key]: "forbidden" }))]) {
			expect(h.call({ ...event, input }, h.ctx())?.block).toBe(true);
		}
	});
	test("read results cannot outlive authentication or ownership, or replay after lifecycle adoption", () => {
		for (const invalidate of ["disconnect", "switch", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
			const h = harness();
			const event = { ...h.event, toolName: "noli_thread_read", input: { reference_id: "reference" } };
			const reply = { ...h.reply, toolName: event.toolName, input: event.input, details: { items: [] } };
			expect(h.call(event, h.ctx())).toBeUndefined();
			expect(h.result(reply, h.ctx())).toBeUndefined();
			expect(h.result(reply, h.ctx())?.isError).toBe(true);
			h.call(event, h.ctx());
			if (invalidate === "disconnect") h.setAuth(false);
			else if (invalidate === "switch") h.setSession("foreign");
			else h.lifecycle.get(invalidate)!();
			expect(h.result(reply, h.ctx())?.isError).toBe(true);
		}
	});
	test("read denial and cancellation remain backend errors and consume their acknowledgement", () => {
		for (const text of ["permission denied", "Host tool was aborted", "reference revoked", "source unavailable"]) {
			const h = harness();
			const event = { ...h.event, toolName: "noli_thread_read", input: { reference_id: "reference" } };
			const reply = { ...h.reply, toolName: event.toolName, input: event.input, details: undefined, isError: true, content: [{ type: "text" as const, text }] };
			h.call(event, h.ctx());
			expect(h.result(reply, h.ctx())).toBeUndefined();
			expect(h.result({ ...reply, isError: false }, h.ctx())?.isError).toBe(true);
		}
	});
});

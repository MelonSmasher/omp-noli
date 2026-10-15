import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@oh-my-pi/pi-coding-agent";
import { installThreadControl } from "../src/thread-control";

/** Capture guard hooks with independently mutable authentication, session and SDK tool state. */
function harness() {
	let call!: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined;
	let prompt!: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined;
	let authed = true;
	let generation = 1;
	let session = "owning-session";
	let authenticatedSession = session;
	let source = "sdk";
	let tools = ["noli_thread_get", "noli_thread_finish", "noli_attach_file", "noli_thread_read", "noli_thread_open", "noli_forge_resource"];
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
	installThreadControl(pi, id => authed && id === authenticatedSession ? generation : undefined);
	const ctx = (kind = "main") => ({ agent: { kind }, sessionManager: { getSessionId: () => session } }) as unknown as ExtensionContext;
	const event: ToolCallEvent = { type: "tool_call", toolName: "noli_thread_finish", toolCallId: "call", input: { action: "archive" } };
	const reply: ToolResultEvent = { ...event, type: "tool_result", content: [{ type: "text", text: "scheduled" }], details: { status: "scheduled", requestId: "request", action: "archive" }, isError: false };
	// Sequential cases use the SDK's returned execution input. Races below retain
	// each invocation's revision explicitly through the raw hooks instead.
	const revisions = new WeakMap<object, Record<string, unknown>>();
	const admit = (event: ToolCallEvent, context: ExtensionContext) => {
		const admitted = call(event, context);
		if (admitted?.block) return admitted;
		expect(admitted).toEqual({ input: { ...event.input } });
		expect(admitted!.input).not.toBe(event.input);
		revisions.set(event.input, admitted!.input!);
		return undefined;
	};
	const complete = (event: ToolResultEvent, context: ExtensionContext) => result({ ...event, input: revisions.get(event.input) ?? event.input }, context);
	return { call: admit, result: complete, rawCall: call, rawResult: result, prompt, ctx, event, reply, lifecycle, reauthenticate: () => { authed = true; authenticatedSession = session; generation++; }, setTools: (value: string[]) => { tools = value; }, setAuth: (value: boolean) => { authed = value; }, setSession: (value: string) => { session = value; }, setSource: (value: string) => { source = value; }, setReadSource: (value: string | undefined) => { readSource = value; } };
}

describe("current-thread host tool guard", () => {
	test("thread opening rejects unauthorized callers and malformed evidence while preserving backend outcome", () => {
		const h = harness();
		const event = { ...h.event, toolName: "noli_thread_open", input: { title: "Investigate", problem: "Find the cause", mode: "propose" } };
		for (const kind of ["sub", "advisor", "unknown"]) expect(h.call(event, h.ctx(kind))?.block).toBe(true);
		h.setAuth(false); expect(h.call(event, h.ctx())?.block).toBe(true);
		h.setAuth(true); h.setSource("extension"); expect(h.call(event, h.ctx())?.block).toBe(true);
		h.setSource("sdk");
		for (const input of [
			{ ...event.input, mode: "force" }, { ...event.input, thread_id: "foreign" },
			{ ...event.input, authorization: { turn_id: "u", quote: "open", caller: "main" } },
			{ ...event.input, authorization: { turn_id: 3, quote: "open" } },
		]) expect(h.call({ ...event, input }, h.ctx())?.block).toBe(true);
		expect(h.call(event, h.ctx())).toBeUndefined();
		expect(h.result({ ...h.reply, ...event, type: "tool_result", details: { status: "pending_proposal", requestId: "p" } }, h.ctx())).toBeUndefined();
		h.call(event, h.ctx()); h.lifecycle.get("session_switch")!();
		expect(h.result({ ...h.reply, ...event, type: "tool_result" }, h.ctx())?.isError).toBe(true);
	});
	test("opening acknowledgements distinguish persisted outcomes from unknown success", () => {
		const h = harness();
		const event = { ...h.event, toolName: "noli_thread_open", input: { title: "Investigate", problem: "Find the cause", mode: "request" } };
		for (const details of [undefined, {}, { status: "created", requestId: "p" }, { status: "pending_proposal", requestId: "" }, { status: "created", requestId: "p", threadId: "child", initialPromptStatus: "started" }]) {
			h.call(event, h.ctx());
			const rejected = h.result({ ...h.reply, ...event, type: "tool_result", details }, h.ctx());
			expect(rejected?.isError).toBe(true);
			const block = rejected?.content?.[0];
			expect(block?.type === "text" ? block.text : "").toContain("Do not retry automatically");
		}
		h.call(event, h.ctx());
		expect(h.result({ ...h.reply, ...event, type: "tool_result", details: { status: "created", requestId: "p", threadId: "child", initialPromptStatus: "queued" } }, h.ctx())).toBeUndefined();
	});
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
		for (const input of [{ reference_id: "reference" }, { reference_id: "r".repeat(256), before: "c".repeat(4096), limit: 1 }, { reference_id: "reference", limit: 50 }]) {
			expect(h.call({ ...event, input }, h.ctx())).toBeUndefined();
		}
		for (const input of [{}, { thread_id: "target" }, { reference_id: "reference", thread_id: "target" }, { reference_id: "" }, { reference_id: "r".repeat(257) }, { reference_id: 7 }, { reference_id: "reference", before: 7 }, { reference_id: "reference", before: "c".repeat(4097) }, ...[0, 51, 1.5, "20", null, NaN, Infinity].map(limit => ({ reference_id: "reference", limit })), ...["action", "caller", "server_id", "machine_id", "endpoint", "token", "grant"].map(key => ({ reference_id: "reference", [key]: "forbidden" }))]) {
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

describe("read-only native forge resource guard", () => {
	const handle = { origin: "https://github.com", account: "selected-account", repository: { provider: "github", repository_id: "9007199254740993", node_id: "R_native" }, kind: "review", resource: { type: "github", id: "9007199254740995", node_id: null, number: "42" }, web_url: "https://github.com/owner/repo/pull/42" };
	const resolve = { type: "tool_call" as const, toolName: "noli_forge_resource", toolCallId: "forge", input: { action: "resolve_review", number: "42" } };
	const read = { ...resolve, input: { action: "read", handle, offline: false } };
	const reply = { ...resolve, type: "tool_result" as const, content: [{ type: "text" as const, text: "bounded provider content" }], details: { trust: "untrusted_provider_content", result: { snapshot: { handle }, link: "forge:handle" } }, isError: false };
	test("authenticated owning main needs the exact SDK tool, not a legacy capability or tool", () => {
		const h = harness();
		expect(h.call(resolve, h.ctx())).toBeUndefined();
		expect(h.call(read, h.ctx())).toBeUndefined();
		for (const kind of ["sub", "advisor", "unknown"]) expect(h.call(read, h.ctx(kind))?.block).toBe(true);
		h.setAuth(false); expect(h.call(read, h.ctx())?.block).toBe(true);
		h.setAuth(true); h.setSession("foreign"); expect(h.call(read, h.ctx())?.block).toBe(true);
		h.setSession("owning-session"); h.setSource("extension"); expect(h.call(read, h.ctx())?.block).toBe(true);
		h.setSource("sdk"); h.setTools(["noli_thread_get", "noli_thread_read"]); expect(h.call(read, h.ctx())?.block).toBe(true);
	});
	test("decimal strings are lossless and invalid numbers or authority fields cannot be smuggled", () => {
		const h = harness();
		for (const number of ["1", "9007199254740993", "9".repeat(40)]) expect(h.call({ ...resolve, input: { action: "resolve_review", number } }, h.ctx())).toBeUndefined();
		for (const number of [0, 42, null, "", "0", "01", "-1", "1.5", "1e3", " 42", "４２", "9".repeat(41)]) expect(h.call({ ...resolve, input: { action: "resolve_review", number } }, h.ctx())?.block).toBe(true);
		for (const key of ["thread_id", "threadId", "caller", "session", "sessionId", "credential", "token", "authorization", "endpoint", "url", "raw_url", "account", "repository"]) {
			expect(h.call({ ...resolve, input: { ...resolve.input, [key]: "forged" } }, h.ctx())?.block).toBe(true);
			expect(h.call({ ...read, input: { ...read.input, [key]: "forged" } }, h.ctx())?.block).toBe(true);
		}
	});
	test("native handle variants preserve nullable IDs, all kinds and explicit offline requests", () => {
		const h = harness();
		for (const kind of ["repository", "issue", "comment", "review", "review_thread", "pipeline", "job", "release", "tag", "milestone", "label", "project_item"]) {
			expect(h.call({ ...read, input: { ...read.input, handle: { ...handle, kind } } }, h.ctx())).toBeUndefined();
		}
		for (const resource of [{ type: "github", id: "1" }, { type: "github", id: "1", node_id: "PR_native", number: null }, { type: "gitlab", id: "2", number: null }, { type: "github_node", node_id: "PRRT_native" }, { type: "gitlab_discussion", discussion_id: "native-discussion" }, { type: "gitlab_release", tag_name: "v1.0" }, { type: "gitlab_board_item", board_id: "3", issue_id: "9007199254740993" }, { type: "github_tag", name: "v1.0" }, { type: "gitlab_tag", name: "v1.0" }]) {
			expect(h.call({ ...read, input: { action: "read", offline: true, handle: { ...handle, repository: { provider: "gitlab", project_id: "9007199254740993" }, resource } } }, h.ctx())).toBeUndefined();
		}
		// Provider/kind/account/URL agreement is deliberately reauthorized by Noli, never invented here.
	});
	test("unknown nested identity and credential fields and malformed shapes fail closed", () => {
		const h = harness();
		for (const input of [{}, { action: "write", handle }, { action: "read", handle }, { ...read.input, offline: "true" }, { ...read.input, handle: null }, { ...read.input, handle: [] }]) expect(h.call({ ...read, input }, h.ctx())?.block).toBe(true);
		for (const key of ["caller", "thread_id", "token", "credential", "endpoint", "authorization_generation", "binding_generation"]) {
			for (const forged of [{ ...handle, [key]: "forged" }, { ...handle, repository: { ...handle.repository, [key]: "forged" } }, { ...handle, resource: { ...handle.resource, [key]: "forged" } }]) {
				expect(h.call({ ...read, input: { ...read.input, handle: forged } }, h.ctx())?.block).toBe(true);
			}
		}
		for (const forged of [{ ...handle, kind: "unknown" }, { ...handle, origin: 42 }, { ...handle, account: null }, { ...handle, web_url: 42 }, { ...handle, repository: { provider: "github", repository_id: 42, node_id: "R" } }, { ...handle, repository: { provider: "gitlab", project_id: "01" } }, { ...handle, resource: { type: "github", id: 9007199254740992 } }, { ...handle, resource: { type: "github", id: "1", number: 42 } }, { ...handle, resource: { type: "github_node", node_id: "x\n" } }, { ...handle, resource: { type: "github_tag", name: "é".repeat(1025) } }, { ...handle, resource: { type: "unknown", id: "1" } }]) {
			expect(h.call({ ...read, input: { ...read.input, handle: forged } }, h.ctx())?.block).toBe(true);
		}
	});
	test("bounded native content and backend denials/cancellation pass through without synthetic success", () => {
		const h = harness();
		h.call(resolve, h.ctx()); expect(h.result(reply, h.ctx())).toBeUndefined();
		for (const text of ["permission denied", "unsupported resource kind", "offline snapshot missing", "Host tool was aborted"]) {
			h.call(resolve, h.ctx());
			expect(h.result({ ...reply, isError: true, details: undefined, content: [{ type: "text", text }] }, h.ctx())).toBeUndefined();
			expect(h.result(reply, h.ctx())?.isError).toBe(true);
		}
	});
	test("results cannot replay, switch tools/role or outlive session, SDK provenance or authentication generation", () => {
		for (const invalidate of ["replay", "disconnect", "reauthenticate", "foreign", "source", "child", "advisor", "wrong-tool", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
			const h = harness(); h.call(resolve, h.ctx());
			if (invalidate === "replay") expect(h.result(reply, h.ctx())).toBeUndefined();
			else if (invalidate === "disconnect") h.setAuth(false);
			else if (invalidate === "reauthenticate") { h.setAuth(false); h.reauthenticate(); }
			else if (invalidate === "foreign") h.setSession("foreign");
			else if (invalidate === "source") h.setSource("extension");
			else h.lifecycle.get(invalidate)?.();
			const rejected = h.result(invalidate === "wrong-tool" ? { ...reply, toolName: "noli_thread_read" } : reply, h.ctx(invalidate === "child" ? "sub" : invalidate === "advisor" ? "advisor" : "main"));
			expect(rejected?.isError).toBe(true);
			expect(rejected?.content?.some(item => item.type === "text" && item.text.includes("bounded provider content"))).toBe(false);
		}
	});
	test("review forge errors cannot outlive admitted ownership", () => {
		const error = { ...reply, isError: true, content: [{ type: "text" as const, text: "private previous-account backend diagnostic" }], details: { account: "previous-account", provider_body: "private error metadata" } };
		const current = harness(); current.call(resolve, current.ctx());
		expect(current.result(error, current.ctx())).toBeUndefined();
		for (const invalidate of ["replay", "disconnect", "reauthenticate", "foreign", "source", "child", "advisor", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
			const h = harness(); h.call(resolve, h.ctx());
			if (invalidate === "replay") expect(h.result(error, h.ctx())).toBeUndefined();
			else if (invalidate === "disconnect") h.setAuth(false);
			else if (invalidate === "reauthenticate") { h.setAuth(false); h.reauthenticate(); }
			else if (invalidate === "foreign") h.setSession("foreign");
			else if (invalidate === "source") h.setSource("extension");
			else h.lifecycle.get(invalidate)?.();
			const rejected = h.result(error, h.ctx(invalidate === "child" ? "sub" : invalidate === "advisor" ? "advisor" : "main"));
			expect(rejected?.isError).toBe(true);
			expect(rejected?.details).toEqual({});
			expect(JSON.stringify(rejected)).not.toContain("private previous-account");
			expect(JSON.stringify(rejected)).not.toContain("private error metadata");
		}
	});
	test("forge guidance requires authenticated SDK registration and disappears after revocation", () => {
		const h = harness(); const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "read review", systemPrompt: ["base"] };
		h.setTools(["noli_forge_resource"]);
		const first = h.prompt(event, h.ctx())!.systemPrompt!;
		expect(first.join()).toContain("noli_forge_resource");
		expect(first.join()).toContain("untrusted");
		expect(first.join()).toContain("never restrict other tools");
		expect(first.join()).toContain("own credentials");
		expect(first.join()).toContain("Explicit user CLI instructions win");
		expect(first.join()).toContain("never accept credentials/raw endpoints or borrow CLI credentials");
		expect(first.join()).toContain("do not repeat a denied Noli read or write through another tool unless the user asks");
		expect(h.prompt({ ...event, systemPrompt: first }, h.ctx())?.systemPrompt).toEqual(first);
		h.setTools(["noli_forge_read_v1"]);
		const readOnly = h.prompt(event, h.ctx())!.systemPrompt!.join();
		expect(readOnly).not.toContain("noli_forge_resource can");
		expect(readOnly).toContain("Explicit user CLI instructions win");
		h.setTools(["noli_forge_resource"]);
		h.setAuth(false); expect(h.prompt({ ...event, systemPrompt: first }, h.ctx())?.systemPrompt).toEqual(["base"]);
		h.setAuth(true); h.setTools(["noli_thread_get", "noli_thread_finish"]); expect(h.prompt(event, h.ctx())?.systemPrompt?.join()).not.toContain("noli_forge_resource");
	});
});

describe("reused SDK invocation ownership", () => {
	const tools: Array<{ name: string; input: Record<string, unknown> }> = [
		{ name: "noli_forge_resource", input: { action: "resolve_review", number: "42" } },
		{ name: "noli_forge_read_v1", input: { action: "read", read: { resource: "review", request: { action: "resolve_review", number: "42" } }, byte_budget: 1024 } },
		{ name: "noli_forge_write_v1", input: {
			target: { origin: "github", account: "selected", repository: { provider: "github", repository_id: "123", node_id: "R_123" }, kind: "issue", resource: { type: "github", id: "456", node_id: "I_456", number: "7" }, web_url: "https://github.com/owner/repository/issues/7" },
			payload: { kind: "issue", mutation: { action: "comment", body: "Please review." } },
			precondition: { kind: "updated_at", value: "2026-10-12T00:00:00Z" },
		} },
		{ name: "noli_forge_write_status_v1", input: { operation_id: "op" } },
	];
	for (const oldTool of tools) for (const newTool of tools) for (const order of ["old-first", "new-first"]) {
		test(`${oldTool.name} -> ${newTool.name}, ${order}: stale success/errors cannot borrow or consume the new admission`, () => {
			for (const invalidate of ["none", "generation", "session", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
				for (const oldError of [false, true]) for (const newError of [false, true]) {
					const h = harness(); h.setTools(tools.map(tool => tool.name));
					const oldCall: ToolCallEvent = { type: "tool_call", toolCallId: "reused", toolName: oldTool.name, input: oldTool.input };
					const oldAdmission = h.rawCall(oldCall, h.ctx());
					expect(oldAdmission).toEqual({ input: oldCall.input });
					if (invalidate === "generation") h.reauthenticate();
					else if (invalidate === "session") { h.setSession("adopted-session"); h.reauthenticate(); }
					else h.lifecycle.get(invalidate)?.();
					// Same-tool cases deliberately reuse the SAME caller input object.
					const newCall: ToolCallEvent = { ...oldCall, toolName: newTool.name, input: newTool.input };
					const newAdmission = h.rawCall(newCall, h.ctx());
					expect(newAdmission).toEqual({ input: newCall.input });
					expect(newAdmission!.input).not.toBe(oldAdmission!.input);
					expect(newAdmission!.input).not.toBe(newCall.input);
					const oldReply: ToolResultEvent = { ...oldCall, type: "tool_result", input: oldAdmission!.input!, isError: oldError,
						content: [{ type: "text", text: "private-old-provider-content" }], details: { private: "private-old-provider-metadata" } };
					const newReply: ToolResultEvent = { ...newCall, type: "tool_result", input: newAdmission!.input!, isError: newError,
						content: [{ type: "text", text: "current-provider-content" }], details: { status: "pending_approval", operation_id: "current-operation" } };
					const rejectOld = () => {
						const rejected = h.rawResult(oldReply, h.ctx());
						expect(rejected?.isError).toBe(true);
						expect(rejected?.details).toEqual({});
						expect(JSON.stringify(rejected)).not.toContain("private-old-provider");
					};
					if (order === "old-first") rejectOld();
					expect(h.rawResult(newReply, h.ctx())).toBeUndefined();
					if (order === "new-first") rejectOld();
					expect(h.rawResult(newReply, h.ctx())?.isError).toBe(true);
				}
			}
		});
	}
	test("equal input, wrong tool and wrong ID results do not consume the current invocation", () => {
		const h = harness(); h.setTools(tools.map(tool => tool.name));
		const call: ToolCallEvent = { type: "tool_call", toolCallId: "owned", toolName: tools[0]!.name, input: tools[0]!.input };
		const admitted = h.rawCall(call, h.ctx())!;
		const reply: ToolResultEvent = { ...call, type: "tool_result", input: admitted.input!, content: [{ type: "text", text: "private-current-content" }], details: { private: "private-current-details" }, isError: false };
		for (const unmatched of [{ ...reply, input: { ...reply.input } }, { ...reply, input: call.input }, { ...reply, toolName: tools[1]!.name }, { ...reply, toolCallId: "other" }]) {
			for (const isError of [false, true]) {
				const rejected = h.rawResult({ ...unmatched, isError }, h.ctx());
				expect(rejected?.isError).toBe(true);
				expect(rejected?.details).toEqual({});
				expect(JSON.stringify(rejected)).not.toContain("private-current");
			}
		}
		expect(h.rawResult(reply, h.ctx())).toBeUndefined();
	});
	test("blocked reuse leaves the admitted invocation intact", () => {
		const h = harness();
		const admitted = h.rawCall(h.event, h.ctx())!;
		expect(h.rawCall({ ...h.event, input: { action: "archive", caller: "forged" } }, h.ctx())?.block).toBe(true);
		expect(h.rawCall(h.event, h.ctx("sub"))?.block).toBe(true);
		expect(h.rawResult({ ...h.reply, input: admitted.input! }, h.ctx())).toBeUndefined();
	});
});

import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { forgeReadArguments, FORGE_READ_TOOL } from "../src/forge-read-tools";
import { installThreadControl } from "../src/thread-control";
import { forgeResourceHandle } from "../src/forge-resource-handle";

const input = { action: "read", read: { resource: "review", request: { action: "resolve_review", number: "1" } }, byte_budget: 1024 };
function fixture() {
	let call!: (event: ToolCallEvent, context: ExtensionContext) => ToolCallEventResult | undefined;
	let result!: (event: ToolResultEvent, context: ExtensionContext) => ToolResultEventResult | undefined;
	let generation: number | undefined = 1;
	let session = "native-session";
	let source = "sdk";
	const lifecycle = new Map<string, () => void>();
	installThreadControl({ on(name: string, handler: unknown) {
		if (name === "tool_call") call = handler as typeof call;
		if (name === "tool_result") result = handler as typeof result;
		if (name.startsWith("session_")) lifecycle.set(name, handler as () => void);
	}, getAllTools: () => [{name: FORGE_READ_TOOL, sourceInfo: {source}}] } as unknown as ExtensionAPI,
		id => id === "native-session" ? generation : undefined);
	const ctx = (kind = "main") => ({agent:{kind},sessionManager:{getSessionId:()=>session}}) as unknown as ExtensionContext;
	const request: ToolCallEvent = {type:"tool_call",toolName:FORGE_READ_TOOL,toolCallId:"callback",input};
	const reply = (isError = false): ToolResultEvent => ({...request,type:"tool_result",content:[{type:"text",text:"private-provider-canary"}],details:{content:"private-provider-canary"},isError});
	const invoke = (event: ToolCallEvent, context: ExtensionContext) => {
		const decision = call(event, context);
		if (decision?.input) event.input = decision.input;
		return decision;
	};
	return {call:invoke,result,ctx,request,reply,lifecycle,setSession:(value:string)=>{session=value;},setGeneration:(value:number|undefined)=>{generation=value;},setSource:(value:string)=>{source=value;}};
}

function expectCurrentRead(request: Record<string, unknown>) {
	for (const isError of [false, true]) {
		const current = fixture();
		const event = { ...current.request, input: request };
		const decision = current.call(event, current.ctx());
		expect(decision?.block).not.toBe(true);
		expect(decision?.input).toBe(event.input);
		const original = { ...current.reply(isError), input: event.input };
		const delivered = { ...original, ...current.result(original, current.ctx()) };
		expect(delivered.isError).toBe(isError);
		expect(delivered.content).toEqual([{ type: "text", text: "private-provider-canary" }]);
		expect(delivered.details).toEqual({ content: "private-provider-canary" });
	}
}

test("versioned read guard bounds requests and never admits identity or arbitrary endpoints", () => {
	expect(forgeReadArguments(input)).toBe(true);
	expect(forgeReadArguments({action:"continue",cursor:"11111111-1111-4111-8111-111111111111"})).toBe(true);
	for (const value of [ {...input,session_id:"forged"}, {...input,thread_id:"other"}, {...input,grant:true}, {...input,byte_budget:65537}, {...input,byte_budget:0},
		{...input,read:{resource:"proxy",request:{url:"https://other/private"}}}, {action:"continue",cursor:"../other"} ]) expect(forgeReadArguments(value)).toBe(false);
});

test("only current authenticated SDK main calls reach the native callback", () => {
	const h = fixture();
	for (const kind of ["sub","advisor","unknown"]) expect(h.call(h.request,h.ctx(kind))?.block).toBe(true);
	h.setGeneration(undefined); expect(h.call(h.request,h.ctx())?.block).toBe(true);
	h.setGeneration(1); h.setSource("extension"); expect(h.call(h.request,h.ctx())?.block).toBe(true);
	h.setSource("sdk"); h.call(h.request,h.ctx());
	expect(h.result(h.reply(),h.ctx())).toBeUndefined();
	expect(h.result(h.reply(),h.ctx())?.isError).toBe(true);
});

test("success and provider errors lose private text after session, auth epoch or lifecycle changes", () => {
	expectCurrentRead(input);
	for (const isError of [false,true]) for (const change of ["session","epoch","disconnect","branch","source"]) {
		const h = fixture(); h.call(h.request,h.ctx());
		if (change === "session") h.setSession("replacement");
		if (change === "epoch") h.setGeneration(2);
		if (change === "disconnect") h.setGeneration(undefined);
		if (change === "branch") h.lifecycle.get("session_branch")!();
		if (change === "source") h.setSource("extension");
		const rejected = h.result(h.reply(isError),h.ctx());
		expect(rejected?.isError).toBe(true);
		expect(JSON.stringify(rejected)).not.toContain("private-provider-canary");
		expect(rejected?.details).toEqual({});
	}
});

test("the shared structural checker preserves native handle shape, never grants permission", () => {
	const handle = {origin:"https://forge.example:8443",account:"selected",repository:{provider:"gitlab",project_id:"42"},kind:"issue",resource:{type:"gitlab",id:"1",number:"1"},web_url:"https://forge.example:8443/group/repo/-/issues/1"};
	expect(forgeResourceHandle(handle)).toBe(true);
	for (const malformed of [{...handle,caller:"main"},{...handle,repository:{provider:"gitlab",project_id:"0"}},{...handle,resource:{type:"raw",url:"https://other"}}]) expect(forgeResourceHandle(malformed)).toBe(false);
});

test("snapshot reads accept persisted IDs, never a model-supplied target or authority", () => {
	const request = {action:"read",read:{resource:"task_snapshot",request:{attempt_id:"attempt-local",sequence:7}},byte_budget:1024};
	expectCurrentRead(request);
	expect(forgeReadArguments(request)).toBe(true);
	for (const key of ["thread_id","owner","account","repository","origin","session_id","grant","url"]) {
		expect(forgeReadArguments({...request,read:{...request.read,request:{...request.read.request,[key]:"forged"}}})).toBe(false);
	}
	for (const sequence of [-1,1.5,Number.MAX_SAFE_INTEGER+1,"7"]) {
		expect(forgeReadArguments({...request,read:{...request.read,request:{attempt_id:"attempt-local",sequence}}})).toBe(false);
	}
	const h=fixture();
	const event={...h.request,input:request};
	expect(h.call(event,h.ctx("sub"))?.block).toBe(true);
	expect(h.call(event,h.ctx())?.block).not.toBe(true);
	h.setSession("replacement");
	expect(h.result({...h.reply(),input:event.input},h.ctx())?.isError).toBe(true);
});

test("watch lookup takes only the persisted watch ID and retains main-session admission", () => {
	const request = {action:"read",read:{resource:"watch",request:{watch_id:"watch-local"}}};
	expectCurrentRead(request);
	expect(forgeReadArguments(request)).toBe(true);
	for (const key of ["thread_id","attempt_id","owner","account","repository","session_id","grant"]) {
		expect(forgeReadArguments({...request,read:{...request.read,request:{...request.read.request,[key]:"forged"}}})).toBe(false);
	}
	for (const watch_id of ["","x".repeat(257),"watch\nother",7]) {
		expect(forgeReadArguments({...request,read:{...request.read,request:{watch_id}}})).toBe(false);
	}
	const h=fixture();
	const event={...h.request,input:request};
	expect(h.call(event,h.ctx("advisor"))?.block).toBe(true);
	expect(h.call(event,h.ctx())?.block).not.toBe(true);
	h.setGeneration(2);
	expect(h.result({...h.reply(),input:event.input},h.ctx())?.isError).toBe(true);
});

test("native release file metadata requires an empty scoped request, never paths or owner claims", () => {
	const request={action:"read",read:{resource:"release_files",request:{}}};
	expectCurrentRead(request);
	expect(forgeReadArguments(request)).toBe(true);
	for (const key of ["path","selection_id","rpc_session","native_owner","thread_id","account","grant"]) {
		expect(forgeReadArguments({...request,read:{...request.read,request:{[key]:"forged"}}})).toBe(false);
	}
	const h=fixture();
	const event={...h.request,input:request};
	expect(h.call(event,h.ctx("sub"))?.block).toBe(true);
	expect(h.call(event,h.ctx())?.block).not.toBe(true);
	h.setSession("replacement");
	expect(h.result({...h.reply(),input:event.input},h.ctx())?.isError).toBe(true);
});

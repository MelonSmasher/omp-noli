// Invoked only by the isolated Rust Runtime smoke. This is not an RPC substitute.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chmod, rename } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";

const root = process.env.NOLI_READ_CONTROL;
const sdkRoot = process.env.NOLI_READ_SDK;
const producer = process.env.NOLI_READ_PRODUCER;
assert(root && sdkRoot && producer, "Explicit immutable SDK and producer inputs required");
// The immutable SDK installation is selected at runtime; importing the workspace SDK would test a different producer.
const sdkModule = (file: string) => pathToFileURL(join(sdkRoot, "src", file)).href;
const { setTransports } = await import(pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-utils/logger", sdkRoot)).href);
setTransports({ file: join(root, "sdk-logs"), console: false });
const sdk = await import(sdkModule("index.ts"));
const { runRpcMode } = await import(sdkModule("modes/rpc/rpc-mode.ts"));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.OMP_CODING_AGENT_DIR;
assert(agentDir, "Runtime must supply the isolated native agent directory");
const settings = sdk.Settings.isolated({"memory.backend":"off","advisor.enabled":false,"autolearn.enabled":false,"providers.cacheWarming":"off"});
const {session, subagentEventBus, extensionsResult} = await sdk.createAgentSession({cwd:process.cwd(),agentDir,
	sessionManager:sdk.SessionManager.create(process.cwd(),join(agentDir,"sessions")),settings,toolNames:[],
	enableMCP:false,enableLsp:false,enableIrc:false,disableExtensionDiscovery:true,cacheWarming:false,preloadedExtensionPaths:[producer]});
assert.equal(extensionsResult.errors.length,0,"The real producer must load without extension errors");
const nativeTools: unknown = JSON.parse(process.env.NOLI_FORGE_SMOKE_TOOLS ?? '["noli_forge_read_v1"]');
assert(Array.isArray(nativeTools) && nativeTools.length > 0 && nativeTools.length <= 3
	&& nativeTools.every(name => typeof name === "string" && ["noli_forge_read_v1","noli_forge_write_v1","noli_forge_write_status_v1"].includes(name)),
	"Select only the actual native forge tools required by this scenario");
const requiredTools = nativeTools as string[];
assert(requiredTools.every(name => !session.hasRpcHostTool(name)),"No native tool exists before genuine registration");

async function publish(name: string, value: unknown) {
	const path = join(root!,name);
	await Bun.write(path+".tmp",JSON.stringify(value));
	await chmod(path+".tmp",0o600);
	await rename(path+".tmp",path);
}
type Command = { mode: "read" | "cancel"; request: unknown; tool_name?: string }
	| { mode: "hold"; request: unknown; tool_name?: string; tool_call_id: string; reuse_input_from?: number }
	| { mode: "release"; invocation: number; expect: "stale" | "current" }
	| { mode: "finish" };
async function command(index: number): Promise<Command> {
	const file = Bun.file(join(root!,`command${index}.json`));
	const deadline = Date.now()+120_000;
	while (!await file.exists()) {
		if (Date.now()>deadline) throw new Error("Native read smoke command deadline expired");
		await Bun.sleep(20);
	}
	return Bun.file(join(root!,`command${index}.json`)).json();
}
type Outcome = { ok: true; value: AgentToolResult<unknown> } | { ok: false; error_message: string };
const outcomeOf = (pending: Promise<AgentToolResult<unknown>>): Promise<Outcome> => pending.then(
	value => ({ ok: true, value }), error => ({ ok: false, error_message: error instanceof Error ? error.message : String(error) }),
);
type HeldInvocation = {
	name: string;
	toolCallId: string;
	input: unknown;
	signal: AbortSignal;
	hostInput?: unknown;
	upstream?: Outcome;
	ready: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
	pending?: Promise<Outcome>;
};
const held = new Map<number, HeldInvocation>();
const bySignal = new WeakMap<AbortSignal, HeldInvocation>();
const gated = new WeakSet<AgentTool>();

// Delay only the genuine native adapter's completion, inside the official SDK
// wrapper. Neither hook events nor upstream results are fabricated. The wrapper
// still emits tool_call/tool_result and the native host still handles each RPC.
function gateCompletions(tool: AgentTool): void {
	if (gated.has(tool)) return;
	gated.add(tool);
	const execute = tool.execute.bind(tool);
	tool.execute = async (id, input, signal, onUpdate, context) => {
		const invocation = signal && bySignal.get(signal);
		if (!invocation) return execute(id, input, signal, onUpdate, context);
		assert.equal(id, invocation.toolCallId);
		assert.equal(tool.name, invocation.name);
		invocation.hostInput = input;
		assert.deepEqual(input, invocation.input, "Invocation fencing must not change native arguments");
		try {
			const value = await execute(id, input, signal, onUpdate, context);
			invocation.upstream = { ok: true, value };
			invocation.ready.resolve();
			await invocation.release.promise;
			return value;
		} catch (error) {
			invocation.upstream = { ok: false, error_message: error instanceof Error ? error.message : String(error) };
			invocation.ready.resolve();
			await invocation.release.promise;
			throw error;
		}
	};
}

async function releaseInvocation(index: number, expectation: "stale" | "current"): Promise<Outcome> {
	const invocation = held.get(index);
	assert(invocation?.upstream && invocation.pending, "Release requires a genuinely completed, held native invocation");
	invocation.release.resolve();
	const outcome = await invocation.pending;
	if (expectation === "current") {
		assert.deepEqual(outcome, invocation.upstream, "The newer admission must retain the exact native success or error");
	} else {
		assert(outcome.ok, "Stale results must be rewritten by the actual SDK guard, not fail in the launcher");
		assert.equal(outcome.value.isError, true);
		assert.deepEqual(outcome.value.details, {}, "Stale upstream metadata must not survive");
		const text = invocation.name === "noli_forge_read_v1"
			? "Forge resource result lost its authenticated owning session; discard this stale read and request a fresh authorized read if needed."
			: "Noli control acknowledgement lost its authenticated session; outcome unknown. The operation may already be persisted. Do not retry automatically; inspect the owning conversation before retrying.";
		assert.deepEqual(outcome.value.content, [{ type: "text", text }], "No stale upstream success or error text may escape");
	}
	assert.notEqual(invocation.hostInput, invocation.input, "The real SDK must execute the producer's unique input revision");
	for (const other of held.values()) if (other !== invocation && other.toolCallId === invocation.toolCallId) {
		assert.notEqual(invocation.hostInput, other.hostInput, "Reused IDs must have distinct SDK execution identities even with shared caller input");
	}
	bySignal.delete(invocation.signal);
	held.delete(index);
	return outcome;
}
let consuming = false;
const refresh = session.refreshRpcHostTools.bind(session);
session.refreshRpcHostTools = async (tools: AgentTool[]) => {
	for (const tool of tools) gateCompletions(tool);
	await refresh(tools);
	if (consuming || !requiredTools.every(name => session.hasRpcHostTool(name))) return;
	consuming = true;
	await publish("registered.json",{sdk_version:sdk.VERSION,sdk_path:sdkRoot,producer_path:producer,pid:process.pid,
		session_id:session.sessionId,main_registered:sdk.AgentRegistry.global().get(sdk.MAIN_AGENT_ID)?.session===session,
		tool_names:tools.map(tool=>tool.name)});
	void consume().catch(async error=>publish("driver-error.json",{name:error instanceof Error?error.name:"Error",message:"Official SDK native read driver failed"}));
};
async function consume() {
	for (let index=1;;index++) {
		const next = await command(index);
		if (next.mode === "finish") {
			assert.equal(held.size, 0, "Every held invocation must be released and checked");
			return;
		}
		if (next.mode === "release") {
			assert(next.expect === "stale" || next.expect === "current", "Release must name its ownership oracle");
			const outcome = await releaseInvocation(next.invocation, next.expect);
			await publish(`result${index}.json`, { ...outcome, invocation: next.invocation, ownership: next.expect, observed_ms: Date.now(), session_id: session.sessionId, pid: process.pid, sdk_version: sdk.VERSION });
			continue;
		}
		const name = next.tool_name ?? requiredTools[0]!;
		assert(requiredTools.includes(name),"Scenario selected a tool outside its native registration contract");
		const tool = session.getToolByName(name);
		assert(tool && session.hasRpcHostTool(tool.name),"Only the real registered SDK host tool may execute");
		const abort = new AbortController();
		if (next.mode === "cancel") abort.abort();
		if (next.mode === "hold") {
			assert(typeof next.tool_call_id === "string" && next.tool_call_id.length > 0, "Hold requires an explicit reusable toolCallId");
			const previous = next.reuse_input_from === undefined ? undefined : held.get(next.reuse_input_from);
			if (next.reuse_input_from !== undefined) {
				assert(previous && previous.name === name, "Shared input must come from a still-held invocation of the same tool");
				assert.deepEqual(next.request, previous.input, "Shared input must not silently replace the command's requested arguments");
			}
			const invocation: HeldInvocation = { name, toolCallId: next.tool_call_id, input: previous ? previous.input : next.request, signal: abort.signal,
				ready: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			held.set(index, invocation);
			bySignal.set(abort.signal, invocation);
			invocation.pending = outcomeOf(tool.execute(invocation.toolCallId, invocation.input, abort.signal));
			const timeout = setTimeout(() => invocation.ready.reject(new Error("Genuine native completion did not reach its hold point")), 120_000);
			try {
				await Promise.race([invocation.ready.promise, invocation.pending.then(() => { throw new Error("Invocation completed without reaching the genuine native hold point"); })]);
			} catch (error) {
				invocation.release.resolve();
				abort.abort();
				throw error;
			} finally { clearTimeout(timeout); }
			await publish(`result${index}.json`, { ok: true, held: true, invocation: index, tool: name, tool_call_id: invocation.toolCallId,
				host_completed: true, upstream_ok: invocation.upstream!.ok, observed_ms: Date.now(), session_id: session.sessionId, pid: process.pid, sdk_version: sdk.VERSION });
			continue;
		}
		const outcome = await tool.execute(`forge-native-${index}`,next.request,abort.signal)
			.then((value: unknown)=>({ok:true,value}), (error:unknown)=>({ok:false,error_message:error instanceof Error?error.message:String(error)}));
		await publish(`result${index}.json`,{...outcome,observed_ms:Date.now(),tool:tool.name,
			session_id:session.sessionId,pid:process.pid,sdk_version:sdk.VERSION});
	}
}
await runRpcMode(session,{subagentEventBus});

// Invoked only by the isolated Rust Runtime smoke. This is not an RPC substitute.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chmod, rename } from "node:fs/promises";

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
async function command(index: number): Promise<{mode:string; request:unknown; tool_name?:string}> {
	const file = Bun.file(join(root!,`command${index}.json`));
	const deadline = Date.now()+120_000;
	while (!await file.exists()) {
		if (Date.now()>deadline) throw new Error("Native read smoke command deadline expired");
		await Bun.sleep(20);
	}
	return file.json();
}
let consuming = false;
const refresh = session.refreshRpcHostTools.bind(session);
session.refreshRpcHostTools = async (tools: Array<{name:string}>) => {
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
		if (next.mode === "finish") return;
		const name = next.tool_name ?? requiredTools[0]!;
		assert(requiredTools.includes(name),"Scenario selected a tool outside its native registration contract");
		const tool = session.getToolByName(name);
		assert(tool && session.hasRpcHostTool(tool.name),"Only the real registered SDK host tool may execute");
		const abort = new AbortController();
		if (next.mode === "cancel") abort.abort();
		const outcome = await tool.execute(`forge-native-${index}`,next.request,abort.signal)
			.then((value: unknown)=>({ok:true,value}), (error:unknown)=>({ok:false,error_message:error instanceof Error?error.message:String(error)}));
		await publish(`result${index}.json`,{...outcome,observed_ms:Date.now(),tool:tool.name,
			session_id:session.sessionId,pid:process.pid,sdk_version:sdk.VERSION});
	}
}
await runRpcMode(session,{subagentEventBus});

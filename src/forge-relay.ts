import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { FORGE_READ_TOOL, forgeReadArguments } from "./forge-read-tools";
import { FORGE_WRITE_TOOLS, forgeWriteAdmission, forgeWriteArguments, forgeWriteStatusArguments } from "./forge-write-tools";
import { FORGE_STATUS_TOOL, RELAYED_TOOLS, REQUESTER_KEY, forgeContextBlock, requesterOf, requesterPermits, taskReminder } from "./forge-agents";
import { FORGE_CLI_INSTRUCTION, forgeArguments } from "./thread-control";

/** What a subagent needs from its root session's Noli host tools. */
interface HostTool {
	label?: string;
	description: string;
	parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown): Promise<{ content: unknown[]; details?: unknown }>;
}
export interface ForgeRoot {
	/** The launch's bridge directory; only subagents of the same launch use this root. */
	dir: string;
	sessionId: string;
	/** Current socket authentication of the root session; undefined after revocation. */
	generation(sessionId: string): number | undefined;
	/** The root's genuine RPC host tool, never an extension tool. */
	tool(name: string): HostTool | undefined;
}

/** The bound root of this OMP process. Subagent sessions in the same process share it. */
let root: ForgeRoot | undefined;
export function bindForgeRoot(binding: ForgeRoot): void { root = binding; }
/** The parent session ended or changed: every subagent grant ends with it. */
export function releaseForgeRoot(dir: string): void { if (root?.dir === dir) root = undefined; }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function validArguments(name: string, input: Record<string, unknown>, toolCallId: string): boolean {
	if (name === FORGE_STATUS_TOOL) return Object.keys(input).length === 0;
	if (name === FORGE_READ_TOOL) return forgeReadArguments(input);
	if (name === FORGE_WRITE_TOOLS[0]) return forgeWriteArguments(input, toolCallId);
	if (name === FORGE_WRITE_TOOLS[1]) return forgeWriteStatusArguments(input);
	return forgeArguments(input);
}

/**
 * Registers subagent forge tools that call the root session's host tool with this
 * subagent's runtime identity. Noli derives repository and account authority from
 * the root session and verifies the subagent against its native lifecycle.
 */
export function installForgeRelay(pi: ExtensionAPI, dir: string | undefined): void {
	if (!dir || root?.dir !== dir) return;
	const bound = root;
	const tools = RELAYED_TOOLS.flatMap(name => { const tool = bound.tool(name); return tool ? [[name, tool] as const] : []; });
	for (const [name, tool] of tools) {
		pi.registerTool({
			name, label: tool.label ?? name, description: tool.description,
			parameters: tool.parameters as never,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const binding = root;
				if (!binding || binding.dir !== dir) throw new Error("Noli forge tools ended with the parent session.");
				const requester = requesterOf(ctx);
				if (!requester || !requesterPermits(name, requester)) throw new Error(requester?.kind === "advisor" ? "The advisor is read-only." : "Noli forge tools need an identified subagent.");
				const input: unknown = params;
				if (!record(input) || REQUESTER_KEY in input || !validArguments(name, input, toolCallId)) {
					throw new Error("Invalid Noli forge arguments; caller identity, credentials and raw endpoints are not accepted.");
				}
				const session = binding.sessionId;
				const generation = binding.generation(session);
				const host = binding.tool(name);
				if (generation === undefined || !host) throw new Error("Authenticated Noli forge access is unavailable for the parent session.");
				const result = await host.execute(toolCallId, { ...input, [REQUESTER_KEY]: requester }, signal, onUpdate);
				// A result that outlived its parent's authentication is discarded, never adopted.
				if (root !== binding || binding.generation(session) !== generation) {
					throw new Error("This Noli forge result lost its authenticated parent session; discard it. A write's outcome is unknown: do not retry automatically.");
				}
				if (name === FORGE_WRITE_TOOLS[0] && !forgeWriteAdmission(result.details)) {
					throw new Error("Noli did not acknowledge an exact pending approval. No upstream write is confirmed; do not retry automatically.");
				}
				return result as never;
			},
		});
	}
	if (tools.length === 0) return;
	const delivered = new Map<string, string>();
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind === "main" || root?.dir !== dir) return;
		const block = forgeContextBlock(dir);
		const message = taskReminder(delivered, ctx.sessionManager.getSessionId(), dir);
		const guidance = [FORGE_CLI_INSTRUCTION, ...(block ? [block] : [])];
		return { systemPrompt: [...event.systemPrompt.filter(line => !guidance.includes(line)), ...guidance], ...(message ? { message } : {}) };
	});
}

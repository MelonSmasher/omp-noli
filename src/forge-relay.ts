import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { FORGE_READ_TOOL, forgeReadArguments, forgeReadRejection } from "./forge-read-tools";
import { FORGE_WRITE_TOOLS, forgeWriteAdmission, forgeWriteArguments, forgeWriteStatusArguments } from "./forge-write-tools";
import { FORGE_CONTEXT_PREFIX, FORGE_STATUS_TOOL, READ_ONLY_AGENTS, READ_ONLY_AGENT_WRITE, RELAYED_TOOLS, RELAY_PREFIX, REQUESTER_KEY, type Requester, argumentsDigest, forgeContextBlock, relayCalls, requesterOf, requesterPermits, taskReminder, writesOffered } from "./forge-agents";
import { FORGE_CLI_INSTRUCTION, forgeArguments } from "./thread-control";

interface HostToolResult { content: unknown[]; details?: unknown }

/** What a subagent needs from its root session's Noli host tools. */
interface HostTool {
	label?: string;
	description: string;
	parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown): Promise<HostToolResult>;
}
export interface ForgeRoot {
	/** The launch's bridge directory; only subagents of the same launch use this root. */
	dir: string;
	sessionId: string;
	/** Current socket authentication of the root session; undefined after revocation. */
	generation(sessionId: string): number | undefined;
	/** The root's genuine RPC host tool as the SDK registered it (wrapped by the root's extension runner). */
	tool(name: string): HostTool | undefined;
}

/** The bound root of this OMP process. Subagent sessions in the same process share it.
 *  Each adoption binds a new object, so identity distinguishes a same-directory replacement. */
let root: ForgeRoot | undefined;
export function bindForgeRoot(binding: ForgeRoot): void { root = binding; }
/** The parent session ended or changed: every subagent grant ends with it. */
export function releaseForgeRoot(dir: string): void { if (root?.dir === dir) root = undefined; }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function validArguments(name: string, input: Record<string, unknown>, toolCallId: string, requester: Requester): boolean {
	if (name === FORGE_STATUS_TOOL || name === "noli_model_roles") return Object.keys(input).length === 0;
	if (name === FORGE_READ_TOOL) return forgeReadArguments(input, requester);
	if (name === FORGE_WRITE_TOOLS[0]) return forgeWriteArguments(input, toolCallId, requester);
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
	const registered = new Set<string>();
	/** `agent` is the child's definition name, known only from a lifecycle context. */
	const registerMissing = (agent?: string) => {
		if (root !== bound) return false;
		let added = false;
		for (const name of RELAYED_TOOLS) {
			if (registered.has(name)) continue;
			// Proposals wait for the definition: Noli's read-only reviewers are never offered them.
			if ((FORGE_WRITE_TOOLS as readonly string[]).includes(name) && !writesOffered(agent)) continue;
			const tool = bound.tool(name);
			if (!tool) continue;
			pi.registerTool({
				name, label: tool.label ?? name, description: tool.description,
				parameters: tool.parameters as never,
				async execute(_toolCallId, params, signal, onUpdate, ctx) {
					// Pinned to the parent bound when this subagent started: a replacement parent,
					// even in the same launch directory, never inherits this subagent.
					if (root !== bound) throw new Error("Noli forge tools ended with the parent session.");
					const requester = requesterOf(ctx);
					if (!requester || !requesterPermits(name, requester)) throw new Error(requester?.kind === "advisor" ? "The advisor is read-only." : "Noli forge tools need an identified subagent.");
					if ((FORGE_WRITE_TOOLS as readonly string[]).includes(name) && READ_ONLY_AGENTS.includes(ctx.agent.name)) throw new Error(READ_ONLY_AGENT_WRITE);
					const input: unknown = params;
					const relayId = `${RELAY_PREFIX}${crypto.randomUUID()}`;
					if (!record(input) || REQUESTER_KEY in input || !validArguments(name, input, relayId, requester)) {
						throw new Error(name === FORGE_READ_TOOL && record(input) ? forgeReadRejection(input) : "Invalid Noli forge transport shape; check the documented fields and size limits.");
					}
					const generation = bound.generation(bound.sessionId);
					const host = bound.tool(name);
					if (generation === undefined || !host) throw new Error("Authenticated Noli forge access is unavailable for the parent session.");
					// The root guard attributes this call from the out-of-band entry, not from input.
					relayCalls.set(relayId, { toolName: name, sessionId: bound.sessionId, generation, requester, arguments: argumentsDigest(input), claimed: false });
					let result: HostToolResult;
					try { result = await host.execute(relayId, input, signal, onUpdate); }
					finally { relayCalls.delete(relayId); }
					// A result that outlived its parent or its authentication is discarded, never adopted.
					if (root !== bound || bound.generation(bound.sessionId) !== generation) {
						throw new Error("This Noli forge result lost its authenticated parent session; discard it. A write's outcome is unknown: do not retry automatically.");
					}
					if (name === FORGE_WRITE_TOOLS[0] && !forgeWriteAdmission(result.details)) {
						throw new Error("Noli did not acknowledge an exact pending approval. No upstream write is confirmed; do not retry automatically.");
					}
					return result as never;
				},
			});
			registered.add(name);
			added = true;
		}
		return added;
	};
	registerMissing();
	const delivered = new Map<string, string>();
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind === "main") return;
		// Lifecycle registrations join the SDK's tool snapshot before the model starts.
		// Retry only this pinned parent's missing tools, never a replacement's grants.
		const added = registerMissing(ctx.agent.name);
		const available = root === bound && bound.generation(bound.sessionId) !== undefined
			&& RELAYED_TOOLS.some(name => registered.has(name) && bound.tool(name));
		const block = available ? forgeContextBlock(dir) : undefined;
		// Registration rebuilds the SDK's base prompt and discards this preparation's
		// messages. Leave delivery unclaimed so its retry can retain the reminder.
		const message = available && !added ? taskReminder(delivered, ctx.sessionManager.getSessionId(), dir) : undefined;
		const guidance = available ? [FORGE_CLI_INSTRUCTION, ...(block ? [block] : [])] : [];
		const stale = (line: string) => line === FORGE_CLI_INSTRUCTION || line.startsWith(FORGE_CONTEXT_PREFIX);
		if (guidance.length === 0 && !message && !event.systemPrompt.some(stale)) return;
		return { systemPrompt: [...event.systemPrompt.filter(line => !stale(line)), ...guidance], ...(message ? { message } : {}) };
	});
}

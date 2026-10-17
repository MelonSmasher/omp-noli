import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { FORGE_READ_TOOL } from "./forge-read-tools";
import { FORGE_WRITE_TOOLS } from "./forge-write-tools";

/** No arguments: Noli derives the binding from the calling session. */
export const FORGE_STATUS_TOOL = "noli_forge_status";
/** Forge tools a subagent may reach through the main session's host tool. */
export const RELAYED_TOOLS = ["noli_forge_resource", FORGE_READ_TOOL, FORGE_STATUS_TOOL, ...FORGE_WRITE_TOOLS] as const;
/** The advisor's subset: reads and status, never proposals or operation status. */
export const READ_ONLY_TOOLS: readonly string[] = ["noli_forge_resource", FORGE_READ_TOOL, FORGE_STATUS_TOOL];
/** Added by this plugin, never by a model; Noli verifies it against the native subagent lifecycle. */
export const REQUESTER_KEY = "noli_requester";

export type Requester = { kind: "child"; agent_id: string } | { kind: "advisor" };

/**
 * Out-of-band attribution for relayed subagent calls. The relay mints an unguessable
 * call ID, records the requester here and executes the root's genuine (wrapped) host
 * tool with that ID; the root guard reads the requester from here, never from input.
 */
export interface RelayCall { toolName: string; sessionId: string; generation: number; requester: Requester }
export const relayCalls = new Map<string, RelayCall>();

/**
 * The calling agent, from OMP's runtime identity rather than tool input. OMP names
 * an advisor's calls `advisor` in the advising session's runner. Undefined means
 * the main agent; null means an identity that cannot be attributed.
 */
export function requesterOf(ctx: ExtensionContext): Requester | null | undefined {
	if (ctx.agent.kind === "main") return undefined;
	if (ctx.agent.id === "advisor") return { kind: "advisor" };
	const id = ctx.agent.id;
	return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 256 && !/\p{Cc}/u.test(id) ? { kind: "child", agent_id: id } : null;
}

/** Whether this non-main requester may call the tool at all. */
export function requesterPermits(toolName: string, requester: Requester): boolean {
	return requester.kind === "advisor" ? READ_ONLY_TOOLS.includes(toolName) : (RELAYED_TOOLS as readonly string[]).includes(toolName);
}

/** Stable forge binding text for the system prompt, as Noli last wrote it. */
export function forgeContextBlock(dir: string | undefined): string | undefined {
	return field(dir, "forge-context.json", "block");
}

/** Short task-state reminder for the tail of the conversation, never the prefix. */
export function forgeTaskState(dir: string | undefined): string | undefined {
	return field(dir, "forge-task.json", "task");
}

function field(dir: string | undefined, file: string, key: string): string | undefined {
	if (!dir) return undefined;
	let value: unknown;
	// Missing or partial files mean "nothing to add"; Noli replaces them atomically.
	try { value = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return undefined; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const text = (value as Record<string, unknown>)[key];
	return typeof text === "string" && text.length > 0 && text.length <= 16384 ? text : undefined;
}

export const TASK_MESSAGE_TYPE = "noli-forge-task";

/**
 * Delivers task state once per change and session, as a hidden message appended
 * after the conversation. Unchanged state adds nothing, so the prefix and history
 * stay byte-identical.
 */
export function taskReminder(delivered: Map<string, string>, sessionId: string, dir: string | undefined) {
	const task = forgeTaskState(dir);
	if (!task || delivered.get(sessionId) === task) return undefined;
	delivered.set(sessionId, task);
	return { customType: TASK_MESSAGE_TYPE, content: task, display: false };
}

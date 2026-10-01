/**
 * Shape checks for the internal OMP hooks, plus capability constructors.
 *
 * A capability backed only by published `pi.pi` exports is `api: "public"`. One
 * that reaches OMP internals through objects the host already owns (built-in
 * tool instances) is `api: "internal"`: it works on official releases today but
 * is not a supported OMP contract. Probes check shape at startup; internal hooks
 * are re-verified when used.
 */
import type { CapabilityReason, CapabilityState } from "./protocol";

/** Shape of the host lifecycle manager the parked-kill path needs. */
export interface LifecycleHandle {
	release(id: string, expected?: unknown, options?: { tombstone?: boolean }): Promise<boolean>;
}

/** Shape of a built-in tool instance the plugin drives directly. */
export interface ToolHandle {
	execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ToolLookup {
	getToolByName(name: string): unknown;
}

export function isLifecycleHandle(value: unknown): value is LifecycleHandle {
	return !!value && typeof value === "object" && "release" in value && typeof value.release === "function";
}

export function isToolHandle(value: unknown): value is ToolHandle {
	return !!value && typeof value === "object" && "execute" in value && typeof value.execute === "function";
}

export function isToolLookup(value: unknown): value is ToolLookup {
	return !!value && typeof value === "object" && "getToolByName" in value && typeof value.getToolByName === "function";
}

export type Probe<T> = { ok: true; value: T; detail: string } | { ok: false; reason: CapabilityReason; detail: string };

/**
 * Internal hook: the built-in `read` tool resolves `history://<id>` through
 * OMP's history protocol, which first runs the host's persisted-roster scan
 * for the caller's root session.
 */
export function probeRosterReader(session: unknown): Probe<ToolHandle> {
	if (!isToolLookup(session)) return { ok: false, reason: "hook_changed", detail: "main session exposes no getToolByName" };
	const read = session.getToolByName("read");
	if (!read) return { ok: false, reason: "tool_missing", detail: "built-in read tool is not registered in this session (tools disabled?)" };
	if (!isToolHandle(read)) return { ok: false, reason: "hook_changed", detail: "read tool has no execute()" };
	return { ok: true, value: read, detail: "read tool history:// lookup triggers OMP's persisted-roster scan" };
}

/**
 * Internal hook: the built-in `task` tool keeps its ToolSession, whose
 * `agentLifecycle()` returns the host's AgentLifecycleManager.
 */
export function probeLifecycle(session: unknown): Probe<LifecycleHandle> {
	if (!isToolLookup(session)) return { ok: false, reason: "hook_changed", detail: "main session exposes no getToolByName" };
	const task = session.getToolByName("task");
	if (!task || typeof task !== "object") return { ok: false, reason: "tool_missing", detail: "built-in task tool is not registered in this session" };
	if (!("session" in task) || !task.session || typeof task.session !== "object") {
		return { ok: false, reason: "hook_changed", detail: "task tool no longer carries its ToolSession" };
	}
	const toolSession = task.session;
	if (!("agentLifecycle" in toolSession) || typeof toolSession.agentLifecycle !== "function") {
		return { ok: false, reason: "hook_changed", detail: "task ToolSession has no agentLifecycle()" };
	}
	let manager: unknown;
	try {
		manager = toolSession.agentLifecycle();
	} catch (error) {
		return { ok: false, reason: "hook_changed", detail: `agentLifecycle() threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isLifecycleHandle(manager)) return { ok: false, reason: "hook_changed", detail: "agentLifecycle() did not return a manager with release()" };
	return { ok: true, value: manager, detail: "task ToolSession.agentLifecycle().release(..., { tombstone: true })" };
}

export function unavailable(api: CapabilityState["api"], reason: CapabilityReason, detail: string): CapabilityState {
	return { available: false, api, reason, detail };
}

export function available(api: CapabilityState["api"], detail: string): CapabilityState {
	return { available: true, api, detail };
}

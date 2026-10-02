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

/** Session members the settlement view reads; all are public AgentSession API. */
export interface WorkSession {
	isStreaming: boolean;
	hasAdmittedSubmission: boolean;
	queuedMessageCount: number;
	hasPendingAsyncWork(): boolean;
	agent: {
		peekSteeringQueue(): readonly QueuedMessage[];
		peekFollowUpQueue(): readonly QueuedMessage[];
	};
	getAsyncJobSnapshot(): {
		running: Array<{ id: string; type: string; label: string; startTime: number; agentId?: string }>;
		delivery: { queued: number };
	} | null;
}

/** Queue fields used by OMP's isUserAuthoredQueuedMessage predicate. */
interface QueuedMessage {
	role: string;
	attribution?: string;
	display?: boolean;
}

/** Async job manager members `work.cancel` needs. The filter is mandatory: without it OMP's manager cancels any owner's job. */
export interface JobCanceller {
	cancel(id: string, filter: { ownerId: string }): boolean;
	getJob(id: string): unknown;
}

export function probeWork(session: unknown): Probe<WorkSession> {
	if (!session || typeof session !== "object") return { ok: false, reason: "not_ready", detail: "main session not established" };
	const s = session as Record<string, unknown>;
	for (const key of ["isStreaming", "hasAdmittedSubmission"]) {
		if (typeof s[key] !== "boolean") return { ok: false, reason: "hook_changed", detail: `AgentSession.${key} is missing` };
	}
	if (typeof s.queuedMessageCount !== "number") return { ok: false, reason: "hook_changed", detail: "AgentSession.queuedMessageCount is missing" };
	for (const key of ["hasPendingAsyncWork", "getAsyncJobSnapshot"]) {
		if (typeof s[key] !== "function") return { ok: false, reason: "hook_changed", detail: `AgentSession.${key}() is missing` };
	}
	const agent = s.agent;
	if (!agent || typeof agent !== "object" || !("peekSteeringQueue" in agent) || typeof agent.peekSteeringQueue !== "function" || !("peekFollowUpQueue" in agent) || typeof agent.peekFollowUpQueue !== "function") {
		return { ok: false, reason: "hook_changed", detail: "AgentSession.agent queued-only peek APIs are missing" };
	}
	return { ok: true, value: session as WorkSession, detail: "AgentSession settlement + agent queued-only peeks (OMP 18.4.5 user-authored visibility) + getAsyncJobSnapshot" };
}

/**
 * Cancelling a job reaches the session's async job manager, which may be the
 * process-global one. OMP enforces ownership only when given an owner filter,
 * so this fails closed unless the session reports a non-empty agent id.
 */
export function probeJobCanceller(session: unknown): Probe<{ manager: JobCanceller; ownerId: string }> {
	if (!session || typeof session !== "object") return { ok: false, reason: "not_ready", detail: "main session not established" };
	const manager = "asyncJobManager" in session ? session.asyncJobManager : undefined;
	if (!manager || typeof manager !== "object" || !("cancel" in manager) || typeof manager.cancel !== "function") {
		return { ok: false, reason: "hook_changed", detail: "AgentSession.asyncJobManager has no cancel()" };
	}
	if (!("getJob" in manager) || typeof manager.getJob !== "function") {
		return { ok: false, reason: "hook_changed", detail: "AgentSession.asyncJobManager has no getJob(); cannot observe cancellation drain" };
	}
	const ownerId = "getAgentId" in session && typeof session.getAgentId === "function" ? session.getAgentId() : undefined;
	if (typeof ownerId !== "string" || ownerId.length === 0) {
		return { ok: false, reason: "hook_changed", detail: "AgentSession.getAgentId() returned no owner id; refusing unscoped job cancellation" };
	}
	return { ok: true, value: { manager: manager as JobCanceller, ownerId }, detail: "AgentSession.asyncJobManager.cancel scoped to the session's agent id, awaiting getJob().promise" };
}

export function unavailable(api: CapabilityState["api"], reason: CapabilityReason, detail: string): CapabilityState {
	return { available: false, api, reason, detail };
}

export function available(api: CapabilityState["api"], detail: string): CapabilityState {
	return { available: true, api, detail };
}

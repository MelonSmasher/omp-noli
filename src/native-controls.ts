import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BridgeError } from "./bridge";
import { available, unavailable } from "./capabilities";
import { NATIVE_METHODS, type CapabilityState, type NativeMethod } from "./protocol";

const API_DETAILS: Record<NativeMethod, string> = {
	"tree.navigate": "AgentSession.navigateTree", "goal.budget": "AgentSession.goalRuntime.onBudgetMutated",
	"memory.status": "ExtensionContext.memory.status", "memory.search": "ExtensionContext.memory.search", "memory.save": "ExtensionContext.memory.save",
};
function hasAdmissionApi(session: AgentSession): boolean {
	return [session.isBusyForSnapshot, session.isSessionTransitioning, session.hasAdmittedSubmission, session.isDisposed].every(value => typeof value === "boolean")
		&& typeof session.queuedMessageCount === "number" && typeof session.hasPendingAsyncWork === "function";
}
function requireIdle(session: AgentSession): void {
	if (session.isBusyForSnapshot || session.isSessionTransitioning || session.hasAdmittedSubmission || session.isDisposed || session.queuedMessageCount > 0 || session.hasPendingAsyncWork()) throw new BridgeError("busy", "Native session has active work or a transition");
}
function present(method: NativeMethod, ctx: ExtensionContext, session: AgentSession): boolean {
	switch (method) {
		case "tree.navigate": return typeof session.navigateTree === "function" && hasAdmissionApi(session);
		case "goal.budget": return typeof session.goalRuntime?.onBudgetMutated === "function" && typeof session.getGoalModeState === "function" && hasAdmissionApi(session);
		case "memory.status": return typeof ctx.memory?.status === "function";
		case "memory.search": return typeof ctx.memory?.search === "function";
		case "memory.save": return typeof ctx.memory?.save === "function";
	}
}
export function nativeCapabilities(ctx: ExtensionContext | undefined, session: AgentSession | undefined): Record<NativeMethod, CapabilityState> {
	const probe = (method: NativeMethod): CapabilityState => {
		if (!ctx || !session) return unavailable("public", "not_ready", "No owned root session");
		return present(method, ctx, session) ? available("public", API_DETAILS[method])
			: unavailable("public", "export_missing", `Official SDK API required for ${method} is unavailable`);
	};
	return Object.fromEntries(NATIVE_METHODS.map(method => [method, probe(method)])) as Record<NativeMethod, CapabilityState>;
}
function text(params: Record<string, unknown>, key: string, required = true): string | undefined {
	const value = params[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 256 * 1024) throw new BridgeError("bad_request", `${key} must be non-empty bounded text`);
	return value;
}
async function navigate(params: Record<string, unknown>, session: AgentSession) {
	const target = text(params, "targetId")!;
	if (params.summarize !== undefined && typeof params.summarize !== "boolean") throw new BridgeError("bad_request", "summarize must be boolean");
	requireIdle(session);
	const result = await session.navigateTree(target, { summarize: params.summarize as boolean | undefined });
	// SDK-only rendering cache duplicates the entire transcript and is not a control result.
	const { sessionContext: _context, ...response } = result;
	return response;
}
function tokenBudget(value: unknown): number | undefined {
	if (value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new BridgeError("bad_request", "tokenBudget must be null or a positive safe integer");
	return value;
}
async function budget(params: Record<string, unknown>, session: AgentSession) {
	const value = tokenBudget(params.tokenBudget);
	requireIdle(session);
	const goal = session.getGoalModeState()?.goal;
	if (!goal) throw new BridgeError("not_ready", "No native goal exists");
	const result = await session.goalRuntime.onBudgetMutated(value);
	if (!result || result.goal.id !== goal.id) throw new BridgeError("stale_session", "Native goal changed during budget mutation; do not replay");
	if (result.goal.tokenBudget !== value) throw new BridgeError("internal", "Native goal budget was not confirmed; do not replay");
	return result;
}
function search(params: Record<string, unknown>, ctx: ExtensionContext) {
	const query = text(params, "query")!;
	const limit = params.limit;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new BridgeError("bad_request", "limit must be an integer from 1 to 1000");
	return ctx.memory!.search(query, { limit: limit as number | undefined });
}
function save(params: Record<string, unknown>, ctx: ExtensionContext) {
	const content = text(params, "content")!;
	const context = text(params, "context", false);
	const source = text(params, "source", false);
	const importance = params.importance;
	if (importance !== undefined && (typeof importance !== "number" || !Number.isFinite(importance))) throw new BridgeError("bad_request", "importance must be finite");
	return ctx.memory!.save({ content, context, source, importance: importance as number | undefined });
}
const KEYS: Record<NativeMethod, readonly string[]> = {
	"tree.navigate": ["targetId", "summarize"], "goal.budget": ["tokenBudget"], "memory.status": [],
	"memory.search": ["query", "limit"], "memory.save": ["content", "context", "source", "importance"],
};
export async function nativeControl(method: NativeMethod, params: Record<string, unknown>, ctx: ExtensionContext, session: AgentSession): Promise<unknown> {
	if (Object.keys(params).some(key => !KEYS[method].includes(key))) throw new BridgeError("bad_request", "Unknown native parameter");
	if (method.startsWith("memory.") && !ctx.memory) throw new BridgeError("capability_unavailable", "No native memory runtime");
	switch (method) {
		case "tree.navigate": return navigate(params, session);
		case "goal.budget": return budget(params, session);
		case "memory.status": return ctx.memory!.status();
		case "memory.search": return search(params, ctx);
		case "memory.save": return save(params, ctx);
	}
}

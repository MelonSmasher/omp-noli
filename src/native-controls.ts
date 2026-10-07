import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RecallResponse } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { MemoryBackendStatus } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { BridgeError } from "./bridge";
import { available, unavailable } from "./capabilities";
import { NATIVE_METHODS, type CapabilityState, type NativeMethod } from "./protocol";

const API_DETAILS: Record<NativeMethod, string> = {
	"tree.navigate": "AgentSession.navigateTree", "goal.budget": "AgentSession.goalRuntime.onBudgetMutated",
	"memory.status": "ExtensionContext.memory.status", "memory.search": "ExtensionContext.memory.search", "memory.save": "ExtensionContext.memory.save",
};
interface MemoryIdentity {
	revision: number | undefined;
	sessionId: string | undefined;
	cwd: string | undefined;
	state: HindsightSessionState | undefined;
	aliasOf: HindsightSessionState | undefined;
	stateSessionId: string | undefined;
}
const memorySnapshots = new WeakMap<ExtensionContext, MemoryIdentity & { session: AgentSession; status: MemoryBackendStatus }>();
function hindsightState(session: AgentSession): HindsightSessionState | undefined {
	return typeof session.getHindsightSessionState === "function" ? session.getHindsightSessionState() : undefined;
}
function memoryIdentity(session: AgentSession): MemoryIdentity {
	const state = hindsightState(session);
	return { revision: session.settings?.revision, sessionId: session.sessionManager?.getSessionId(), cwd: session.sessionManager?.getCwd(), state, aliasOf: state?.aliasOf, stateSessionId: state?.sessionId };
}
function sameMemoryIdentity(session: AgentSession, before: MemoryIdentity): boolean {
	const after = memoryIdentity(session);
	return !session.isDisposed && !session.isSessionTransitioning && after.revision === before.revision && after.sessionId === before.sessionId && after.cwd === before.cwd && after.state === before.state && after.aliasOf === before.aliasOf && after.stateSessionId === before.stateSessionId
		&& (!before.aliasOf || before.aliasOf.session.getHindsightSessionState() === before.aliasOf);
}
async function memoryStatus(ctx: ExtensionContext, session: AgentSession): Promise<MemoryBackendStatus> {
	if (typeof ctx.memory?.status !== "function") throw new BridgeError("capability_unavailable", "No native memory status API");
	const before = memoryIdentity(session);
	if (!sameMemoryIdentity(session, before)) throw new BridgeError("busy", "Native memory session has a transition or is disposed");
	const native = await ctx.memory.status();
	if (!sameMemoryIdentity(session, before)) throw new BridgeError("stale_session", "Native memory scope changed during status");
	const state = before.state;
	const status: MemoryBackendStatus = native.backend === "hindsight"
		? { ...native, active: !!state, searchable: !!state && typeof state.client?.recall === "function", writable: native.writable === true && typeof ctx.memory.save === "function",
			...(state ? { scope: state.config.scoping, recallBanks: [state.bankId], message: "Hindsight recall uses the owned native session client and scope." } : { writable: false, message: "Hindsight backend is not initialized for this session." }) }
		: { ...native, searchable: native.active === true && native.searchable === true && typeof ctx.memory.search === "function", writable: native.active === true && native.writable === true && typeof ctx.memory.save === "function" };
	memorySnapshots.set(ctx, { session, ...before, status });
	return status;
}
function memoryCapability(method: "memory.search" | "memory.save", ctx: ExtensionContext, session: AgentSession): CapabilityState {
	if (typeof ctx.memory?.status !== "function") return unavailable("public", "export_missing", "Official native memory status API is unavailable");
	const snapshot = memorySnapshots.get(ctx);
	const known = snapshot?.session === session && sameMemoryIdentity(session, snapshot) ? snapshot.status : undefined;
	const supported = known ? (method === "memory.search" ? known.searchable : known.writable)
		: (method === "memory.search" && typeof hindsightState(session)?.client?.recall === "function") || present(method, ctx, session);
	return supported ? available("public", method === "memory.search" && hindsightState(session) ? "AgentSession.getHindsightSessionState().client.recall" : API_DETAILS[method])
		: unavailable("public", "not_ready", `Configured native memory backend does not support ${method}`);
}
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
		if (method === "memory.search" || method === "memory.save") return memoryCapability(method, ctx, session);
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
async function search(params: Record<string, unknown>, ctx: ExtensionContext, session: AgentSession) {
	const query = text(params, "query")!;
	const limit = params.limit;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new BridgeError("bad_request", "limit must be an integer from 1 to 1000");
	const before = memoryIdentity(session);
	const status = await memoryStatus(ctx, session);
	if (!sameMemoryIdentity(session, before)) throw new BridgeError("stale_session", "Native memory scope changed before search");
	if (!status.active || !status.searchable) throw new BridgeError("capability_unavailable", "Configured native memory backend does not support search");
	if (status.backend !== "hindsight") {
		const result = await ctx.memory!.search(query, { limit: limit as number | undefined });
		if (!sameMemoryIdentity(session, before)) throw new BridgeError("stale_session", "Native memory scope changed during search");
		return result;
	}
	const state = before.state!;
	const client = state.client;
	const bankId = state.bankId;
	const tags = state.recallTags?.slice();
	const tagsMatch = state.recallTagsMatch;
	const config = state.config;
	const scoping = config.scoping;
	const budget = config.recallBudget;
	const maxTokens = config.recallMaxTokens;
	const types = config.recallTypes.slice();
	let response: RecallResponse;
	try {
		response = await client.recall(bankId, query, { budget, maxTokens, types: types.length ? types : undefined, tags, tagsMatch });
	} catch {
		// Native HTTP errors may echo server-provided secrets; do not expose their body.
		throw new BridgeError("internal", "Native Hindsight recall failed");
	}
	if (!sameMemoryIdentity(session, before) || state.client !== client || state.bankId !== bankId || state.config !== config || config.scoping !== scoping || state.recallTagsMatch !== tagsMatch || JSON.stringify(state.recallTags) !== JSON.stringify(tags) || config.recallBudget !== budget || config.recallMaxTokens !== maxTokens || JSON.stringify(config.recallTypes) !== JSON.stringify(types)) throw new BridgeError("stale_session", "Native Hindsight scope changed during search");
	if (!response || !Array.isArray(response.results) || response.results.some(item => !item || typeof item.text !== "string")) throw new BridgeError("internal", "Native Hindsight returned invalid recall results");
	const items = response.results.slice(0, limit as number | undefined).map(item => ({ content: item.text,
		...(typeof item.id === "string" ? { id: item.id } : {}),
		...(typeof item.type === "string" ? { source: item.type } : {}),
		...(typeof item.mentioned_at === "string" ? { timestamp: item.mentioned_at } : {}),
		...(typeof item.score === "number" && Number.isFinite(item.score) ? { score: item.score } : {}),
	}));
	return { backend: "hindsight", query, count: items.length, items };
}
async function save(params: Record<string, unknown>, ctx: ExtensionContext, session: AgentSession) {
	const content = text(params, "content")!;
	const context = text(params, "context", false);
	const source = text(params, "source", false);
	const importance = params.importance;
	if (importance !== undefined && (typeof importance !== "number" || !Number.isFinite(importance))) throw new BridgeError("bad_request", "importance must be finite");
	const before = memoryIdentity(session);
	const status = await memoryStatus(ctx, session);
	if (!sameMemoryIdentity(session, before)) throw new BridgeError("stale_session", "Native memory scope changed before save");
	if (!status.active || !status.writable) throw new BridgeError("capability_unavailable", "Configured native memory backend does not support save");
	const result = await ctx.memory!.save({ content, context, source, importance: importance as number | undefined });
	if (!sameMemoryIdentity(session, before)) throw new BridgeError("stale_session", "Native memory scope changed during save; do not replay");
	return result;
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
		case "memory.status": return memoryStatus(ctx, session);
		case "memory.search": return search(params, ctx, session);
		case "memory.save": return save(params, ctx, session);
	}
}

import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BridgeError } from "./bridge";
import { available, unavailable } from "./capabilities";
import { NATIVE_METHODS, type CapabilityState, type NativeMethod } from "./protocol";

export function nativeCapabilities(ctx: ExtensionContext | undefined, session: AgentSession | undefined): Record<NativeMethod, CapabilityState> {
	const probe = (method: NativeMethod): CapabilityState => {
		if (!ctx || !session) return unavailable("public", "not_ready", "No owned root session");
		const present = method === "tree.navigate" ? typeof session.navigateTree === "function" && typeof session.isBusyForSnapshot === "boolean"
			: method === "goal.budget" ? typeof session.goalRuntime?.onBudgetMutated === "function" && typeof session.getGoalModeState === "function" && typeof session.isBusyForSnapshot === "boolean"
			: typeof ctx.memory?.[method.slice(7) as "status" | "search" | "save"] === "function";
		return present ? available("public", method.startsWith("memory.") ? `ExtensionContext.${method}` : method === "tree.navigate" ? "AgentSession.navigateTree" : "AgentSession.goalRuntime.onBudgetMutated")
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

export async function nativeControl(method: NativeMethod, params: Record<string, unknown>, ctx: ExtensionContext, session: AgentSession): Promise<unknown> {
	const keys: Record<NativeMethod, readonly string[]> = {
		"tree.navigate": ["targetId", "summarize"], "goal.budget": ["tokenBudget"], "memory.status": [],
		"memory.search": ["query", "limit"], "memory.save": ["content", "context", "source", "importance"],
	};
	if (Object.keys(params).some(key => !keys[method].includes(key))) throw new BridgeError("bad_request", "Unknown native parameter");
	if (method === "tree.navigate") {
		const target = text(params, "targetId")!;
		if (params.summarize !== undefined && typeof params.summarize !== "boolean") throw new BridgeError("bad_request", "summarize must be boolean");
		if (session.isBusyForSnapshot) throw new BridgeError("busy", "Native transcript has active work");
		return session.navigateTree(target, { summarize: params.summarize as boolean | undefined });
	}
	if (method === "goal.budget") {
		const budget = params.tokenBudget;
		if (budget !== null && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0)) throw new BridgeError("bad_request", "tokenBudget must be null or a positive safe integer");
		if (session.isBusyForSnapshot) throw new BridgeError("busy", "Native goal has active work");
		if (!session.getGoalModeState()) throw new BridgeError("not_ready", "No native goal exists");
		return session.goalRuntime.onBudgetMutated(budget === null ? undefined : budget as number);
	}
	if (!ctx.memory) throw new BridgeError("capability_unavailable", "No native memory runtime");
	if (method === "memory.status") return ctx.memory.status();
	if (method === "memory.search") {
		const query = text(params, "query")!;
		const limit = params.limit;
		if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new BridgeError("bad_request", "limit must be an integer from 1 to 1000");
		return ctx.memory.search(query, { limit: limit as number | undefined });
	}
	const content = text(params, "content")!;
	const context = text(params, "context", false);
	const source = text(params, "source", false);
	const importance = params.importance;
	if (importance !== undefined && (typeof importance !== "number" || !Number.isFinite(importance))) throw new BridgeError("bad_request", "importance must be finite");
	return ctx.memory.save({ content, context, source, importance: importance as number | undefined });
}

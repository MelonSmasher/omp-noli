import type { AgentRef, FileEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AgentTelemetryView } from "./protocol";

/** The host checks canonical ownership and rechecks ref/session/path identity after the read. */
type ReadChild = <T>(ref: AgentRef, loader: (file: string) => Promise<T>) => Promise<T>;

const EMPTY: AgentTelemetryView = Object.freeze({
	model: null,
	effort: null,
	requests: null,
	contextTokens: null,
	contextWindow: null,
	inputTokens: null,
	outputTokens: null,
	sessionCost: null,
	tokensPerSecond: null,
});
const RESOLVED = Promise.resolve();

/** Optional SDK members can fail independently (including getters on a disposed session). */
function get(value: unknown, key: string): unknown {
	try {
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)[key] : undefined;
	} catch {
		return undefined;
	}
}

function call(value: unknown, key: string): unknown {
	try {
		const method = get(value, key);
		return typeof method === "function" ? method.call(value) : undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nonnegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function count(value: unknown): number | null {
	const valid = nonnegative(value);
	return valid !== null && Number.isSafeInteger(valid) ? valid : null;
}

/** Applied levels, not configured selectors such as auto/inherit. */
function effort(value: unknown): string | null {
	if (typeof value !== "string") return null;
	switch (value) {
		case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max":
			return value;
		default:
			return null;
	}
}

function modelIdentity(model: unknown): string | null {
	const provider = text(get(model, "provider"));
	const id = text(get(model, "id"));
	return provider !== null && id !== null ? `${provider}/${id}` : null;
}

/** Persisted selectors may contain effort; it is never evidence of the applied thinking level. */
function persistedIdentity(value: unknown): string | null {
	const selector = text(value);
	return selector === null ? null : selector.replace(/:(?:off|minimal|low|medium|high|xhigh|max|inherit|auto)$/, "");
}

/** Reproduce SessionManager's persisted leaf, not a flat scan across abandoned branches. */
function activeBranch(entries: FileEntry[]): { branch: SessionEntry[]; byId: Map<string, SessionEntry> } {
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;
	for (const entry of entries) {
		if (get(entry, "type") === "session" || text(get(entry, "id")) === null) continue;
		leaf = entry as SessionEntry;
		byId.set(leaf.id, leaf);
	}
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let entry = leaf;
	while (entry && !seen.has(entry.id)) {
		seen.add(entry.id);
		branch.push(entry);
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}
	branch.reverse();
	return { branch, byId };
}

/** Native session-stats includes adjacent non-message calls preceding the first kept message. */
function usageWindow(branch: SessionEntry[]): { start: number; contextBoundary: number } {
	let compaction = -1;
	let reset = -1;
	for (let index = 0; index < branch.length; index++) {
		const type = branch[index]!.type;
		if (type === "compaction") compaction = index;
		else if (type === "reset_boundary") reset = index;
	}
	let start = 0;
	if (reset > compaction) {
		start = reset + 1;
	} else if (compaction >= 0) {
		const firstKept = get(branch[compaction], "firstKeptEntryId");
		start = branch.findIndex(entry => entry.id === firstKept);
		if (start < 0) start = compaction + 1;
		while (start > 0) {
			const type = branch[start - 1]!.type;
			if (type === "message" || type === "custom_message" || type === "branch_summary" ||
				type === "compaction" || type === "reset_boundary") break;
			start--;
		}
	}
	return { start, contextBoundary: Math.max(reset, compaction) };
}

class UsageTotals {
	#seen = false;
	input: number | null = 0;
	output: number | null = 0;
	cost: number | null = 0;

	add(usage: unknown): void {
		this.#seen = true;
		this.input = this.#sum(this.input, get(usage, "input"), true);
		this.output = this.#sum(this.output, get(usage, "output"), true);
		this.cost = this.#sum(this.cost, get(get(usage, "cost"), "total"));
	}

	#sum(total: number | null, value: unknown, tokens = false): number | null {
		const valid = tokens ? count(value) : nonnegative(value);
		if (total === null || valid === null) return null;
		return tokens ? count(total + valid) : nonnegative(total + valid);
	}

	apply(view: AgentTelemetryView): void {
		if (!this.#seen) return;
		view.inputTokens = this.input;
		view.outputTokens = this.output;
		view.sessionCost = this.cost;
	}
}

/** Same eligibility as native taskToolUsage; non-task results do not contribute model usage. */
function taskUsage(message: unknown): unknown {
	if (get(message, "toolName") !== "task") return undefined;
	const usage = get(get(message, "details"), "usage");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
		if (typeof get(usage, key) !== "number") return undefined;
	}
	return typeof get(get(usage, "cost"), "total") === "number" ? usage : undefined;
}

function persistedContext(message: unknown): number | null {
	if (get(message, "stopReason") === "error" || get(message, "stopReason") === "aborted") return null;
	const snapshot = get(message, "contextSnapshot");
	const prompt = count(get(snapshot, "promptTokens"));
	if (prompt !== null) {
		const rawRemoved = get(snapshot, "historyRewriteTokensRemoved");
		const removed = rawRemoved === undefined ? 0 : count(rawRemoved);
		return removed === null ? null : Math.max(0, prompt - removed);
	}
	return count(get(get(message, "usage"), "contextTokens"));
}

/** No registry ownership, writers, subscriptions, polling, or session revival lives here. */
export class AgentTelemetry {
	readonly #api: Record<string, unknown>;
	readonly #readChild: ReadChild;
	#retained = new WeakMap<AgentRef, AgentTelemetryView>();
	#pending = new WeakMap<AgentRef, Promise<void>>();

	constructor(api: Record<string, unknown>, readChild: ReadChild) {
		this.#api = api;
		this.#readChild = readChild;
	}

	/** Each live observation is sourced only from this ref's own session. */
	sample(ref: AgentRef): AgentTelemetryView {
		const session = ref.session;
		if (!session) {
			const retained = this.#retained.get(ref);
			if (!retained) return EMPTY;
			if (retained.tokensPerSecond === null) return retained;
			const parked = Object.freeze({ ...retained, tokensPerSecond: null });
			this.#retained.set(ref, parked);
			return parked;
		}
		const serving = get(session, "servingModel");
		const stats = call(session, "getSessionStats");
		const tokens = get(stats, "tokens");
		const context = get(stats, "contextUsage");
		const window = count(get(context, "contextWindow"));
		const view: AgentTelemetryView = Object.freeze({
			model: text(get(serving, "modelIdentity")) ?? modelIdentity(get(session, "model")),
			effort: effort(get(serving, "thinkingLevel")) ?? effort(get(session, "thinkingLevel")),
			requests: count(get(stats, "assistantMessages")),
			contextTokens: count(get(context, "tokens")),
			contextWindow: window !== null && window > 0 ? window : null,
			inputTokens: count(get(tokens, "input")),
			outputTokens: count(get(tokens, "output")),
			sessionCost: nonnegative(get(stats, "cost")),
			tokensPerSecond: nonnegative(call(get(session, "tokenRate"), "rate")),
		});
		this.#retained.set(ref, view);
		return view;
	}

	/** Optional cold recovery is single-flight per exact ref and never rejects into listing/chat. */
	restore(ref: AgentRef): Promise<void> {
		if (ref.session || !ref.sessionFile || this.#retained.has(ref)) return RESOLVED;
		const existing = this.#pending.get(ref);
		if (existing) return existing;
		const pending = this.#pending;
		const operation = this.#restore(ref, ref.sessionFile, this.#retained).finally(() => {
			if (pending.get(ref) === operation) pending.delete(ref);
		});
		pending.set(ref, operation);
		return operation;
	}

	async #restore(ref: AgentRef, file: string, retained: WeakMap<AgentRef, AgentTelemetryView>): Promise<void> {
		try {
			const load = get(this.#api, "loadEntriesFromFile");
			if (typeof load !== "function") return;
			const entries: unknown = await this.#readChild(ref, path => load(path, undefined, { throwIfMissing: true }));
			// The host rechecks registry ownership. These guards also prevent writes after clear/revival/path change.
			if (retained !== this.#retained || ref.session || ref.sessionFile !== file || retained.has(ref)) return;
			if (!Array.isArray(entries) || entries.length === 0) return;
			const migrate = get(this.#api, "migrateToCurrentVersion");
			if (typeof migrate === "function") migrate(entries);
			const view = this.#fromEntries(entries as FileEntry[]);
			if (retained === this.#retained && !ref.session && ref.sessionFile === file && !retained.has(ref)) {
				retained.set(ref, Object.freeze(view));
			}
		} catch {
			// Missing/corrupt/changed transcripts and optional SDK failures cannot break core agent operations.
		}
	}

	#fromEntries(entries: FileEntry[]): AgentTelemetryView {
		const { branch, byId } = activeBranch(entries);
		const view = { ...EMPTY };
		const { start, contextBoundary } = usageWindow(branch);
		const producedOutput = get(this.#api, "assistantTurnProducedOutput");
		let served: string | null = null;
		let latestModel: string | null = null;
		let thinkingObserved = false;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "thinking_level_change" && !thinkingObserved) {
				thinkingObserved = true;
				view.effort = effort(entry.thinkingLevel);
			} else if (entry.type === "model_change") {
				const model = persistedIdentity(entry.model);
				latestModel ??= model;
				if (served !== null && view.model === null && model !== null &&
					(model === served || model.startsWith(`${served}@`))) view.model = model;
			} else if (entry.type === "session_init") {
				latestModel ??= persistedIdentity(entry.resolvedModel);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				if (served === null && typeof producedOutput === "function") {
					try {
						if (producedOutput(entry.message)) {
							const provider = text(entry.message.provider);
							const model = text(entry.message.model);
							if (provider !== null && model !== null) served = `${provider}/${model}`;
						}
					} catch {
						// Optional attribution cannot suppress otherwise recoverable usage.
					}
				}
				if (index > contextBoundary && view.contextTokens === null) view.contextTokens = persistedContext(entry.message);
			}
		}
		view.model ??= served ?? latestModel;

		// Native projection determines the active message window, including remote compaction and retry filtering.
		const build = get(this.#api, "buildSessionContext");
		if (typeof build !== "function") return view;
		let messages: unknown;
		try {
			messages = get(build(branch, branch[branch.length - 1]?.id, byId), "messages");
		} catch {
			return view;
		}
		if (!Array.isArray(messages)) return view;
		const usage = new UsageTotals();
		view.requests = 0;
		for (const message of messages) {
			if (get(message, "role") === "assistant") {
				view.requests++;
				const assistantUsage = get(message, "usage");
				if (assistantUsage !== undefined && assistantUsage !== null) usage.add(assistantUsage);
			} else if (get(message, "role") === "toolResult") {
				const task = taskUsage(message);
				if (task !== undefined) usage.add(task);
			}
		}
		for (let index = start; index < branch.length; index++) {
			const entry = branch[index]!;
			if (entry.type === "model_usage") usage.add(entry.usage);
		}
		usage.apply(view);
		return view;
	}

	/** Adoption/release invalidates retained and pending results without retaining ref objects. */
	clear(): void {
		this.#retained = new WeakMap();
		this.#pending = new WeakMap();
	}
}

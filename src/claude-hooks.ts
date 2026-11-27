import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { compact } from "@oh-my-pi/pi-agent-core/compaction";
import type { ProducerChannel } from "./bridge";
import { EPOCH_ENTRY_TYPE, type EpochData, type FactsIdentity, type ToolTiming, epochEntryId, prevToolDurations, requestFacts, resetEntryIds } from "./claude-facts";
import { enrichGatewayModels, isGatewayModel } from "./gateway";
import type { CapabilityState, CompactionKind, NoliRequestTag } from "./protocol";
import { SIDE_CHANNEL_REMINDERS, SYSTEM_PREFIXES } from "./system-prefix.generated";

/**
 * Authenticated Gateway request correlation on stock OMP.
 *
 * Every session of the managed launch (the root and each rejoined child) gets its
 * own instance. The `context` event registers the pending main-loop call's facts
 * over the bridge; a synchronous `before_provider_request` handler tags each
 * Gateway body with `noli_request`, and Noli removes that member before shaping.
 * Children reach the root's bridge through the process-level channel below,
 * keyed by the launch directory like the Gateway catalog.
 */
let channel: { dir: string; producer: ProducerChannel; root(): string | undefined } | undefined;
/** Announced sessions by agent registry id, so a nested child names its spawning agent's session. */
const agentSessions = new Map<string, string>();

export function bindProducerChannel(dir: string, producer: ProducerChannel, root: () => string | undefined): void {
	channel = { dir, producer, root };
}

export function releaseProducerChannel(dir: string): void {
	if (channel?.dir !== dir) return;
	channel = undefined;
	agentSessions.clear();
}

/** A cache-warm replay follows its decision directly; later requests are not warm. */
const WARM_WINDOW_MS = 30_000;

type AgentMessage = ContextEvent["messages"][number];

/**
 * Stock OMP races every extension handler against a fixed 30 s budget and drops a late result,
 * which would let stock summarization run after a long fork. While a native compaction runs,
 * the budget of the live runner module is raised to this, and restored when the last
 * compaction in the process ends. Noli's bracket TTL matches it.
 */
export const COMPACTION_HANDLER_BUDGET_MS = 20 * 60_000;

/** Raises the live runner's handler budget for one compaction; `false` when unavailable (fail closed). */
export interface HandlerBudget {
	lift(ctx: ExtensionContext): boolean;
	restore(): void;
}
interface RunnerModule {
	ExtensionRunner: abstract new (...args: never[]) => unknown;
	EXTENSION_HANDLER_TIMEOUT_MS: number;
	testSetExtensionHandlerTimeoutMs(timeoutMs: number): void;
}
type AgentRegistryApi = { AgentRegistry?: { global(): { get(id: string): { session?: { extensionRunner?: unknown } } | undefined } } };
type Emit = (this: unknown, event: { type?: unknown }, ...rest: unknown[]) => Promise<unknown>;

let budgetHolders = 0;
const hold = (runner: RunnerModule): void => {
	if (budgetHolders++ === 0) runner.testSetExtensionHandlerTimeoutMs(COMPACTION_HANDLER_BUDGET_MS);
};
const release = (runner: RunnerModule): void => {
	if (budgetHolders > 0 && --budgetHolders === 0) runner.testSetExtensionHandlerTimeoutMs(runner.EXTENSION_HANDLER_TIMEOUT_MS);
};

/** The runner module each patched `ExtensionRunner` prototype holds the budget through; the latest wins. */
const compactionEmitters = new WeakMap<object, RunnerModule>();

/**
 * OMP 19 reads the handler budget once per emission, before any handler runs, so a lift from
 * inside a `session_before_compact` handler only reached later emissions: a native compaction
 * slower than 30 s was cut off and stock summarization ran instead (2026-11-24). Hold the
 * budget around the whole compaction emission, through the runner's public `emit`, which
 * manual and automatic compaction both call.
 */
function holdAroundCompaction(runner: RunnerModule): void {
	const prototype = runner.ExtensionRunner.prototype as { emit?: Emit };
	const installed = compactionEmitters.has(prototype);
	compactionEmitters.set(prototype, runner);
	const emit = prototype.emit;
	if (installed || typeof emit !== "function") return;
	prototype.emit = async function (this: unknown, event, ...rest) {
		const module = event?.type === "session_before_compact" ? compactionEmitters.get(prototype) : undefined;
		if (!module) return emit.call(this, event, ...rest);
		hold(module);
		try {
			return await emit.call(this, event, ...rest);
		} finally {
			release(module);
		}
	};
}

/**
 * A budget over `runner`, valid only for sessions whose live extension runner is an instance of
 * that module's `ExtensionRunner` (so the module global it sets is the one the host reads).
 */
export function runnerHandlerBudget(runner: RunnerModule, liveRunner: (ctx: ExtensionContext) => unknown): HandlerBudget {
	holdAroundCompaction(runner);
	return {
		lift(ctx) {
			if (!(liveRunner(ctx) instanceof runner.ExtensionRunner)) return false;
			hold(runner);
			return true;
		},
		restore() {
			release(runner);
		},
	};
}

/** The managed launch runs OMP from source (`NOLI_OMP_SDK_ROOT`), so a deep import binds the live module. */
async function sdkHandlerBudget(pi: ExtensionAPI): Promise<HandlerBudget | undefined> {
	const root = process.env.NOLI_OMP_SDK_ROOT;
	if (!root) return undefined;
	try {
		// Runtime-selected: the live runner module is the launcher's SDK root, not the extension's own dependency.
		const runner = await import(pathToFileURL(join(root, "src/extensibility/extensions/runner.ts")).href) as Partial<RunnerModule>;
		if (typeof runner.ExtensionRunner !== "function" || typeof runner.testSetExtensionHandlerTimeoutMs !== "function"
			|| typeof runner.EXTENSION_HANDLER_TIMEOUT_MS !== "number") return undefined;
		const registry = (pi.pi as AgentRegistryApi | undefined)?.AgentRegistry;
		return runnerHandlerBudget(runner as RunnerModule, ctx => registry?.global().get(ctx.agent.id)?.session?.extensionRunner);
	} catch {
		return undefined;
	}
}

export interface ClaudeHookOptions {
	/**
	 * Observe `tool_result` to time and include only tools that actually executed. Set it only
	 * where another omp-noli handler already observes `tool_result` (the root's thread control):
	 * a first `tool_result` handler makes stock OMP skip speculative execution (speculation/host.ts:76-83).
	 */
	toolResults: boolean;
	/** Tests only: the handler budget; the managed launch resolves the live runner module. */
	handlerBudget?: Promise<HandlerBudget | undefined>;
    /** Resolve semantic admission before the root opens its bridge socket. */
    onPrepared?: (capability: (ctx: ExtensionContext) => CapabilityState) => void;
}


/** Read only the launched official SDK's marker, never a prompt or a cache key. */
function sideChannelReminder(version: string): { sha256: string; len: number } | undefined {
	const sdk = process.env.NOLI_OMP_SDK_ROOT;
	if (sdk) {
		try {
			if (JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version !== version) return undefined;
			const text = readFileSync(join(sdk, "src/prompts/system/side-channel-no-tools.md"), "utf8");
			if (!text) return undefined;
			return { sha256: createHash("sha256").update(text).digest("hex"), len: Buffer.byteLength(text) };
		} catch { return undefined; }
	}
	return SIDE_CHANNEL_REMINDERS[version];
}

export function installClaudeHooks(pi: ExtensionAPI, dir: string, options: ClaudeHookOptions): void {
	const version: unknown = (pi.pi as { VERSION?: unknown } | undefined)?.VERSION;
	const ompVersion = typeof version === "string" && version ? version : "unknown";
	const sideReminder = sideChannelReminder(ompVersion);
    let markerFailureReported = false;
	/** The reference for this session's pending main-loop call; replaced by each main `context` event. */
	let pending: { ref: string | null } | undefined;
	let warmUntil = 0;
	let compacting: string | undefined;
	let announced: string | undefined;
	let sentBranch: string | undefined;
	/** Tool timings of this session in memory only; a restart starts without them, as Claude Code does. */
	const timings = new Map<string, ToolTiming>();
	let toolEpoch = 0;
	/** The reason of the auto compaction OMP announced last; none means a manual `/compact`. */
	let autoReason: string | undefined;
	let budget: HandlerBudget | undefined;
	let budgetHeld = false;
	// Resolved once, ahead of any compaction: a raced `session_before_compact` handler never waits on it.
    const prepared = (resolved: HandlerBudget | undefined): void => {
        budget = resolved;
        options.onPrepared?.(ctx => {
            const unavailable = (detail: string): CapabilityState => ({ available: false, api: "native-provenance-v1", reason: "hook_changed", detail });
            if (!sideReminder) return unavailable("Update OMP and omp-noli explicitly: the selected SDK side-channel marker is unavailable");
            if (!budget) return unavailable("Update OMP and omp-noli explicitly: the selected SDK compaction handler budget is unavailable");
            let lifted = false;
            try {
                lifted = budget.lift(ctx);
                if (!lifted) return unavailable("Update OMP and omp-noli explicitly: the live compaction runner cannot be verified");
                return { available: true, api: "native-provenance-v1", detail: "Authenticated producer/session routing for Messages and both Responses APIs; exact dispatch-bound OMP compaction with the verified live runner" };
            } catch { return unavailable("Update OMP and omp-noli explicitly: the live compaction runner could not be probed"); }
            finally { if (lifted) budget.restore(); }
        });
    };
    void (options.handlerBudget ?? sdkHandlerBudget(pi)).then(prepared, () => prepared(undefined));
	const live = () => channel?.dir === dir ? channel : undefined;

	const identity = (ctx: ExtensionContext): Omit<FactsIdentity, "requestClass" | "querySource"> | undefined => {
		const main = ctx.agent.kind === "main";
		const root = live()?.root();
		const spawner = ctx.agent.parentId === undefined ? undefined : agentSessions.get(ctx.agent.parentId);
		const parent = main ? null : spawner ?? root;
		if (parent === undefined) return undefined;
		return { ompSessionId: ctx.sessionManager.getSessionId(), agentId: ctx.agent.id, parentOmpSessionId: parent };
	};

	/** One epoch entry per session marks where recomputed facts start (design §4 row 3). */
	const ensureEpoch = (ctx: ExtensionContext): void => {
		if (epochEntryId(ctx.sessionManager.getBranch())) return;
		try {
			pi.appendEntry<EpochData>(EPOCH_ENTRY_TYPE, { ompVersion });
		} catch {
			// Before the runtime is initialized; the next session event or context retries.
		}
	};

	const sendBranch = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
		const producer = live()?.producer;
		if (!producer) return;
		const ompSessionId = ctx.sessionManager.getSessionId();
		const resets = resetEntryIds(ctx.sessionManager.getBranch());
		const signature = `${ompSessionId}\0${resets.join("\0")}`;
		if (!force && signature === sentBranch) return;
		sentBranch = signature;
		await producer.branch({ ompSessionId, leafId: ctx.sessionManager.getLeafId(), resetEntryIds: resets });
	};

	const announce = (ctx: ExtensionContext): boolean => {
		const producer = live()?.producer;
		const self = identity(ctx);
		if (!producer || !self) return false;
		if (announced !== undefined && announced !== self.ompSessionId) producer.forget(announced);
		announced = self.ompSessionId;
		agentSessions.set(self.agentId, self.ompSessionId);
		producer.announce({
			ompSessionId: self.ompSessionId,
			parentOmpSessionId: self.parentOmpSessionId,
			agentKind: ctx.agent.kind,
			agentId: self.agentId,
			epochEntryId: epochEntryId(ctx.sessionManager.getBranch()),
			ompVersion,
			systemPrefix: SYSTEM_PREFIXES[ompVersion] ?? null,
		});
		return true;
	};

	const endCompaction = (): void => {
		const ompSessionId = compacting;
		compacting = undefined;
		if (ompSessionId === undefined) return;
		live()?.producer.compaction({ ompSessionId, phase: "end", facts: null }).catch(() => {});
	};

	const adopt = (ctx: ExtensionContext, writeEpoch: boolean): void => {
		enrichGatewayModels(ctx);
		if (writeEpoch) ensureEpoch(ctx);
		// Noli keeps the recorded branch; the bridge re-sends it after authentication.
		if (announce(ctx)) sendBranch(ctx, true).catch(() => {});
	};

	/** Stock ephemeral side turns carry this exact reminder; they are never main-loop calls. */
	const isSideTurn = (messages: readonly AgentMessage[]): boolean => {
		if (!sideReminder) return false;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role !== "developer" || message.attribution !== "agent" || typeof message.content === "string" || message.content.length !== 1) continue;
			const block = message.content[0]!;
			if (block.type !== "text" || Buffer.byteLength(block.text) !== sideReminder.len) continue;
			if (createHash("sha256").update(block.text).digest("hex") === sideReminder.sha256) return true;
		}
		return false;
	};

	pi.on("session_start", (_event, ctx) => adopt(ctx, true));
	pi.on("session_switch", (_event, ctx) => adopt(ctx, true));
	pi.on("session_branch", (_event, ctx) => adopt(ctx, true));
	// Tree navigation keeps the session; a path without an epoch stays unknown history.
	pi.on("session_tree", (_event, ctx) => adopt(ctx, false));
	pi.on("session_shutdown", (_event, ctx) => {
		endCompaction();
		if (announced !== undefined) live()?.producer.forget(announced);
		if (agentSessions.get(ctx.agent.id) === announced) agentSessions.delete(ctx.agent.id);
		announced = undefined;
		pending = undefined;
	});

	/** Facts for one main-loop or subagent request, including the previous tool batch under its wire names. */
	const factsFor = (messages: readonly AgentMessage[], ctx: ExtensionContext, self: Omit<FactsIdentity, "requestClass" | "querySource">) => {
		const branch = ctx.sessionManager.getBranch();
		const compat = ctx.model?.compat;
		const escape = !!compat && "escapeBuiltinToolNames" in compat && compat.escapeBuiltinToolNames === true;
		const durations = prevToolDurations(messages, branch, timings, toolEpoch, escape);
		const main = ctx.agent.kind === "main";
		const facts = requestFacts(messages, branch, { ...self, requestClass: main ? "main" : "subagent", querySource: main ? "agent" : "task" });
		return { ...facts, ...(durations ? { prevToolDurations: durations } : {}) };
	};

	/** Registers one request's facts; the reference lands in `slot` unless a newer request replaced it. */
	const registerFacts = async (messages: readonly AgentMessage[], ctx: ExtensionContext, slot: { ref: string | null }): Promise<void> => {
		ensureEpoch(ctx);
		if (announced !== ctx.sessionManager.getSessionId() && !announce(ctx)) return;
		const self = identity(ctx);
		const producer = live()?.producer;
		if (!self || !producer) return;
		const facts = factsFor(messages, ctx, self);
		pruneTimings();
		await sendBranch(ctx, false);
		const ref = await producer.register(self.ompSessionId, facts);
		if (pending === slot) slot.ref = ref;
	};
	/** Timings of earlier resets are never emitted again; the cap bounds a session that never resets. */
	const pruneTimings = (): void => {
		for (const [id, timing] of timings) if (timing.epoch !== toolEpoch || timings.size > 1024) timings.delete(id);
	};

	pi.on("before_agent_start", (_event, ctx) => { enrichGatewayModels(ctx); });

	pi.on("context", async (event, ctx) => {
		warmUntil = 0;
		enrichGatewayModels(ctx);
		if (!live() || !isGatewayModel(ctx.model)) return;
		// Side contexts never register fabricated main facts. Keep the parent's
		// ownership proof; the actual side dispatch header prevents main admission.
        if (!sideReminder) {
            pending = undefined;
            if (!markerFailureReported) {
                markerFailureReported = true;
                pi.logger?.warn("Update OMP and omp-noli explicitly: the selected SDK side-channel marker is unavailable; main request provenance was not registered");
            }
            return;
        }
		if (isSideTurn(event.messages)) return;
		const slot: { ref: string | null } = { ref: null };
		pending = slot;
		try {
			await registerFacts(event.messages, ctx, slot);
		} catch (error) {
			// Fail closed: the call is tagged with a null reference and Noli rejects it.
			pi.logger?.warn("Noli request registration failed", { error: error instanceof Error ? error.message : String(error) });
		}
	});


	// Synchronous on purpose: the runner's timeout and fail-open paths cannot drop a value returned without awaiting.
	pi.on("before_provider_request", (event, ctx) => {
		if (!live() || !isGatewayModel(ctx.model)) return undefined;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const warm = Date.now() < warmUntil;
		const tag: NoliRequestTag = { session: ctx.sessionManager.getSessionId(), ref: warm ? null : pending?.ref ?? null, warm };
		// Retain this proof across retries and side turns. Only the producer's
		// exact dispatch session can consume its main-request registration.
		return { ...payload, noli_request: tag };
	});

	pi.on("cache_warming_decision", event => {
		if (event.action === "warm") warmUntil = Date.now() + WARM_WINDOW_MS;
		return undefined;
	});

	// All native families use OMP's own preparation, prompts and summary result.
	// Only authenticated producer context is added; native clients never compact.
	pi.on("session_before_compact", (_event, ctx) => {
		if (!live() || !isGatewayModel(ctx.model)) return undefined;
		budgetHeld = budget?.lift(ctx) === true;
		return undefined;
	});
	pi.on("session_before_compact", async (event, ctx) => {
		enrichGatewayModels(ctx);
		const model = ctx.model;
		if (!live() || !isGatewayModel(model)) return undefined;
		const self = identity(ctx), producer = live()?.producer;
		if (!self || !producer || !model) {
			if (budgetHeld) { budgetHeld = false; budget?.restore(); }
			return { cancel: true };
		}
		if (!budgetHeld) {
			pi.logger?.warn("Gateway compaction unavailable: live OMP handler budget cannot be lifted");
			return { cancel: true };
		}
		const reason = autoReason;
		autoReason = undefined;
		const kind: CompactionKind = reason === undefined ? "manual" : reason === "overflow" ? "reactive" : "auto";
		const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		const facts = requestFacts(messages, ctx.sessionManager.getBranch(), { ...self, requestClass: "compaction", querySource: "compaction" });
		// Bind the bracket to this exact authenticated dispatch, so a failed
		// close can never classify an unrelated later side turn as compaction.
		const producerSession = `${self.ompSessionId}:side:${randomBytes(16).toString("base64url")}`;
		try {
			await sendBranch(ctx, false);
			compacting = self.ompSessionId;
			await producer.compaction({ ompSessionId: self.ompSessionId, phase: "begin", facts: { ...facts, compactionKind: kind }, dispatchSessionId: producerSession });
			const key = await ctx.modelRegistry.getApiKey(model);
			if (!key) return { cancel: true };
			const tag: NoliRequestTag = { session: self.ompSessionId, ref: null, warm: false };
			// UUID owner (36) + :side: (6) + 128-bit base64url nonce (22) stays
			// within OMP's 64-character cache-ID limit, preserving exact lineage.
			const result = await compact({ ...event.preparation, settings: { ...event.preparation.settings, remoteEnabled: false } }, model, key, event.customInstructions, event.signal, {
				sessionId: producerSession,
				convertToLlm,
				completeImpl: (target, context, options) => completeSimple(target, context, {
					...options,
					headers: { ...options?.headers, "x-noli-producer-session-id": producerSession },
					onPayload: payload => {
						if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Gateway compaction payload");
						return { ...payload, noli_request: tag };
					},
				}),
			});
			return { compaction: result };
		} catch {
			pi.logger?.warn("Gateway compaction failed; the OMP summary was not committed");
			return { cancel: true };
		} finally {
			compacting = undefined;
			try { await producer.compaction({ ompSessionId: self.ompSessionId, phase: "end", facts: null }); }
			// Closing is cleanup, not authority to replace a trusted summary
			// or conceal the original compaction failure.
			catch { pi.logger?.warn("Gateway compaction bracket could not close; the OMP compaction outcome is unchanged"); }
			finally { budgetHeld = false; budget?.restore(); }
		}
	});

	// The only extension-visible trace of an automatic pass; a manual `/compact` emits none.
	pi.on("auto_compaction_start", event => {
		// A history-rewrite retry starts a new tool timing epoch.
		if (event.reason === "overflow") toolEpoch++;
		autoReason = event.reason;
	});
	// A shake pass announces itself but never reaches `session_before_compact`.
	pi.on("auto_compaction_end", () => { autoReason = undefined; });

	// Each user prompt starts a fresh executed-tool timing epoch.
	pi.on("before_agent_start", event => {
		if (event.reason !== "prompt") return undefined;
		toolEpoch++;
		timings.clear();
		return undefined;
	});
	pi.on("tool_execution_start", event => {
		timings.set(event.toolCallId, { start: Date.now(), executed: false, epoch: toolEpoch });
	});
	if (options.toolResults) {
		// Fires only when the wrapper ran `tool.execute`, with or without a thrown error; never for
		// unknown tools, failed validation, denial, an extension block or a pre-start abort.
		pi.on("tool_result", event => {
			const now = Date.now();
			const timing = timings.get(event.toolCallId);
			timings.set(event.toolCallId, { start: timing?.start ?? now, end: now, executed: true, epoch: timing?.epoch ?? toolEpoch });
			return undefined;
		});
	} else {
		// Without `tool_result`, an error result is indistinguishable from a tool that never ran, so it is left out.
		pi.on("tool_execution_end", event => {
			const timing = timings.get(event.toolCallId);
			if (timing) timings.set(event.toolCallId, { ...timing, end: Date.now(), executed: !event.isError });
		});
	}
}


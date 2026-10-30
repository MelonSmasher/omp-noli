import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { ProducerChannel } from "./bridge";
import { EPOCH_ENTRY_TYPE, type EpochData, type FactsIdentity, type ToolTiming, epochEntryId, prevToolDurations, requestFacts, resetEntryIds, wireToolName } from "./claude-facts";
import { isGatewayClaudeModel } from "./gateway";
import { type ForkAttempt, NATIVE_COMPACTION_KEY, type NativeCompactionData, ReactiveLadder, TRUNCATION_NOTE, compactionPrompt, foldReminderBeforeSummary, hasSummaryBlock, isPromptTooLong, nativeCompactionData, nativeSummaries, nativeSummaryKey, nativeSummaryText, nativeSummaryTexts, promptTooLongGap, renderNativeSummaries, toolNamesUsed } from "./native-compaction";
import type { CompactionKind, NoliRequestTag } from "./protocol";
import { SIDE_CHANNEL_REMINDERS, SYSTEM_PREFIXES } from "./system-prefix.generated";

/**
 * Claude Code request correlation on stock OMP (design §3, §5).
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
 * Stock OMP races every extension handler against a fixed 30 s budget and drops a late result
 * (runner.ts:133-168, 1676-1689), which would let stock summarization run after a long fork.
 * While a native compaction runs, the budget of the live runner module is raised to this, and
 * restored when the last compaction in the process ends. Noli's bracket TTL matches it.
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

let budgetHolders = 0;

/**
 * A budget over `runner`, valid only for sessions whose live extension runner is an instance of
 * that module's `ExtensionRunner` (so the module global it sets is the one the host reads).
 */
export function runnerHandlerBudget(runner: RunnerModule, liveRunner: (ctx: ExtensionContext) => unknown): HandlerBudget {
	return {
		lift(ctx) {
			if (!(liveRunner(ctx) instanceof runner.ExtensionRunner)) return false;
			if (budgetHolders++ === 0) runner.testSetExtensionHandlerTimeoutMs(COMPACTION_HANDLER_BUDGET_MS);
			return true;
		},
		restore() {
			if (budgetHolders > 0 && --budgetHolders === 0) runner.testSetExtensionHandlerTimeoutMs(runner.EXTENSION_HANDLER_TIMEOUT_MS);
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
}

/** One native compaction in progress: its summarizer fork and the reactive ladder over its history. */
interface Fork {
	kind: CompactionKind;
	prompt: string;
	gap: number | undefined;
	controller: AbortController;
	/** The history before the side-turn reminder, as the first fork attempt saw it. */
	history?: AgentMessage[];
	ladder?: ReactiveLadder;
	attempt?: ForkAttempt;
	failure?: string;
}

export function installClaudeHooks(pi: ExtensionAPI, dir: string, options: ClaudeHookOptions): void {
	const version: unknown = (pi.pi as { VERSION?: unknown } | undefined)?.VERSION;
	const ompVersion = typeof version === "string" && version ? version : "unknown";
	const sideReminder = SIDE_CHANNEL_REMINDERS[ompVersion];
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
	/** The latest assistant error text, for the prompt-too-long gap that seeds the reactive ladder. */
	let lastError: string | undefined;
	/** The native compaction in progress in this session. */
	let fork: Fork | undefined;
	/** CC `NEn`: the kind the main thread compacted with, consumed by its next main request (`T7o`). */
	let compacted: CompactionKind | undefined;
	let budget: HandlerBudget | undefined;
	let budgetHeld = false;
	const budgetSource = options.handlerBudget ?? sdkHandlerBudget(pi);
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
		const durations = prevToolDurations(messages, branch, timings, toolEpoch, wireNaming(ctx.model));
		const main = ctx.agent.kind === "main";
		const facts = requestFacts(messages, branch, { ...self, requestClass: main ? "main" : "subagent", querySource: main ? "agent" : "task" });
		const contextCompacted = main ? compacted : undefined;
		if (main) compacted = undefined;
		return { ...facts, ...(durations ? { prevToolDurations: durations } : {}), ...(contextCompacted ? { contextCompacted } : {}) };
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

	pi.on("context", async (event, ctx) => {
		warmUntil = 0;
		if (!live() || !isGatewayClaudeModel(ctx.model) || isSideTurn(event.messages)) return;
		const slot: { ref: string | null } = { ref: null };
		pending = slot;
		try {
			await registerFacts(event.messages, ctx, slot);
		} catch (error) {
			// Fail closed: the call is tagged with a null reference and Noli rejects it.
			pi.logger?.warn("Noli request registration failed", { error: error instanceof Error ? error.message : String(error) });
		}
	});

	/** `sve`'s meta row; developer + user attribution keeps it a user row on the wire and meta for T0. */
	const truncationRow = (): AgentMessage => ({ role: "developer", content: TRUNCATION_NOTE, attribution: "user", timestamp: Date.now() }) as AgentMessage;

	/**
	 * One fork attempt: the summarized history plus the side prompt, without OMP's side-turn
	 * reminder, under a compaction bracket whose facts describe exactly the summarized messages.
	 * Any inconsistency aborts the side turn before a request is built (fail closed).
	 */
	const shapeFork = async (original: readonly AgentMessage[], rendered: readonly AgentMessage[], ctx: ExtensionContext, state: Fork): Promise<AgentMessage[]> => {
		const fail = (reason: string): AgentMessage[] => {
			state.failure = reason;
			state.controller.abort(new Error(`Native compaction: ${reason}`));
			return [...rendered];
		};
		const prompt = original.length - 1;
		if (prompt < 1 || !isSideTurn([original[prompt - 1]!])) return fail("unexpected side-turn shape");
		const history = original.slice(0, prompt - 1);
		if (!state.history || !state.ladder) {
			state.history = history;
			state.ladder = new ReactiveLadder(history, state.gap, truncationRow);
		} else if (state.history.length !== history.length) return fail("history changed during compaction");
		const step = state.ladder.next();
		if ("failure" in step) return fail(step.failure);
		state.attempt = step.attempt;
		// The ladder holds the first attempt's clones; map them to this call's messages by position.
		const position = new Map(state.history.map((message, index) => [message, index]));
		const current = (source: readonly AgentMessage[]) => step.attempt.summarize.map(message => {
			const index = position.get(message);
			return index === undefined ? message : source[index]!;
		});
		const self = identity(ctx);
		const producer = live()?.producer;
		if (!self || !producer) return fail("Noli bridge unavailable");
		const branch = ctx.sessionManager.getBranch();
		const facts = requestFacts(current(original), branch, { ...self, requestClass: "compaction", querySource: "compaction" });
		compacting = self.ompSessionId;
		try {
			await producer.compaction({ ompSessionId: self.ompSessionId, phase: "begin", facts: { ...facts, compactionKind: state.kind } });
		} catch (error) {
			return fail(`bracket failed to open (${error instanceof Error ? error.message : String(error)})`);
		}
		return [...current(rendered), rendered[prompt]!];
	};

	// Registered after the facts handler, which must still see OMP's `compactionSummary` messages.
	pi.on("context", async (event, ctx) => {
		if (!live() || !isGatewayClaudeModel(ctx.model)) return undefined;
		const rendered = renderNativeSummaries(event.messages, nativeSummaries(ctx.sessionManager.getBranch()));
		const state = fork;
		const last = event.messages.at(-1);
		const forkTurn = state !== undefined && last?.role === "user" && Array.isArray(last.content)
			&& last.content[0]?.type === "text" && last.content[0].text === state.prompt && isSideTurn(event.messages);
		const messages = forkTurn ? await shapeFork(event.messages, rendered, ctx, state) : rendered;
		return messages === event.messages ? undefined : { messages };
	});

	// Synchronous on purpose: the runner's timeout and fail-open paths cannot drop a value returned without awaiting.
	pi.on("before_provider_request", (event, ctx) => {
		if (!live() || !isGatewayClaudeModel(ctx.model)) return undefined;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const warm = Date.now() < warmUntil;
		const tag: NoliRequestTag = { session: ctx.sessionManager.getSessionId(), ref: warm ? null : pending?.ref ?? null, warm };
		const messages = "messages" in payload ? foldReminderBeforeSummary(payload.messages, nativeSummaryTexts(ctx.sessionManager.getBranch())) : undefined;
		return { ...payload, ...(messages ? { messages } : {}), noli_request: tag };
	});

	pi.on("cache_warming_decision", event => {
		if (event.action === "warm") warmUntil = Date.now() + WARM_WINDOW_MS;
		return undefined;
	});

	/**
	 * The committed entry: `summary` is the exact summary row text (`nee()` plus `kcn` when a tail
	 * is kept), and the kept tail starts at the first kept message's entry. `undefined` when that
	 * entry cannot be found (fail closed).
	 */
	const nativeResult = (event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: Fork, attempt: ForkAttempt, history: readonly AgentMessage[], reply: string) => {
		const branch = ctx.sessionManager.getBranch();
		const first = attempt.keep[0];
		const firstKeptEntryId = first === undefined ? "" : branch.findLast((entry: SessionEntry) => entry.type === "message"
			&& entry.message.role === first.role && entry.message.timestamp === first.timestamp)?.id;
		if (firstKeptEntryId === undefined) return undefined;
		const natives = nativeSummaries(branch);
		const earlier = history.flatMap(message => message.role === "compactionSummary"
			? natives.get(nativeSummaryKey(message.timestamp, message.summary))?.toolNames ?? [] : []);
		const naming = wireNaming(ctx.model);
		const toolNames = toolNamesUsed(history, name => wireToolName(name, naming), earlier);
		// No transcript sentence: the variant native renders when `cve()` yields no path (diskless
		// `J()`, `Xa()` or `compactTranscriptUnavailable`, 5hada5qy:2567069). OMP's session file
		// path would be a non-native string, and a CC-shaped path would not exist.
		const summary = nativeSummaryText({ reply, toolNames, headTruncated: attempt.headTruncated, keptTail: attempt.keep.length > 0 });
		const data: NativeCompactionData = { v: 1, kind: state.kind, toolNames };
		return { summary, firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, preserveData: { [NATIVE_COMPACTION_KEY]: data } };
	};

	/**
	 * One native compaction (CC `Hfr` through `ive`): summarizer forks through OMP's own side-turn
	 * path until one returns a summary, then the entry OMP commits as-is. Every failure cancels:
	 * OMP's own summarizer never reaches the Gateway for a Claude model.
	 */
	const compactNatively = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext, reason: string | undefined): Promise<SessionBeforeCompactResult> => {
		// CC 2.1.309 never compacts proactively under the default window source (`Nmr`,
		// 5hada5qy:2568633): it sends the request and compacts on prompt-too-long instead.
		if (reason === "threshold" || reason === "idle") {
			pi.logger?.debug("Native compaction declined: Claude Code compacts only on prompt-too-long or /compact", { reason, agent: ctx.agent.kind });
			return { cancel: true };
		}
		const run = ctx.runEphemeralTurn;
		if (!budgetHeld || !run) {
			pi.logger?.warn("Native compaction unavailable: the handler budget or side turns cannot be used");
			return { cancel: true };
		}
		const kind: CompactionKind = reason === undefined ? "manual" : "reactive";
		// `/compact` trims its arguments before `eve` splices them (fzcbqdwj:16225).
		const instructions = kind === "manual" ? event.customInstructions?.trim() : undefined;
		const state: Fork = {
			kind, prompt: compactionPrompt(instructions), controller: new AbortController(),
			gap: reason === "overflow" && lastError !== undefined ? promptTooLongGap(lastError) : undefined,
		};
		fork = state;
		const signal = AbortSignal.any([event.signal, state.controller.signal]);
		for (;;) {
			let reply: string | undefined;
			let error: string | undefined;
			try {
				const result = await run({ promptText: state.prompt, signal, dedupeReply: false, replyMaxBytes: Number.POSITIVE_INFINITY });
				// `YTe`: the first text block of the reply, trimmed.
				const text = result.assistantMessage.content.find(block => block.type === "text");
				reply = text?.type === "text" ? text.text.trim() : undefined;
			} catch (thrown) {
				error = thrown instanceof Error ? thrown.message : String(thrown);
			}
			const { attempt, ladder, history } = state;
			if (signal.aborted || !attempt || !ladder || !history) {
				pi.logger?.warn("Native compaction stopped", { reason: state.failure ?? error ?? "aborted" });
				return { cancel: true };
			}
			if (attempt.openingRoundAlone && !(reply && hasSummaryBlock(reply))) {
				ladder.openingRoundFailed();
				continue;
			}
			if (reply) {
				const compaction = nativeResult(event, ctx, state, attempt, history, reply);
				if (compaction) return { compaction };
				pi.logger?.warn("Native compaction failed: the kept tail has no session entry");
				return { cancel: true };
			}
			if (error !== undefined && isPromptTooLong(error) && ladder.promptTooLong(promptTooLongGap(error))) continue;
			pi.logger?.warn("Native compaction failed", { error: error ?? "empty summary" });
			return { cancel: true };
		}
	};

	pi.on("session_before_compact", async (_event, ctx) => {
		if (!live() || !isGatewayClaudeModel(ctx.model)) return undefined;
		// Lifted here so the next handler, and the context handlers of its forks, run under it.
		budget = await budgetSource;
		budgetHeld = budget?.lift(ctx) === true;
		return undefined;
	});
	// Registering this also turns stock speculative compaction off (session-maintenance.ts:2232, 2325, 2560).
	pi.on("session_before_compact", async (event, ctx) => {
		const reason = autoReason;
		autoReason = undefined;
		if (!live() || !isGatewayClaudeModel(ctx.model)) return undefined;
		try {
			return await compactNatively(event, ctx, reason);
		} finally {
			fork = undefined;
			endCompaction();
			if (budgetHeld) {
				budgetHeld = false;
				budget?.restore();
			}
		}
	});
	// The only extension-visible trace of an automatic pass; a manual `/compact` emits none.
	pi.on("auto_compaction_start", event => {
		// Claude Code drops the previous batch on a prompt-too-long retry, keeps it for proactive compaction.
		if (event.reason === "overflow") toolEpoch++;
		autoReason = event.reason;
	});
	// A shake pass announces itself but never reaches `session_before_compact`.
	pi.on("auto_compaction_end", () => { autoReason = undefined; });
	pi.on("message_end", event => {
		const message = event.message as { role: string; stopReason?: string; errorMessage?: string };
		if (message.role === "assistant") lastError = message.stopReason === "error" ? message.errorMessage : undefined;
	});
	pi.on("session_compact", (event, ctx) => {
		const data = nativeCompactionData(event.compactionEntry.preserveData);
		// The one-shot `x-cc-context-compacted` is armed for the main thread only (`vv`, 5hada5qy:2843681).
		if (data && ctx.agent.kind === "main") compacted = data.kind;
	});

	// Claude Code starts a fresh tool-duration list for every new prompt (design spec §1.4).
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

/** Stock OMP's tool-name encoding inputs for the model a request is built for. */
function wireNaming(model: ExtensionContext["model"]): { escape: boolean; oauth: boolean } {
	return {
		escape: (model?.compat as { escapeBuiltinToolNames?: unknown } | undefined)?.escapeBuiltinToolNames === true,
		// The Gateway key is a base64url token, never `sk-ant-oat`, so the key-based fallback is false.
		oauth: (model as { isOAuth?: unknown } | undefined)?.isOAuth === true,
	};
}

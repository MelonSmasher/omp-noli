import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProducerChannel } from "./bridge";
import { EPOCH_ENTRY_TYPE, type EpochData, type FactsIdentity, type ToolTiming, compactionSource, epochEntryId, prevToolDurations, requestFacts, resetEntryIds } from "./claude-facts";
import { isGatewayClaudeModel } from "./gateway";
import type { NoliRequestTag } from "./protocol";
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

export interface ClaudeHookOptions {
	/**
	 * Observe `tool_result` to time and include only tools that actually executed. Set it only
	 * where another omp-noli handler already observes `tool_result` (the root's thread control):
	 * a first `tool_result` handler makes stock OMP skip speculative execution (speculation/host.ts:76-83).
	 */
	toolResults: boolean;
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

	pi.on("context", async (event, ctx) => {
		warmUntil = 0;
		if (!live() || !isGatewayClaudeModel(ctx.model) || isSideTurn(event.messages)) return;
		const slot: { ref: string | null } = { ref: null };
		pending = slot;
		try {
			ensureEpoch(ctx);
			if (announced !== ctx.sessionManager.getSessionId() && !announce(ctx)) return;
			const self = identity(ctx);
			const producer = live()?.producer;
			if (!self || !producer) return;
			const branch = ctx.sessionManager.getBranch();
			const durations = prevToolDurations(event.messages, branch, timings, toolEpoch, {
				escape: (ctx.model?.compat as { escapeBuiltinToolNames?: unknown } | undefined)?.escapeBuiltinToolNames === true,
				// The Gateway key is a base64url token, never `sk-ant-oat`, so the key-based fallback is false.
				oauth: (ctx.model as { isOAuth?: unknown } | undefined)?.isOAuth === true,
			});
			const facts = {
				...requestFacts(event.messages, branch, {
					...self, requestClass: ctx.agent.kind === "main" ? "main" : "subagent", querySource: ctx.agent.kind === "main" ? "agent" : "task",
				}),
				...(durations ? { prevToolDurations: durations } : {}),
			};
			// Timings of earlier resets are never emitted again; the cap bounds a session that never resets.
			for (const [id, timing] of timings) if (timing.epoch !== toolEpoch || timings.size > 1024) timings.delete(id);
			await sendBranch(ctx, false);
			const ref = await producer.register(self.ompSessionId, facts);
			if (pending === slot) slot.ref = ref;
		} catch (error) {
			// Fail closed: the call is tagged with a null reference and Noli rejects it.
			pi.logger?.warn("Noli request registration failed", { error: error instanceof Error ? error.message : String(error) });
		}
	});

	// Synchronous on purpose: the runner's timeout and fail-open paths cannot drop a value returned without awaiting.
	pi.on("before_provider_request", (event, ctx) => {
		if (!live() || !isGatewayClaudeModel(ctx.model)) return undefined;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const warm = Date.now() < warmUntil;
		const tag: NoliRequestTag = { session: ctx.sessionManager.getSessionId(), ref: warm ? null : pending?.ref ?? null, warm };
		return { ...payload, noli_request: tag };
	});

	pi.on("cache_warming_decision", event => {
		if (event.action === "warm") warmUntil = Date.now() + WARM_WINDOW_MS;
		return undefined;
	});

	// Not `session_before_compact`: registering it makes stock OMP skip speculative compaction
	// (session-maintenance.ts:2162,2255,2490). `auto_compaction_start` is awaited before the
	// summarization request (session-maintenance.ts:1767,4953) and changes nothing when observed.
	pi.on("auto_compaction_start", async (event, ctx) => {
		// Claude Code drops the previous batch on a prompt-too-long retry, keeps it for proactive compaction.
		if (event.reason === "overflow") toolEpoch++;
		const producer = live()?.producer;
		const self = identity(ctx);
		// Shake and snapcompact are local rewrites with no provider request.
		if (!producer || !self || event.action === "shake" || event.action === "snapcompact") return;
		endCompaction();
		try {
			const branch = ctx.sessionManager.getBranch();
			const facts = requestFacts(compactionSource(branch), branch, { ...self, requestClass: "compaction", querySource: "compaction" });
			compacting = self.ompSessionId;
			await producer.compaction({ ompSessionId: self.ompSessionId, phase: "begin", facts });
		} catch (error) {
			pi.logger?.warn("Noli compaction bracket failed to open", { error: error instanceof Error ? error.message : String(error) });
		}
	});
	pi.on("session_compact", endCompaction);
	pi.on("auto_compaction_end", endCompaction);
	pi.on("agent_start", endCompaction);

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

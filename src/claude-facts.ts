import { createHash } from "node:crypto";
import type { ContextEvent, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { PrevToolDuration, PromptPosition, RequestFacts } from "./protocol";

/**
 * Claude Code producer facts recomputed from stock OMP session state.
 *
 * This ports the qualified 8.1 delivery-time stamping (wt `claude-code-producer.ts`
 * `stampClaudeCodeMessage`/`snapshotClaudeCodeRequest` and `session-manager.ts`
 * `#claudeSourceAt`) to a pure walk over the persisted branch path plus the
 * not-yet-persisted tail of a `context` event. Nothing is stored per message:
 * ids derive from the message itself, so a restart recomputes the same facts.
 */

type AgentMessage = ContextEvent["messages"][number];

/** One custom entry per session marks where recomputed facts start; older history stays unknown. */
export const EPOCH_ENTRY_TYPE = "noli-facts-epoch";
export interface EpochData { ompVersion: string }

const LAUNCH_COMPLETION = "launch-completion";
const IRC_INCOMING = "irc:incoming";
const MAX_POSITION = 10_000_000;

type OriginKind = "human" | "auto-continuation" | "task-notification" | "coordinator" | "peer" | "unclassified";

/** Delivery facts of one source input (wt `ClaudeCodeMessageFacts`, reachable fields only). */
export interface SourceFacts {
	readonly sourceMessageId: string;
	readonly isMeta: boolean;
	readonly isCompactSummary?: boolean;
	readonly origin?: OriginKind;
	readonly promptSource?: "sdk";
	readonly promptId?: string;
	readonly turnOrigin?: string;
	readonly turnPosition?: PromptPosition;
	readonly summarizedTurnPromptUuids?: readonly string[];
}

/** History recorded before the epoch: present, but with no provable facts. */
const UNKNOWN: unique symbol = Symbol("unknown history");
type Known = SourceFacts | typeof UNKNOWN;

/** The source-user view of a message: wt `isSourceUser` roles. */
interface SourceItem {
	role: string;
	attribution?: string;
	synthetic?: boolean;
	steering?: boolean;
	customType?: string;
	details?: unknown;
	/** First text for T0, and its block index (null for string content and summaries). */
	text: string;
	textBlockIndex: number | null;
	key: string;
}

const SOURCE_ROLES: Record<string, true> = { user: true, developer: true, custom: true, hookMessage: true, compactionSummary: true, branchSummary: true };

/** UUIDv4-format identifier derived from stable message identity. */
export function derivedUuid(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part).update("\0");
	const bytes = hash.digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Claude Code's T0 sample: UTF-16 code units 4, 7 and 20, "0" when missing, lone surrogates as U+FFFD. */
export function firstInputSample(text: string): string {
	return [4, 7, 20].map(index => text[index] ?? "0").join("").toWellFormed();
}

type Content = string | readonly { type: string; text?: string }[] | undefined;

interface ContentText {
	text: string;
	textBlockIndex: number | null;
	digestText: string;
}

function textOf(content: Content): ContentText {
	if (typeof content === "string") return { text: content, textBlockIndex: null, digestText: content };
	const blocks = content ?? [];
	const index = blocks.findIndex(block => block.type === "text");
	const first = index >= 0 ? blocks[index] : undefined;
	// Identity covers every block's text and kind; image bytes are left out on purpose.
	const digestText = blocks.map(block => block.type === "text" ? `t${block.text ?? ""}` : `x${block.type}`).join("\0");
	return { text: first?.text ?? "", textBlockIndex: first ? index : null, digestText };
}

function identityKey(role: string, timestamp: number, extra: string): string {
	return `${role}\0${timestamp}\0${createHash("sha256").update(extra).digest("hex")}`;
}

interface MessageLike {
	role: string;
	timestamp?: number;
	content?: Content;
	summary?: string;
	attribution?: string;
	synthetic?: boolean;
	steering?: boolean;
	customType?: string;
	details?: unknown;
	stopReason?: string;
	responseId?: string;
	toolCallId?: string;
}

function sourceItem(message: MessageLike): SourceItem | undefined {
	if (!Object.hasOwn(SOURCE_ROLES, message.role)) return undefined;
	const timestamp = message.timestamp ?? 0;
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		const summary = message.summary ?? "";
		return { role: message.role, text: summary, textBlockIndex: null, key: identityKey(message.role, timestamp, summary) };
	}
	const { text, textBlockIndex, digestText } = textOf(message.content);
	// Some stock paths persist custom messages with their append time, not the message's own.
	const custom = message.role === "custom" || message.role === "hookMessage";
	return {
		role: message.role, attribution: message.attribution, synthetic: message.synthetic, steering: message.steering,
		customType: message.customType, details: message.details, text, textBlockIndex,
		key: custom ? identityKey(message.role, -1, `${message.customType ?? ""}\0${digestText}`) : identityKey(message.role, timestamp, digestText),
	};
}

/** Persistence identity for any message role, used to find the unpersisted tail. */
function messageKey(message: MessageLike): string {
	const source = sourceItem(message);
	if (source) return source.key;
	return identityKey(message.role, message.timestamp ?? 0, message.responseId ?? message.toolCallId ?? "");
}

function entryMessage(entry: SessionEntry): MessageLike | undefined {
	switch (entry.type) {
		case "message": return entry.message as MessageLike;
		case "custom_message": return { role: "custom", customType: entry.customType, content: entry.content, details: entry.details, attribution: entry.attribution, timestamp: Date.parse(entry.timestamp) };
		case "compaction": return { role: "compactionSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) };
		case "branch_summary": return { role: "branchSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) };
		default: return undefined;
	}
}

/** Origin inputs mapped from observable stock OMP fields (design §5.3 table). */
function observedSource(item: SourceItem): { origin?: OriginKind; isMeta?: false; promptSource?: "sdk" } | undefined {
	if (item.role === "developer" && item.synthetic && item.attribution === "agent") return { origin: "auto-continuation", isMeta: false };
	if (item.role === "custom" && item.customType === IRC_INCOMING) {
		const details = item.details && typeof item.details === "object" ? item.details as Record<string, unknown> : undefined;
		return { origin: details?.wakeRelay === true ? "task-notification" : details?.fromParent === true ? "coordinator" : "peer", isMeta: false };
	}
	if (item.role === "custom" && item.customType === LAUNCH_COMPLETION) return { origin: "task-notification", isMeta: false };
	if (item.role === "user" && item.steering && item.attribution === "agent") return { origin: "coordinator", isMeta: false };
	if (item.role === "user" && item.attribution !== "user" && !item.synthetic) return { promptSource: "sdk" };
	return undefined;
}

/** wt `classifyClaudeCodeOrigin`, limited to the kinds stock OMP state can produce. */
export function classifyOrigin(facts: Pick<SourceFacts, "origin" | "isMeta" | "promptSource">): string {
	switch (facts.origin) {
		case "human": return "human";
		case "auto-continuation": return "auto_continuation";
		case "task-notification": return "task_notification";
		case "coordinator":
		case "peer": return "peer";
		case "unclassified": return "host_synthetic";
	}
	if (facts.isMeta) return "system";
	return facts.promptSource === "sdk" ? "sdk" : "unknown";
}

function isPosition(value: PromptPosition | undefined): value is PromptPosition {
	return !!value && Number.isSafeInteger(value.promptIndex) && Number.isSafeInteger(value.turnIndex)
		&& value.promptIndex >= 0 && value.promptIndex <= value.turnIndex && value.turnIndex >= 1 && value.turnIndex <= MAX_POSITION;
}

function isPromptBearing(facts: SourceFacts): boolean {
	return !!(facts.promptId || facts.turnOrigin) || !facts.isMeta;
}

/** Whether a stamped input becomes the source the next delivery positions from. */
function qualifies(facts: SourceFacts): boolean {
	return isPromptBearing(facts) || isPosition(facts.turnPosition);
}

/** wt `stampClaudeCodeMessage` with a one-element history: the nearest qualifying source. */
function stamp(item: SourceItem, previous: Known | null): SourceFacts {
	const sourceMessageId = derivedUuid("omp-noli/source", item.key);
	const human = item.attribution === "user";
	const observed = observedSource(item);
	const facts: { -readonly [K in keyof SourceFacts]: SourceFacts[K] } = {
		sourceMessageId,
		isMeta: item.role === "developer" || item.role === "hookMessage" || (item.role === "custom" && !human),
		...(human ? { origin: "human" as const, promptId: sourceMessageId } : {}),
		...(item.synthetic ? { origin: "unclassified" as const } : {}),
		...observed,
	};
	if (facts.promptSource === "sdk" && !facts.isMeta) facts.promptId ??= sourceMessageId;
	if (!isPromptBearing(facts) && !observed?.origin) return facts;
	facts.turnOrigin ??= classifyOrigin(facts);
	// Unknown history has a source without a position, so no absolute counter is invented.
	const prior = previous === UNKNOWN ? undefined : previous?.turnPosition;
	if (previous === null || (isPosition(prior) && prior.turnIndex < MAX_POSITION)) {
		facts.turnPosition = { promptIndex: (prior?.promptIndex ?? 0) + (facts.turnOrigin === "human" ? 1 : 0), turnIndex: (prior?.turnIndex ?? 0) + 1 };
	}
	return facts;
}

/** Compaction and branch summaries inherit the previous source and the prompts they summarize. */
function summaryFacts(entry: SessionEntry, previous: Known | null): SourceFacts {
	const source = previous === UNKNOWN ? undefined : previous ?? undefined;
	const summarized = source?.summarizedTurnPromptUuids
		?? (source?.promptId && !source.isMeta ? [source.sourceMessageId] : undefined);
	return {
		...source,
		sourceMessageId: derivedUuid("omp-noli/summary", entry.id),
		isMeta: false,
		isCompactSummary: entry.type === "compaction",
		summarizedTurnPromptUuids: summarized,
	};
}

/** Running walk state after an entry. Entries are immutable nodes, so it depends only on the path. */
interface WalkState {
	readonly covered: boolean;
	readonly source: Known | null;
	readonly sawAssistant: boolean;
	readonly facts?: Known;
	readonly key?: string;
}

const INITIAL: WalkState = { covered: false, source: null, sawAssistant: false };
const memo = new WeakMap<SessionEntry, WalkState>();

function previousOf(state: WalkState): Known | null {
	return state.source ?? (state.sawAssistant ? UNKNOWN : null);
}

function advance(state: WalkState, entry: SessionEntry): WalkState {
	const base: WalkState = { covered: state.covered, source: state.source, sawAssistant: state.sawAssistant };
	if (entry.type === "reset_boundary") return { ...base, source: null, sawAssistant: false };
	if (entry.type === "custom" && entry.customType === EPOCH_ENTRY_TYPE) return { ...base, covered: true };
	const message = entryMessage(entry);
	if (!message) return base;
	const key = messageKey(message);
	if (message.role === "assistant") return { ...base, key, sawAssistant: base.sawAssistant || message.stopReason !== "error" };
	const item = sourceItem(message);
	if (!item) return { ...base, key };
	const facts: Known = !state.covered ? UNKNOWN
		: entry.type === "compaction" || entry.type === "branch_summary" ? summaryFacts(entry, previousOf(state))
			: stamp(item, previousOf(state));
	return { ...base, key, facts, source: facts === UNKNOWN || qualifies(facts) ? facts : base.source };
}

/** Walk the root-to-leaf path, reusing memoized states of shared prefixes. */
function walk(branch: readonly SessionEntry[]): WalkState[] {
	const states: WalkState[] = new Array(branch.length);
	let start = branch.length;
	while (start > 0 && !memo.has(branch[start - 1]!)) start--;
	for (let index = 0; index < start; index++) states[index] = memo.get(branch[index]!)!;
	let state = start > 0 ? states[start - 1]! : INITIAL;
	for (let index = start; index < branch.length; index++) {
		state = advance(state, branch[index]!);
		memo.set(branch[index]!, state);
		states[index] = state;
	}
	return states;
}

/** The first facts epoch on the path; entries before it are unknown history. */
export function epochEntryId(branch: readonly SessionEntry[]): string | null {
	return branch.find(entry => entry.type === "custom" && entry.customType === EPOCH_ENTRY_TYPE)?.id ?? null;
}

/** `/clear` boundaries on the path; each starts a new Claude Code conversation. */
export function resetEntryIds(branch: readonly SessionEntry[]): string[] {
	return branch.filter(entry => entry.type === "reset_boundary").map(entry => entry.id);
}

/** Session state with no recorded conversation yet: an epoch written now covers all of it. */
export function hasConversation(branch: readonly SessionEntry[]): boolean {
	return branch.some(entry => entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary");
}

/**
 * The history a compaction starting now summarizes: entries since the latest
 * compaction (its summary first) or `/clear`. Stock auto compaction announces
 * itself without a preparation, so the source view comes from the branch.
 */
export function compactionSource(branch: readonly SessionEntry[]): AgentMessage[] {
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const type = branch[index]!.type;
		if (type === "compaction") { start = index; break; }
		if (type === "reset_boundary") { start = index + 1; break; }
	}
	const messages: MessageLike[] = [];
	for (const entry of branch.slice(start)) {
		const message = entryMessage(entry);
		if (message) messages.push(message);
	}
	return messages as unknown as AgentMessage[];
}

export interface FactsIdentity {
	ompSessionId: string;
	agentId: string;
	parentOmpSessionId: string | null;
	requestClass: RequestFacts["requestClass"];
	querySource: string;
}

interface Stamped { item: SourceItem; facts: Known }

/**
 * Facts for one request whose source view is `messages` (a `context` event's
 * pre-conversion `AgentMessage[]`, or a compaction preparation).
 *
 * Messages up to the last persisted one take the branch walk's facts; later ones
 * are the tail not yet persisted (the delivered prompt, steering) and continue the
 * walk, exactly as the 8.1 tree stamped them at delivery. A message that is neither
 * persisted nor in the tail was injected for this call only and is not a source.
 */
export function requestFacts(messages: readonly AgentMessage[], branch: readonly SessionEntry[], identity: FactsIdentity): RequestFacts {
	const states = walk(branch);
	const persisted = new Set<string>();
	const byKey = new Map<string, Known[]>();
	for (const state of states) {
		if (state.key === undefined) continue;
		persisted.add(state.key);
		if (state.facts === undefined) continue;
		const list = byKey.get(state.key);
		if (list) list.push(state.facts);
		else byKey.set(state.key, [state.facts]);
	}
	const views = messages as readonly MessageLike[];
	const items = views.map(sourceItem);
	let boundary = -1;
	for (let index = views.length - 1; index >= 0; index--) {
		if (persisted.has(items[index]?.key ?? messageKey(views[index]!))) { boundary = index; break; }
	}
	// The source view is a suffix of the branch (compaction drops the head), so align from the end.
	const assigned: (Known | undefined)[] = new Array(views.length);
	for (let index = boundary; index >= 0; index--) {
		const item = items[index];
		if (item) assigned[index] = byKey.get(item.key)?.pop();
	}
	let tail = states.at(-1) ?? INITIAL;
	const fresh = !tail.covered && !hasConversation(branch);
	let previousMessageId: string | undefined;
	for (let index = 0; index < views.length; index++) {
		const message = views[index]!;
		if (message.role === "assistant" && message.stopReason !== "error" && typeof message.responseId === "string") previousMessageId = message.responseId;
		if (index <= boundary) continue;
		if (message.role === "assistant") tail = { ...tail, sawAssistant: tail.sawAssistant || message.stopReason !== "error" };
		const item = items[index];
		if (!item || item.role === "compactionSummary" || item.role === "branchSummary") continue;
		const facts = tail.covered || fresh ? stamp(item, previousOf(tail)) : UNKNOWN;
		assigned[index] = facts;
		tail = { ...tail, source: facts === UNKNOWN || qualifies(facts) ? facts : tail.source };
	}
	const stamped: Stamped[] = [];
	assigned.forEach((facts, index) => { if (facts !== undefined) stamped.push({ item: items[index]!, facts }); });

	let firstEligible: RequestFacts["firstEligible"] = { messageId: null, textBlockIndex: null, sample: firstInputSample("") };
	for (const { item, facts } of stamped) {
		if (facts === UNKNOWN) { firstEligible = null; break; }
		if (facts.isMeta) continue;
		firstEligible = { messageId: facts.sourceMessageId, textBlockIndex: item.textBlockIndex, sample: firstInputSample(item.text) };
		break;
	}

	let prompt: RequestFacts["prompt"] = { id: null, origin: null, position: null };
	for (let index = stamped.length - 1; index >= 0; index--) {
		const facts = stamped[index]!.facts;
		if (facts === UNKNOWN) break;
		if (!isPromptBearing(facts)) continue;
		let position = isPosition(facts.turnPosition) ? { ...facts.turnPosition } : null;
		if (position) {
			for (let prior = index - 1; prior >= 0; prior--) {
				const earlier = stamped[prior]!.facts;
				if (earlier === UNKNOWN || !isPosition(earlier.turnPosition)) continue;
				if (earlier.turnPosition.turnIndex !== position.turnIndex) break;
				position = { promptIndex: Math.max(position.promptIndex, earlier.turnPosition.promptIndex), turnIndex: position.turnIndex };
			}
		}
		prompt = { id: facts.promptId ?? null, origin: facts.turnOrigin ?? classifyOrigin(facts), position };
		break;
	}

	return {
		version: 1,
		producerSessionId: identity.ompSessionId,
		branchAnchor: branch.at(-1)?.id ?? null,
		historyRevision: branch.length,
		producerAgentId: identity.agentId,
		parentProducerSessionId: identity.parentOmpSessionId,
		requestClass: identity.requestClass,
		querySource: identity.querySource,
		...(previousMessageId && /^msg_[A-Za-z0-9_-]{1,508}$/.test(previousMessageId) ? { previousMessageId } : {}),
		firstEligible,
		prompt,
	};
}

/** Facts per entry on the path, for tests and diagnostics. Unknown history maps to null. */
export function branchFacts(branch: readonly SessionEntry[]): Map<string, SourceFacts | null> {
	const states = walk(branch);
	const result = new Map<string, SourceFacts | null>();
	branch.forEach((entry, index) => {
		const facts = states[index]!.facts;
		if (facts !== undefined) result.set(entry.id, facts === UNKNOWN ? null : facts);
	});
	return result;
}

/**
 * One tool call's observed timing in this session instance. `start` is the stock
 * `tool_execution_start` delivery time, `end` the `tool_result` (or, without one,
 * `tool_execution_end`) delivery time, and `executed` whether the tool actually ran.
 * `epoch` is the reset generation (new prompt, overflow compaction) it was seen in.
 */
export interface ToolTiming { start: number; end?: number; executed: boolean; epoch: number }

export const MAX_PREV_TOOL_DURATIONS = 32;
/** Stock `AgentSession` persists one of these per started tool (session/exit-diagnostics.ts). */
const TOOL_START_ENTRY_TYPE = "tool_execution_start";

/** Anthropic server tool names stock never prefixes under OAuth shaping (ai/src/providers/anthropic-identity.ts:117-122). */
const ANTHROPIC_BUILTIN_TOOL_NAMES: Record<string, true> = { web_search: true, code_execution: true, text_editor: true, computer: true };

/** The inputs stock uses to encode tool names for one request. */
export interface WireNaming {
	/** `model.compat.escapeBuiltinToolNames`. */
	escape: boolean;
	/** Stock's effective OAuth shaping: `model.isOAuth ?? apiKey.includes("sk-ant-oat")` (ai/src/stream.ts:937, anthropic.ts:4382, catalog/src/utils.ts:43). */
	oauth: boolean;
}

/**
 * The tool name as stock OMP advertises it on an Anthropic Messages request. Port of the
 * unexported `encodeAnthropicToolName` (ai/src/providers/anthropic.ts:979-988) and
 * `applyClaudeToolPrefix` (anthropic-identity.ts:125-128) with `claudeToolPrefix = "_"`
 * (claude-code-fingerprint.ts:70). The umans web-search exemption (anthropic.ts:975-977)
 * needs an umans host and cannot apply to the loopback Gateway.
 */
export function wireToolName(name: string, naming: WireNaming): string {
	if (naming.escape) return `_${name}`;
	if (naming.oauth && !Object.hasOwn(ANTHROPIC_BUILTIN_TOOL_NAMES, name.toLowerCase())) return `_${name}`;
	return name;
}

/**
 * Claude Code `prevToolDurations` for the request whose source view is `messages`:
 * the executed tool calls of the last non-error assistant message, in completion
 * order (ties in tool_use order), first 32. A start persisted on the branch wins over
 * the in-memory delivery time. Names are the wire names (`wireToolName`). Undefined when that
 * batch has no executed, timed tool.
 */
export function prevToolDurations(messages: readonly AgentMessage[], branch: readonly SessionEntry[], timings: ReadonlyMap<string, ToolTiming>, epoch: number, naming: WireNaming = { escape: false, oauth: false }): PrevToolDuration[] | undefined {
	let calls: { id: string; name: string; index: number; timing: ToolTiming & { end: number } }[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as MessageLike & { content?: unknown };
		if (message.role !== "assistant" || message.stopReason === "error") continue;
		const blocks = Array.isArray(message.content) ? message.content as { type?: unknown; id?: unknown; name?: unknown }[] : [];
		blocks.forEach((block, position) => {
			if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") return;
			const timing = timings.get(block.id);
			if (!timing?.executed || timing.end === undefined || timing.epoch !== epoch) return;
			calls.push({ id: block.id, name: block.name, index: position, timing: timing as ToolTiming & { end: number } });
		});
		break;
	}
	if (calls.length === 0) return undefined;
	const wanted = new Set(calls.map(call => call.id));
	const persisted = new Map<string, number>();
	for (let index = branch.length - 1; index >= 0 && persisted.size < wanted.size; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== TOOL_START_ENTRY_TYPE) continue;
		const data = entry.data as { toolCallId?: unknown; startedAt?: unknown } | undefined;
		if (typeof data?.toolCallId !== "string" || !wanted.has(data.toolCallId) || persisted.has(data.toolCallId)) continue;
		const startedAt = typeof data.startedAt === "string" ? Date.parse(data.startedAt) : Number.NaN;
		if (Number.isFinite(startedAt)) persisted.set(data.toolCallId, startedAt);
	}
	calls = calls.sort((left, right) => left.timing.end - right.timing.end || left.index - right.index).slice(0, MAX_PREV_TOOL_DURATIONS);
	return calls.map(call => ({ toolName: wireToolName(call.name, naming), durationMs: Math.max(0, Math.round(call.timing.end - (persisted.get(call.id) ?? call.timing.start))) }));
}

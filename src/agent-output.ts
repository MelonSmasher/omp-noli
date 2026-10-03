import type { AgentRef } from "@oh-my-pi/pi-coding-agent";
import { BridgeError } from "./bridge";
import type { AgentOutputParams, AgentOutputResult } from "./protocol";

const DEFAULT_LIMIT = 100;
const MAX_LINES = 500;
/** UTF-8 rendered text only; span metadata has the bridge's separate frame bound. */
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const TRUNCATION = "[… line truncated …]";

type RecordValue = Record<string, unknown>;
type ReadChild = <T>(ref: AgentRef, loader: (file: string) => Promise<T>) => Promise<T>;
type SpanIdentity = Pick<AgentOutputResult["spans"][number], "id" | "role" | "tool" | "created_ms">;
interface Segment extends SpanIdentity { text: string; }
interface Line { source: Segment; start: number; end: number; segment: number; }
interface MessageIdentity { id: string; timestamp: number | null; message: RecordValue; }

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" ? value as RecordValue : undefined;
}

function nativeId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return null;
}

function unavailable(detail: string): never {
	throw new BridgeError("capability_unavailable", detail, { capability: "agents.output", reason: "export_missing" });
}

/** Walk the same last-entry/parent path the native read-only loader uses. */
function messageIdentities(entries: unknown[]): Map<string, MessageIdentity[]> {
	const byId = new Map<string, RecordValue>();
	let leaf: RecordValue | undefined;
	for (const value of entries) {
		const entry = record(value);
		const id = nativeId(entry?.id);
		if (entry && entry.type !== "session" && id) {
			byId.set(id, entry);
			leaf = entry;
		}
	}
	const path: RecordValue[] = [];
	const visited = new Set<string>();
	while (leaf) {
		const id = nativeId(leaf.id)!;
		if (visited.has(id)) break;
		visited.add(id);
		path.push(leaf);
		leaf = byId.get(nativeId(leaf.parentId) ?? "");
	}
	path.reverse();
	const identities = new Map<string, MessageIdentity[]>();
	for (const entry of path) {
		const message = entry.type === "message" ? record(entry.message) :
			entry.type === "custom_message" ? { role: "custom", timestamp: entry.timestamp, content: entry.content, display: entry.display, customType: entry.customType } :
			entry.type === "compaction" ? { role: "compactionSummary", timestamp: entry.timestamp, summary: entry.summary } :
			entry.type === "branch_summary" ? { role: "branchSummary", timestamp: entry.timestamp, summary: entry.summary } : undefined;
		if (!message || typeof message.role !== "string") continue;
		const key = messageKey(message);
		const group = identities.get(key) ?? [];
		group.push({ id: entry.id as string, timestamp: timestamp(entry.timestamp), message });
		identities.set(key, group);
	}
	return identities;
}

function messageKey(message: RecordValue): string {
	return JSON.stringify([message.role, timestamp(message.timestamp), nativeId(message.toolCallId) ?? null]);
}

/** Read-only loading can clone/normalize blocks; match visible text, not replay metadata. */
function sameVisibleMessage(left: RecordValue, right: RecordValue): boolean {
	if (left === right) return true;
	for (const field of ["id", "responseId", "summary", "command", "code", "output", "display", "customType"] as const) {
		if (left[field] !== undefined && right[field] !== undefined && left[field] !== right[field]) return false;
	}
	if (Array.isArray(left.files) && Array.isArray(right.files)) {
		if (left.files.length !== right.files.length) return false;
		for (let index = 0; index < left.files.length; index++) {
			const file = record(left.files[index]);
			const other = record(right.files[index]);
			if (file?.path !== other?.path || file?.content !== other?.content) return false;
		}
	}
	if (typeof left.content === "string" || typeof right.content === "string") return left.content === right.content;
	if (!Array.isArray(left.content) || !Array.isArray(right.content)) return left.content === right.content;
	let otherIndex = 0;
	for (const value of left.content) {
		const block = record(value);
		if (block?.type !== "text") continue;
		let other: RecordValue | undefined;
		while (otherIndex < right.content.length) {
			other = record(right.content[otherIndex++]);
			if (other?.type === "text") break;
		}
		if (other?.type !== "text" || block.text !== other.text) return false;
	}
	while (otherIndex < right.content.length) if (record(right.content[otherIndex++])?.type === "text") return false;
	return true;
}

function* segments(messages: unknown[], identities: Map<string, MessageIdentity[]>, agentId: string): Generator<Segment> {
	const occurrences = new Map<string, number>();
	const usedIdentities = new Set<MessageIdentity>();
	for (const value of messages) {
		const message = record(value);
		if (!message || typeof message.role !== "string") continue;
		const role = message.role;
		const key = messageKey(message);
		const occurrence = occurrences.get(key) ?? 0;
		occurrences.set(key, occurrence + 1);
		const group = identities.get(key);
		const persisted = group?.find(candidate => !usedIdentities.has(candidate) && sameVisibleMessage(candidate.message, message));
		if (persisted) usedIdentities.add(persisted);
		if (message.display === false || role === "thinking" || role === "system" || role === "developer") continue;
		const created_ms = timestamp(message.timestamp) ?? persisted?.timestamp ?? 0;
		const fallback = `derived:${encodeURIComponent(agentId)}:${role}:${created_ms}:${occurrence}`;
		// IDs are native block IDs first, otherwise the native message/response/
		// entry ID verbatim (several spans can belong to the same message). Only
		// when no native identity exists do we derive <agent>:<role>:<timestamp>:
		// <occurrence>:block:<original index>. This is not a provider identity.
		// Opaque text/thinking signatures and provider payloads are never read.
		const messageId = nativeId(message.id) ?? nativeId(message.responseId) ?? persisted?.id ??
			(role === "toolResult" ? nativeId(message.toolCallId) : undefined);
		const id = messageId ?? fallback;
		const tool = role === "toolResult" ? nativeId(message.toolName) ?? null : null;
		// Native summaries and operator executions have visible fields instead
		// of content. Nothing else from these records (details/meta/replay) is text.
		if ((role === "branchSummary" || role === "compactionSummary") && typeof message.summary === "string" && message.summary.length > 0) {
			yield { id, role, tool, created_ms, text: message.summary };
		}
		if (role === "bashExecution" || role === "pythonExecution") {
			const command = role === "bashExecution" ? message.command : message.code;
			if (typeof command === "string" && command.length > 0) yield { id: messageId ?? `${id}:command`, role, tool: role === "bashExecution" ? "bash" : "eval", created_ms, text: command };
			if (typeof message.output === "string" && message.output.length > 0) yield { id: messageId ?? `${id}:output`, role, tool: role === "bashExecution" ? "bash" : "eval", created_ms, text: message.output };
		}
		if (role === "fileMention" && Array.isArray(message.files)) {
			for (let index = 0; index < message.files.length; index++) {
				const file = record(message.files[index]);
				if (file && typeof file.content === "string" && file.content.length > 0) yield { id: nativeId(file.id) ?? messageId ?? `${id}:file:${index}`, role, tool, created_ms, text: file.content };
			}
		}
		if (typeof message.content === "string") {
			if (message.content.length > 0) yield { id, role, tool, created_ms, text: message.content };
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		for (let index = 0; index < message.content.length; index++) {
			const block = record(message.content[index]);
			if (!block) continue;
			const blockId = nativeId(block.id) ?? messageId ?? (message.content.length === 1 ? id : `${id}:block:${index}`);
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				yield { id: blockId, role, tool, created_ms, text: block.text };
			} else if (role === "assistant" && block.type === "toolCall" && typeof block.name === "string") {
				// Only the native name and arguments are visible call content. Do not
				// serialize the block (signatures/provider replay data may live there).
				const args = JSON.stringify(block.arguments ?? {});
				yield { id: blockId, role, tool: block.name, created_ms, text: `${block.name}(${args})` };
			}
		}
	}
}

/** Clip on a Unicode code-point boundary, with UTF-8 bytes as the bound. */
function clipLine(text: string, start: number, end: number): { text: string; bytes: number } {
	// A byte-bounded prefix can never need more than MAX_LINE_BYTES code units.
	const candidateEnd = Math.min(end, start + MAX_LINE_BYTES);
	if (candidateEnd === end) {
		const line = text.slice(start, end);
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes <= MAX_LINE_BYTES) return { text: line, bytes };
	}
	const budget = MAX_LINE_BYTES - Buffer.byteLength(TRUNCATION, "utf8");
	let bytes = 0;
	let cursor = start;
	while (cursor < end) {
		const point = text.codePointAt(cursor)!;
		const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (bytes + size > budget) break;
		bytes += size;
		cursor += point > 0xffff ? 2 : 1;
	}
	return { text: text.slice(start, cursor) + TRUNCATION, bytes: bytes + Buffer.byteLength(TRUNCATION, "utf8") };
}

function page(agentId: string, messages: unknown[], identities: Map<string, MessageIdentity[]>, offset: number | undefined, limit: number): AgentOutputResult {
	// Keep only source ranges for the candidate suffix. No oversized message
	// is split or copied; clipping happens only for the returned page.
	const ring: (Line | undefined)[] = new Array(limit);
	let total = 0;
	let retained = 0;
	let segmentIndex = 0;
	for (const segment of segments(messages, identities, agentId)) {
		let start = 0;
		while (start <= segment.text.length) {
			const newline = segment.text.indexOf("\n", start);
			const end = newline === -1 ? segment.text.length : newline;
			if (offset === undefined || total < offset) {
				ring[retained % limit] = { source: segment, start, end, segment: segmentIndex };
				retained++;
			}
			total++;
			if (newline === -1) break;
			start = newline + 1;
		}
		segmentIndex++;
	}
	const upper = Math.min(offset ?? total, total);
	const count = Math.min(retained, limit);
	const selected: (Segment & { segment: number })[] = [];
	let bytes = 0;
	for (let index = retained - 1; index >= retained - count; index--) {
		const line = ring[index % limit]!;
		const clipped = clipLine(line.source.text, line.start, line.end);
		const nextBytes = bytes + clipped.bytes + (selected.length > 0 ? 1 : 0);
		if (nextBytes > MAX_PAGE_BYTES) break;
		selected.push({ ...line.source, text: clipped.text, segment: line.segment });
		bytes = nextBytes;
	}
	selected.reverse();
	const spans: AgentOutputResult["spans"] = [];
	const textParts: string[] = [];
	let position = 0;
	let previousSegment = -1;
	for (const line of selected) {
		if (textParts.length > 0) position++;
		textParts.push(line.text);
		const end = position + line.text.length;
		const previous = spans[spans.length - 1];
		if (previous && previousSegment === line.segment) previous.end = end;
		else spans.push({ id: line.id, role: line.role, tool: line.tool, created_ms: line.created_ms, start: position, end });
		position = end;
		previousSegment = line.segment;
	}
	const lower = upper - selected.length;
	return { agentId, text: textParts.join("\n"), spans, nextOffset: lower > 0 ? lower : null };
}

/** Read an already-authorized native child, without revival, writers or locks. */
export async function readAgentOutput(ref: AgentRef, params: AgentOutputParams, api: Record<string, unknown>, readChild: ReadChild): Promise<AgentOutputResult> {
	const { offset, limit = DEFAULT_LIMIT } = params;
	if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new BridgeError("bad_request", "offset must be a safe integer >= 0");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LINES) throw new BridgeError("bad_request", "limit must be an integer from 1 to 500");
	if (ref.session) {
		const session = ref.session;
		if (!Array.isArray(session.messages)) unavailable("The live child session.messages API is unavailable");
		const messages: unknown[] = [...session.messages];
		if (!session.agent?.state || !("streamMessage" in session.agent.state)) unavailable("The live child agent.state.streamMessage API is unavailable");
		const streamMessage = session.agent.state.streamMessage;
		if (streamMessage && !messages.includes(streamMessage)) messages.push(streamMessage);
		// This is an existing in-memory reader only; never instantiate a manager.
		const branch = typeof session.sessionManager?.getBranch === "function" ? session.sessionManager.getBranch() : [];
		return page(ref.id, messages, messageIdentities(branch), offset, limit);
	}
	const loadMessages = api.loadSessionMessagesReadOnly;
	if (typeof loadMessages !== "function") unavailable("loadSessionMessagesReadOnly is required for read-only child transcripts");
	const loadEntries = api.loadEntriesFromFile;
	if (typeof loadEntries !== "function") unavailable("loadEntriesFromFile is required to preserve native persisted transcript identities");
	const messages = await readChild(ref, async file => {
		const loaded: unknown = await loadMessages(file);
		if (!Array.isArray(loaded)) unavailable("loadSessionMessagesReadOnly did not return native messages");
		return loaded;
	});
	const identities = await readChild(ref, async file => {
		const entries: unknown = await loadEntries(file);
		if (!Array.isArray(entries)) unavailable("loadEntriesFromFile did not return native entries");
		return messageIdentities(entries);
	});
	return page(ref.id, messages, identities, offset, limit);
}

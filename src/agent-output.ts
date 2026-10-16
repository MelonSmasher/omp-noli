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

/** `cursor.message` is the message that produced each yielded segment. */
function* segments(messages: unknown[], identities: Map<string, MessageIdentity[]>, agentId: string, cursor: { message?: RecordValue } = {}): Generator<Segment> {
	const occurrences = new Map<string, number>();
	const usedIdentities = new Set<MessageIdentity>();
	for (const value of messages) {
		const message = record(value);
		if (!message || typeof message.role !== "string") continue;
		cursor.message = message;
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

/**
 * Transcript revision: SHA-256 over the per-message digests, in order. A
 * message digest is SHA-256 over each visible segment it renders: the JSON
 * array `[id, role, tool, created_ms, length]` followed by exactly `length`
 * UTF-16 code units of its full unclipped text, all hashed as raw UTF-16LE
 * code units. The encoding is injective (lone surrogates included), so the
 * revision changes whenever any rendered line, span identity or segment
 * boundary changes anywhere: appends, in-place rewrites of older messages,
 * truncation and streaming updates. Page bounds never affect it.
 */
/** `cost` estimates what the entry retains, in UTF-16 units: its text, its span identities and a fixed per-segment overhead. */
interface MessageDigest { segments: Segment[]; digest: Uint8Array; cost: number; }
/**
 * A rendered transcript retained under its revision, so older pages of it
 * can still be served. `scope` and `session` are its provenance: the
 * authorized read scope (bridge instance, session adoption, root artifact
 * directory, root session, child ID and canonical transcript path) and the
 * live session object it was rendered from (null when parked). It is served
 * only to a read with exactly the same provenance.
 */
interface Snapshot { revision: string; entries: MessageDigest[]; cost: number; scope: string; session: unknown; }
/** Live messages' digests by message object. */
const messageDigests = new WeakMap<RecordValue, MessageDigest>();
/**
 * The latest rendered transcripts of each child, newest first, at most
 * `perChild` per child. They serve pages requested with a `revision` and
 * give parked children (which reload fresh message objects on every read)
 * their digests by message position. Bounded across children, least
 * recently used evicted first: at most `children` children and `units` of
 * cost, where cost counts the retained text and span identities in UTF-16
 * units plus fixed per-segment, per-message and per-snapshot overheads.
 * Transcripts without visible messages are not retained. An evicted
 * snapshot is reported as `snapshot_expired`; an evicted child is simply
 * hashed again. Mutable only so tests can exercise eviction cheaply.
 */
export const snapshotLimits = { units: 32 * 1024 * 1024, children: 1024, perChild: 2 };
const snapshots = new Map<AgentRef, Snapshot[]>();
const ENTRY_OVERHEAD = 256;
const SEGMENT_OVERHEAD = 64;
/** Text is hashed in slices of this many UTF-16 units, so no message is copied whole. */
const HASH_CHUNK_UNITS = 64 * 1024;
/** Longest `revision` parameter accepted. */
const MAX_REVISION_LENGTH = 256;
let snapshotCost = 0;
/** Revision work actually performed, observed by the budget tests. */
export const revisionWork = { messageDigests: 0 };
/** Current snapshot cache occupancy, observed by the bound tests. */
export function snapshotUsage(): { children: number; snapshots: number; cost: number } {
	let count = 0;
	for (const list of snapshots.values()) count += list.length;
	return { children: snapshots.size, snapshots: count, cost: snapshotCost };
}

/** Forgets every retained snapshot, as on a session adoption or release. */
export function clearSnapshots(): void {
	snapshots.clear();
	snapshotCost = 0;
}

/** Drops a child's snapshots, e.g. once its provenance no longer matches. */
function forget(ref: AgentRef): void {
	const list = snapshots.get(ref);
	if (!list) return;
	snapshots.delete(ref);
	for (const snapshot of list) snapshotCost -= snapshot.cost;
}

/**
 * The child's snapshots if they were rendered under exactly this provenance.
 * Snapshots of any other provenance are dropped: content rendered for an
 * earlier root, adoption, transcript or session is never served or reused.
 */
function scoped(ref: AgentRef, scope: string): Snapshot[] | undefined {
	const list = snapshots.get(ref);
	if (list && list.every(snapshot => snapshot.scope === scope && snapshot.session === (ref.session ?? null))) return list;
	forget(ref);
	return undefined;
}

/** Retains a freshly rendered transcript as the child's newest snapshot, within the cache bounds. */
function remember(ref: AgentRef, scope: string, revision: string, entries: MessageDigest[]): void {
	if (entries.length === 0) return;
	const previous = scoped(ref, scope) ?? [];
	snapshots.delete(ref);
	let list = previous;
	if (previous[0]?.revision !== revision) {
		const cost = entries.reduce((sum, entry) => sum + entry.cost + ENTRY_OVERHEAD, ENTRY_OVERHEAD);
		list = [{ revision, entries, cost, scope, session: ref.session ?? null }, ...previous];
		snapshotCost += cost;
		for (const dropped of list.splice(snapshotLimits.perChild)) snapshotCost -= dropped.cost;
		// A snapshot over the whole budget on its own is never retained.
		while (list.length > 0 && list[0]!.cost > snapshotLimits.units) snapshotCost -= list.shift()!.cost;
	}
	if (list.length === 0) return;
	snapshots.set(ref, list);
	for (const [oldest, cached] of snapshots) {
		if (snapshotCost <= snapshotLimits.units && snapshots.size <= snapshotLimits.children) break;
		snapshots.delete(oldest);
		for (const snapshot of cached) snapshotCost -= snapshot.cost;
	}
}

/**
 * Reuses a message's earlier digest only while the message still renders the
 * same segments: every field, including the full text, is compared, so cached
 * state can never vouch for content it was not computed from. String
 * comparison is far cheaper than hashing, and identical string instances
 * (live sessions) compare at once.
 */
function messageDigest(message: RecordValue, rendered: Segment[], positional: MessageDigest | undefined): MessageDigest {
	const cached = messageDigests.get(message) ?? positional;
	if (cached && cached.segments.length === rendered.length && cached.segments.every((old, index) => {
		const segment = rendered[index]!;
		return old.id === segment.id && old.role === segment.role && old.tool === segment.tool && old.created_ms === segment.created_ms && old.text === segment.text;
	})) {
		messageDigests.set(message, cached);
		return cached;
	}
	const hasher = new Bun.CryptoHasher("sha256");
	let cost = 0;
	for (const segment of rendered) {
		hasher.update(Buffer.from(JSON.stringify([segment.id, segment.role, segment.tool, segment.created_ms, segment.text.length]), "utf16le"));
		// Slices may split a surrogate pair; UTF-16LE encodes each code unit
		// as-is, so the hashed bytes are identical to encoding the whole text.
		for (let start = 0; start < segment.text.length; start += HASH_CHUNK_UNITS) {
			hasher.update(Buffer.from(segment.text.slice(start, start + HASH_CHUNK_UNITS), "utf16le"));
		}
		cost += segment.text.length + segment.id.length + segment.role.length + (segment.tool?.length ?? 0) + SEGMENT_OVERHEAD;
	}
	const entry = { segments: rendered, digest: new Uint8Array(hasher.digest()), cost };
	revisionWork.messageDigests++;
	messageDigests.set(message, entry);
	return entry;
}

/**
 * Renders a transcript into per-message digests and its revision. `previous`
 * supplies an earlier rendering's digests by position (parked children).
 */
function render(agentId: string, messages: unknown[], identities: Map<string, MessageIdentity[]>, previous: MessageDigest[] = []): { entries: MessageDigest[]; revision: string } {
	const transcript = new Bun.CryptoHasher("sha256");
	const entries: MessageDigest[] = [];
	const cursor: { message?: RecordValue } = {};
	let message: RecordValue | undefined;
	let rendered: Segment[] = [];
	const finishMessage = (): void => {
		if (message) {
			const entry = messageDigest(message, rendered, previous[entries.length]);
			transcript.update(entry.digest);
			entries.push(entry);
		}
		rendered = [];
	};
	for (const segment of segments(messages, identities, agentId, cursor)) {
		if (cursor.message !== message) {
			finishMessage();
			message = cursor.message;
		}
		rendered.push(segment);
	}
	finishMessage();
	return { entries, revision: `sha256:${transcript.digest("hex")}` };
}

function page(agentId: string, entries: MessageDigest[], revision: string, offset: number | undefined, limit: number): AgentOutputResult {
	// Keep only source ranges for the candidate suffix. No oversized message
	// is split or copied; clipping happens only for the returned page.
	const ring: (Line | undefined)[] = new Array(limit);
	let total = 0;
	let retained = 0;
	let segmentIndex = 0;
	for (const entry of entries) {
		for (const segment of entry.segments) {
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
	return { agentId, text: textParts.join("\n"), spans, nextOffset: lower > 0 ? lower : null, revision };
}

/**
 * Read an already-authorized native child, without revival, writers or
 * locks. `scope` identifies the authorized read (see `Snapshot`); a frozen
 * read is served only from a snapshot retained under the same scope.
 */
export async function readAgentOutput(ref: AgentRef, params: AgentOutputParams, api: Record<string, unknown>, readChild: ReadChild, scope: string): Promise<AgentOutputResult> {
	const { offset, limit = DEFAULT_LIMIT, revision } = params;
	if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new BridgeError("bad_request", "offset must be a safe integer >= 0");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LINES) throw new BridgeError("bad_request", "limit must be an integer from 1 to 500");
	if (revision !== undefined && (typeof revision !== "string" || revision.length === 0 || revision.length > MAX_REVISION_LENGTH)) throw new BridgeError("bad_request", "revision must be a nonempty string of at most 256 characters");
	if (revision !== undefined) {
		// A frozen read: serve the retained transcript with this revision even
		// if the child has produced more output since, so a client can page
		// through one consistent transcript while the child keeps streaming.
		const list = scoped(ref, scope);
		const snapshot = list?.find(candidate => candidate.revision === revision);
		if (!list || !snapshot) throw new BridgeError("snapshot_expired", "the requested transcript revision is no longer retained; read the newest page again");
		snapshots.delete(ref);
		snapshots.set(ref, list);
		return page(ref.id, snapshot.entries, snapshot.revision, offset, limit);
	}
	if (ref.session) {
		const session = ref.session;
		if (!Array.isArray(session.messages)) unavailable("The live child session.messages API is unavailable");
		const messages: unknown[] = [...session.messages];
		if (!session.agent?.state || !("streamMessage" in session.agent.state)) unavailable("The live child agent.state.streamMessage API is unavailable");
		const streamMessage = session.agent.state.streamMessage;
		if (streamMessage && !messages.includes(streamMessage)) messages.push(streamMessage);
		// This is an existing in-memory reader only; never instantiate a manager.
		const branch = typeof session.sessionManager?.getBranch === "function" ? session.sessionManager.getBranch() : [];
		const rendered = render(ref.id, messages, messageIdentities(branch));
		remember(ref, scope, rendered.revision, rendered.entries);
		return page(ref.id, rendered.entries, rendered.revision, offset, limit);
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
	const rendered = render(ref.id, messages, identities, scoped(ref, scope)?.[0]?.entries);
	remember(ref, scope, rendered.revision, rendered.entries);
	return page(ref.id, rendered.entries, rendered.revision, offset, limit);
}

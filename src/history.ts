/**
 * Bounded pages of the root session's canonical append history.
 *
 * OMP's `get_entries` RPC answers with the whole history (or its whole tail
 * after `since`), and OMP caps one logical RPC frame at 64 MiB, so a long
 * session can never be reconciled through it. This slices the same canonical
 * `SessionManager.getEntries()` list into pages that fit one bridge frame. An
 * entry larger than a page travels as contiguous fragments of its JSON text.
 */
import { HISTORY_DEFAULT_BYTES, type HistoryEntriesParams, type HistoryEntriesResult } from "./protocol";
import { BridgeError } from "./bridge";

const encoder = new TextEncoder();
const utf8 = (text: string): number => encoder.encode(text).length;

interface Entry { id?: unknown }

/** The largest `end` such that `text.slice(offset, end)`, escaped as a JSON string, fits `budget` bytes; never splits a surrogate pair and always advances one code point. */
function fragmentEnd(text: string, offset: number, budget: number): number {
	const step = (index: number): number => {
		const code = text.charCodeAt(index);
		return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
	};
	const settle = (end: number): number => {
		const code = text.charCodeAt(end - 1);
		return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
	};
	const minimum = offset + step(offset);
	let low = minimum;
	// Every UTF-16 unit costs at least one escaped byte, so no slice longer than the budget fits.
	let high = Math.min(text.length, offset + budget);
	if (utf8(JSON.stringify(text.slice(offset, low))) > budget) return minimum;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (utf8(JSON.stringify(text.slice(offset, middle))) <= budget) low = middle;
		else high = middle - 1;
	}
	return Math.max(minimum, settle(low));
}

/** One page strictly after `params.since`, in append order. */
export function historyPage(entries: readonly Entry[], leafId: string | null, sessionId: string, params: HistoryEntriesParams): HistoryEntriesResult {
	const budget = params.maxBytes ?? HISTORY_DEFAULT_BYTES;
	const offset = params.offset ?? 0;
	let start = 0;
	if (params.since !== undefined) {
		// Cursors are almost always near the tail.
		const index = entries.findLastIndex(entry => entry.id === params.since);
		if (index === -1) throw new BridgeError("unknown_since", `Unknown entries cursor: ${params.since}`);
		start = index + 1;
	}
	const fragment = (entry: Entry, from: number): HistoryEntriesResult => {
		if (typeof entry.id !== "string") throw new BridgeError("internal", "History entry has no id");
		const text = JSON.stringify(entry);
		if (from >= text.length) throw new BridgeError("bad_request", "params.offset is past the end of the entry");
		const end = fragmentEnd(text, from, budget);
		return { sessionId, leafId, entries: [], partial: { id: entry.id, offset: from, total: text.length, text: text.slice(from, end) }, more: end < text.length || start + 1 < entries.length };
	};
	if (offset > 0) {
		const entry = entries[start];
		if (!entry) throw new BridgeError("bad_request", "params.offset needs an entry after params.since");
		return fragment(entry, offset);
	}
	const page: Entry[] = [];
	let used = 0;
	let index = start;
	for (; index < entries.length; index++) {
		const size = utf8(JSON.stringify(entries[index]));
		if (used + size > budget) break;
		used += size;
		page.push(entries[index]!);
	}
	if (page.length === 0 && index < entries.length) return fragment(entries[index]!, 0);
	return { sessionId, leafId, entries: page as Record<string, unknown>[], more: index < entries.length };
}

import { describe, expect, test } from "bun:test";
import { BridgeError } from "../src/bridge";
import { historyPage } from "../src/history";
import { HISTORY_MIN_BYTES, type HistoryEntriesResult } from "../src/protocol";

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Reads the whole history the way a client does: whole pages, then contiguous fragments. */
function drain(entries: Array<Record<string, unknown>>, maxBytes: number): { read: unknown[]; pages: HistoryEntriesResult[] } {
	const read: unknown[] = [];
	const pages: HistoryEntriesResult[] = [];
	let since: string | undefined;
	let fragment = "";
	for (;;) {
		const page = historyPage(entries, "leaf", "s", { since, offset: fragment.length, maxBytes });
		pages.push(page);
		for (const entry of page.entries) {
			read.push(entry);
			since = entry.id as string;
		}
		if (page.partial) {
			expect(page.entries).toEqual([]);
			expect(page.partial.offset).toBe(fragment.length);
			expect(bytes(page.partial.text)).toBeLessThanOrEqual(maxBytes);
			fragment += page.partial.text;
			if (fragment.length === page.partial.total) {
				read.push(JSON.parse(fragment));
				since = page.partial.id;
				fragment = "";
			}
		}
		if (!page.more) return { read, pages };
	}
}

describe("historyPage", () => {
	test("whole entries fill a page greedily within the byte budget, in append order", () => {
		const entries = Array.from({ length: 40 }, (_, index) => ({ id: `e${index}`, type: "message", text: "é".repeat(200 + index) }));
		const { read, pages } = drain(entries, HISTORY_MIN_BYTES);
		expect(read).toEqual(entries);
		expect(pages.length).toBeGreaterThan(2);
		let next = 0;
		for (const page of pages) {
			const used = page.entries.reduce((sum, entry) => sum + bytes(entry), 0);
			expect(used).toBeLessThanOrEqual(HISTORY_MIN_BYTES);
			expect(page.partial).toBeUndefined();
			next += page.entries.length;
			// Greedy: a page ends only where the next entry would not fit.
			if (page.more) expect(used + bytes(entries[next])).toBeGreaterThan(HISTORY_MIN_BYTES);
		}
		expect(next).toBe(entries.length);
		expect(pages.at(-1)!.more).toBe(false);
	});

	test("an entry larger than a page arrives as fragments that reassemble exactly", () => {
		// Astral characters straddle every boundary; control characters expand sixfold when escaped.
		const text = "😀\u0001a\"\\".repeat(4000);
		const entries = [{ id: "small", type: "message" }, { id: "huge", type: "message", text }, { id: "after", type: "message" }];
		const { read, pages } = drain(entries, HISTORY_MIN_BYTES);
		expect(read).toEqual(entries);
		expect(pages.filter(page => page.partial).length).toBeGreaterThan(10);
		for (const page of pages) {
			if (!page.partial) continue;
			const first = page.partial.text.charCodeAt(0);
			expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
		}
	});

	test("starts strictly after since and reports an empty tail", () => {
		const entries = [{ id: "a" }, { id: "b" }];
		expect(historyPage(entries, "b", "s", { since: "a" })).toEqual({ sessionId: "s", leafId: "b", entries: [{ id: "b" }], more: false });
		expect(historyPage(entries, "b", "s", { since: "b" })).toEqual({ sessionId: "s", leafId: "b", entries: [], more: false });
		expect(historyPage([], null, "s", {})).toEqual({ sessionId: "s", leafId: null, entries: [], more: false });
	});

	test("an unknown since is unknown_since; an offset past the entry is bad_request", () => {
		const code = (run: () => unknown): string | undefined => {
			try {
				run();
			} catch (error) {
				return error instanceof BridgeError ? error.body.code : undefined;
			}
			return undefined;
		};
		expect(code(() => historyPage([{ id: "a" }], "a", "s", { since: "lost" }))).toBe("unknown_since");
		expect(code(() => historyPage([{ id: "a" }], "a", "s", { offset: 100 }))).toBe("bad_request");
		expect(code(() => historyPage([{ id: "a" }], "a", "s", { since: "a", offset: 1 }))).toBe("bad_request");
		// `{"id":"😀"}`: offset 8 falls between the emoji's two UTF-16 units.
		expect(code(() => historyPage([{ id: "😀" }], "😀", "s", { offset: 8 }))).toBe("bad_request");
		expect(historyPage([{ id: "😀" }], "😀", "s", { offset: 7 }).partial?.text).toBe("😀\"}");
	});
});

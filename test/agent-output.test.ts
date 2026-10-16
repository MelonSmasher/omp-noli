import { describe, expect, test } from "bun:test";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent";
import { snapshotLimits, snapshotUsage, readAgentOutput, revisionWork } from "../src/agent-output";
import { BridgeError } from "../src/bridge";
import type { AgentOutputParams } from "../src/protocol";

type Message = Record<string, unknown>;
/** One authorized read scope; the host computes the real one per read. */
const SCOPE = "test-scope";
const noDisk = async <T>(_ref: AgentRef, _loader: (file: string) => Promise<T>): Promise<T> => { throw new Error("Live output must not read disk"); };

function live(messages: Message[], streamMessage: Message | null = null, branch: Message[] = []): AgentRef {
	return {
		id: "child", kind: "sub", session: {
			messages, agent: { state: { streamMessage } }, sessionManager: { getBranch: () => branch },
		},
	} as unknown as AgentRef;
}

function parked(): AgentRef {
	return { id: "child", kind: "sub", session: null, sessionFile: "/authorized/child.jsonl" } as AgentRef;
}

function text(role: string, value: string, timestamp = 100): Message {
	return { role, content: [{ type: "text", text: value }], timestamp };
}

function entry(id: string, parentId: string | null, message: Message): Message {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp as number).toISOString(), message };
}

function diskHarness(messages: Message[], entries: Message[] = []) {
	const reads: string[] = [];
	const calls: string[] = [];
	const api = {
		async loadSessionMessagesReadOnly(file: string) { calls.push(`messages:${file}`); return messages; },
		async loadEntriesFromFile(file: string) { calls.push(`entries:${file}`); return entries; },
		SessionManager: { open() { throw new Error("Must not open a writer"); } },
		revive() { throw new Error("Must not revive a child"); },
	};
	const readChild = async <T>(ref: AgentRef, loader: (file: string) => Promise<T>): Promise<T> => {
		expect(ref.session).toBeNull();
		reads.push(ref.id);
		return loader("/canonical/child.jsonl");
	};
	return { api, reads, calls, readChild };
}

async function output(messages: Message[], params: Partial<AgentOutputParams> = {}) {
	return readAgentOutput(live(messages), { agentId: "child", ...params }, {}, noDisk, SCOPE);
}

describe("native child transcript output", () => {
	test("reads live user/assistant/tool content and partial response without disk", async () => {
		const messages = [
			{ ...text("user", "prompt", 11), id: "prompt-id", providerPayload: { content: "opaque-user-payload" } },
			{
				role: "assistant", responseId: "response-id", timestamp: 12,
				content: [
					{ type: "thinking", thinking: "private-thinking", thinkingSignature: "private-signature" },
					{ type: "text", id: "text-block", text: "Working", textSignature: "opaque-text-signature" },
					{ type: "toolCall", id: "call-id", name: "read", arguments: { path: "src/index.ts" }, thoughtSignature: "private-tool-signature" },
					{ type: "image", data: "private-image", mimeType: "image/png" },
					{ type: "redactedThinking", data: "private-redaction" },
				],
				providerPayload: { content: "private-provider-payload" }, usage: { input: 77 },
			},
			{ ...text("toolResult", "contents", 13), toolName: "read", toolCallId: "call-id", details: { password: "opaque-details" }, providerMetadata: { data: "opaque-result-metadata" } },
			{ role: "custom", content: "hidden-custom", display: false, timestamp: 14 },
			{ role: "system", content: "hidden-system", timestamp: 15 },
		];
		const partial = { ...text("assistant", "Still typing 🦊", 16), id: "partial-id" };
		const result = await readAgentOutput(live(messages, partial), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(result.text).toBe('prompt\nWorking\nread({"path":"src/index.ts"})\ncontents\nStill typing 🦊');
		expect(result.spans.map(({ id, role, tool, created_ms }) => ({ id, role, tool, created_ms }))).toEqual([
			{ id: "prompt-id", role: "user", tool: null, created_ms: 11 },
			{ id: "text-block", role: "assistant", tool: null, created_ms: 12 },
			{ id: "call-id", role: "assistant", tool: "read", created_ms: 12 },
			{ id: "call-id", role: "toolResult", tool: "read", created_ms: 13 },
			{ id: "partial-id", role: "assistant", tool: null, created_ms: 16 },
		]);
		expect(result.spans.map(span => result.text.slice(span.start, span.end))).toEqual(["prompt", "Working", 'read({"path":"src/index.ts"})', "contents", "Still typing 🦊"]);
		expect(result.nextOffset).toBeNull();
	});

	test("does not duplicate an already appended streaming object", async () => {
		const message = text("assistant", "response");
		const result = await readAgentOutput(live([message], message), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(result.text).toBe("response");
	});

	test("parked reads use canonical wrapper and native read-only loader", async () => {
		const prompt = text("user", "prompt", 100);
		const reply = text("assistant", "reply", 101);
		const h = diskHarness([prompt, reply], [
			entry("prompt-entry", null, prompt),
			entry("abandoned-entry", "prompt-entry", text("assistant", "discarded", 101)),
			entry("reply-entry", "prompt-entry", reply),
			{ type: "thinking_level_change", id: "last", parentId: "reply-entry", timestamp: "2026-01-01T00:00:00Z", thinkingLevel: "high" },
		]);
		const ref = parked();
		const result = await readAgentOutput(ref, { agentId: "child" }, h.api, h.readChild, SCOPE);
		expect(h.reads).toEqual(["child", "child"]);
		expect(h.calls).toEqual(["messages:/canonical/child.jsonl", "entries:/canonical/child.jsonl"]);
		expect(result.text).toBe("prompt\nreply");
		expect(result.spans.map(span => span.id)).toEqual(["prompt-entry", "reply-entry"]);
		expect(ref.session).toBeNull();
		expect(ref.sessionFile).toBe("/authorized/child.jsonl");
	});

	test("live entry identities are read only from the existing current branch", async () => {
		const first = text("user", "prompt", 33);
		const reply = text("assistant", "answer", 34);
		const result = await readAgentOutput(live([first, reply], null, [entry("u", null, first), entry("a", "u", reply)]), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(result.spans.map(span => span.id)).toEqual(["u", "a"]);
	});

	test("visible custom roles, summaries and operator executions keep native roles", async () => {
		const messages = [
			{ role: "custom", content: "notice", display: true, timestamp: 1, id: "custom" },
			{ role: "hookMessage", content: [{ type: "text", text: "hook" }], display: true, timestamp: 2 },
			{ role: "futureVisibleRole", content: [{ type: "thinking", thinking: "not-visible" }, { type: "text", text: "future" }], timestamp: 3 },
			{ role: "compactionSummary", summary: "summary", timestamp: 4, providerPayload: { summary: "hidden" } },
			{ role: "branchSummary", summary: "branch", timestamp: 5 },
			{ role: "bashExecution", command: "pwd", output: "/project", timestamp: 6, meta: { body: "hidden" } },
			{ role: "pythonExecution", code: "1 + 1", output: "2", timestamp: 7 },
			{ role: "fileMention", files: [{ path: "/visible", content: "file body", metadata: "hidden" }], timestamp: 8 },
			{ role: "developer", content: "hidden-provider-input", timestamp: 9 },
		];
		const result = await output(messages);
		expect(result.text).toBe("notice\nhook\nfuture\nsummary\nbranch\npwd\n/project\n1 + 1\n2\nfile body");
		expect(result.spans.map(span => span.role)).toEqual(["custom", "hookMessage", "futureVisibleRole", "compactionSummary", "branchSummary", "bashExecution", "bashExecution", "pythonExecution", "pythonExecution", "fileMention"]);
	});

	test("hidden custom messages cannot shift visible persisted entry identities", async () => {
		const hidden = { role: "custom", content: "hidden", display: false, timestamp: 100 };
		const visible = { role: "custom", content: "visible", display: true, timestamp: 100 };
		const h = diskHarness([hidden, visible], [
			{ type: "custom_message", id: "hidden-id", parentId: null, timestamp: new Date(100).toISOString(), content: "hidden" },
			{ type: "custom_message", id: "visible-id", parentId: "hidden-id", timestamp: new Date(100).toISOString(), content: "visible" },
		]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild, SCOPE);
		expect(result.text).toBe("visible");
		expect(result.spans[0]?.id).toBe("visible-id");
	});

	test("compacted same-timestamp messages keep their own entry IDs rather than positional IDs", async () => {
		const old = text("assistant", "old", 100);
		const kept = text("assistant", "kept", 100);
		const h = diskHarness([kept], [entry("old-id", null, old), entry("kept-id", "old-id", kept)]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild, SCOPE);
		expect(result.spans[0]?.id).toBe("kept-id");
	});

	test("entry parent cycles terminate without inventing abandoned content", async () => {
		const h = diskHarness([text("assistant", "answer")], [entry("a", "b", text("assistant", "answer")), { type: "model_change", id: "b", parentId: "a" }]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild, SCOPE);
		expect(result.text).toBe("answer");
		expect(result.spans[0]?.id).toBe("a");
	});

	test("missing native identities have deterministic original-index fallbacks", async () => {
		const messages = [
			{ role: "assistant", timestamp: 10, responseId: "r", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "one" }, { type: "text", text: "two" }] },
			{ ...text("user", "three", 20), providerPayload: { id: "not-an-identity" }, textSignature: "not-an-identity" },
			text("user", "four", 20),
			{ role: "assistant", timestamp: 30, content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "fallback block" }] },
		];
		const first = await output(messages);
		const second = await output(messages);
		expect(second).toEqual(first);
		expect(first.spans.map(span => span.id)).toEqual(["r", "r", "derived:child:user:20:0", "derived:child:user:20:1", "derived:child:assistant:30:0:block:1"]);
		const older = await output(messages, { offset: 3, limit: 1 });
		expect(older.spans[0]?.id).toBe(first.spans[2]?.id);
	});

	test("missing persisted entry export fails explicitly before any disk read", async () => {
		const h = diskHarness([text("user", "prompt")]);
		await expect(readAgentOutput(parked(), { agentId: "child" }, { loadSessionMessagesReadOnly: h.api.loadSessionMessagesReadOnly }, h.readChild, SCOPE)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output", reason: "export_missing" } });
		expect(h.calls).toEqual([]);
		expect(h.reads).toEqual([]);
	});

	test("native message and block IDs win over entry IDs", async () => {
		const message = { ...text("assistant", "answer", 222), id: "message-id", responseId: "response-id" };
		const h = diskHarness([message], [entry("entry-id", null, message)]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild, SCOPE);
		expect(result.spans[0]?.id).toBe("message-id");
		expect(result.spans[0]?.created_ms).toBe(222);
	});

	test("UTF-16 spans remain exact across emoji, newlines and clipped pages", async () => {
		const messages = [{ ...text("user", "🦊 first\nsecond 😀\nthird", 1), id: "u" }, { ...text("assistant", "✅ done", 2), id: "a" }];
		const result = await output(messages, { limit: 3 });
		expect(result.text).toBe("second 😀\nthird\n✅ done");
		expect(result.spans).toEqual([
			{ id: "u", role: "user", tool: null, created_ms: 1, start: 0, end: 15 },
			{ id: "a", role: "assistant", tool: null, created_ms: 2, start: 16, end: 22 },
		]);
		expect(result.nextOffset).toBe(1);
		const older = await output(messages, { offset: result.nextOffset!, limit: 3 });
		expect(older.text).toBe("🦊 first");
		expect(older.spans[0]?.end).toBe(8);
		expect(older.nextOffset).toBeNull();
	});

	test("newest default and exclusive older offsets have no skips or duplicates", async () => {
		const lines = Array.from({ length: 1103 }, (_, index) => `line ${index}`);
		const messages = [text("assistant", lines.join("\n"))];
		const newest = await output(messages);
		expect(newest.text.split("\n")).toEqual(lines.slice(-100));
		expect(newest.nextOffset).toBe(1003);
		let result = await output(messages, { limit: 237 });
		const pages = [result.text.split("\n")];
		while (result.nextOffset !== null) {
			result = await output(messages, { offset: result.nextOffset, limit: 237 });
			pages.unshift(result.text.split("\n"));
		}
		expect(pages.flat()).toEqual(lines);
	});

	test("page byte bound returns complete suffix lines and all older lines remain reachable", async () => {
		const lines = Array.from({ length: 40 }, (_, index) => `${index}:` + "🦊".repeat(1500));
		const messages = [text("assistant", lines.join("\n"))];
		let result = await output(messages, { limit: 500 });
		const pages: string[][] = [];
		while (true) {
			expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
			expect(result.text.split("\n").length).toBeLessThanOrEqual(500);
			expect(result.text).not.toContain("line truncated");
			for (const span of result.spans) {
				expect(span.start).toBeGreaterThanOrEqual(0);
				expect(span.end).toBeLessThanOrEqual(result.text.length);
			}
			pages.unshift(result.text.split("\n"));
			if (result.nextOffset === null) break;
			result = await output(messages, { offset: result.nextOffset, limit: 500 });
		}
		expect(pages.flat()).toEqual(lines);
	});

	test("500 line hard limit is enforced while older pages retain the remainder", async () => {
		const lines = Array.from({ length: 501 }, (_, index) => `${index}`);
		const result = await output([text("assistant", lines.join("\n"))], { limit: 500 });
		expect(result.text.split("\n")).toEqual(lines.slice(1));
		expect(result.nextOffset).toBe(1);
	});

	test("oversized lines truncate explicitly within 8 KiB without splitting emoji", async () => {
		const messages = [text("assistant", "a".repeat(8192) + "\n" + "🦊".repeat(5000) + "\nlast")];
		const result = await output(messages);
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("a".repeat(8192));
		expect(lines[1]).toEndWith("[… line truncated …]");
		expect(lines[1]).not.toContain("�");
		for (const line of lines) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(8192);
		expect(result.spans[0]?.end).toBe(result.text.length);
		expect(result.nextOffset).toBeNull();
	});

	test("huge ASCII and multibyte lines do not consume the entire page", async () => {
		const result = await output([text("user", "x".repeat(100_000)), text("assistant", "界".repeat(100_000))]);
		expect(result.text.split("\n")).toHaveLength(2);
		expect(result.text.match(/line truncated/g)).toHaveLength(2);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(16385);
		expect(result.spans[1]?.start).toBe((result.text.split("\n")[0]?.length ?? 0) + 1);
	});

	test("truncated full-size lines have reachable byte-limited older pages and UTF-16 spans", async () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({ ...text("assistant", `${index}:` + "🦊".repeat(5000), index + 1), id: `message-${index}` }));
		let result = await output(messages, { limit: 500 });
		const ids: string[] = [];
		while (true) {
			expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
			for (const span of result.spans) {
				expect(result.text.slice(span.start, span.end)).toEndWith("[… line truncated …]");
				expect(result.text.slice(span.start, span.end)).not.toContain("�");
			}
			ids.unshift(...result.spans.map(span => span.id));
			if (result.nextOffset === null) break;
			result = await output(messages, { offset: result.nextOffset, limit: 500 });
		}
		expect(ids).toEqual(messages.map(message => message.id));
	});

	test("blank and trailing source lines count as lines with valid spans", async () => {
		const result = await output([text("assistant", "a\n\nb\n")], { limit: 2 });
		expect(result.text).toBe("b\n");
		expect(result.nextOffset).toBe(2);
		expect(result.spans[0]?.end).toBe(2);
		const older = await output([text("assistant", "a\n\nb\n")], { offset: 2, limit: 2 });
		expect(older.text).toBe("a\n");
		expect(older.nextOffset).toBeNull();
	});

	test("empty, zero-offset and past-end reads are bounded", async () => {
		const empty = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		expect(await output([])).toEqual({ agentId: "child", text: "", spans: [], nextOffset: null, revision: empty });
		const lines = [text("assistant", "one\ntwo")];
		const newest = await output(lines);
		expect(await output(lines, { offset: 0 })).toEqual({ agentId: "child", text: "", spans: [], nextOffset: null, revision: newest.revision });
		const result = await output(lines, { offset: Number.MAX_SAFE_INTEGER, limit: 1 });
		expect(result.text).toBe("two");
		expect(result.nextOffset).toBe(1);
	});

	test("revision identifies the whole transcript, not the page", async () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({ ...text(index % 2 ? "assistant" : "user", `line ${index}\nmore ${index}`, 100 + index), id: `m${index}` }));
		const newest = await output(messages, { limit: 7 });
		expect(newest.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
		// Every page and every page size of one transcript carries the same revision.
		let page = newest;
		while (page.nextOffset !== null) {
			page = await output(messages, { offset: page.nextOffset, limit: 7 });
			expect(page.revision).toBe(newest.revision);
		}
		expect((await output(messages, { limit: 500 })).revision).toBe(newest.revision);
		// Any change anywhere changes it, even when the newest page is identical.
		const olderRewrite = messages.map((message, index) => index === 0 ? { ...message, content: [{ type: "text", text: "line 0\nMORE 0" }] } : message);
		const rewritten = await output(olderRewrite, { limit: 7 });
		expect({ ...rewritten, revision: undefined }).toEqual({ ...newest, revision: undefined });
		expect(rewritten.revision).not.toBe(newest.revision);
		const renamed = messages.map((message, index) => index === 0 ? { ...message, id: "other" } : message);
		expect((await output(renamed, { limit: 7 })).revision).not.toBe(newest.revision);
		expect((await output(messages.slice(1), { limit: 7 })).revision).not.toBe(newest.revision);
		// Segment boundaries are part of the identity: moving text between segments changes it.
		const a = await output([text("user", "ab"), text("user", "c")]);
		const b = await output([text("user", "a"), text("user", "bc")]);
		expect(a.revision).not.toBe(b.revision);
	});

	test("revision follows a live child's streaming message", async () => {
		const messages = [text("user", "prompt", 1)];
		const before = await readAgentOutput(live(messages, text("assistant", "Work", 2)), { agentId: "child" }, {}, noDisk, SCOPE);
		const after = await readAgentOutput(live(messages, text("assistant", "Working", 2)), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(after.revision).not.toBe(before.revision);
		const again = await readAgentOutput(live(messages, text("assistant", "Working", 2)), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(again.revision).toBe(after.revision);
	});

	test("revision encoding is injective over UTF-16 code units", async () => {
		const revision = async (messages: Message[]) => (await output(messages)).revision;
		// Distinct lone surrogates are distinct transcripts; content is never normalized.
		expect(await revision([text("user", "\ud800")])).not.toBe(await revision([text("user", "\ud801")]));
		expect(await revision([text("user", "a\ud800")])).not.toBe(await revision([text("user", "a\ufffd")]));
		expect(await revision([{ ...text("user", "x"), id: "\ud800" }])).not.toBe(await revision([{ ...text("user", "x"), id: "\ud801" }]));
		// Astral characters count as two units in both the length prefix and the hashed text.
		expect(await revision([text("user", "😀"), text("user", "a")])).not.toBe(await revision([text("user", "😀a")]));
		// Text longer than one hash slice, with a surrogate pair split across the slice boundary.
		const long = `${"a".repeat(64 * 1024 - 1)}😀${"b".repeat(100_000)}`;
		expect(await revision([text("user", long)])).toBe(await revision([text("user", long)]));
		// Independent reference: the documented encoding hashed in one unsliced buffer.
		const message = new Bun.CryptoHasher("sha256");
		message.update(Buffer.from(JSON.stringify(["long", "user", null, 100, long.length]), "utf16le"));
		message.update(Buffer.from(long, "utf16le"));
		const reference = new Bun.CryptoHasher("sha256").update(message.digest()).digest("hex");
		expect(await revision([{ ...text("user", long), id: "long" }])).toBe(`sha256:${reference}`);
		expect(await revision([text("user", long)])).not.toBe(await revision([text("user", `${long.slice(0, -1)}c`)]));
		expect(await revision([text("user", long)])).not.toBe(await revision([text("user", long.replace("😀", "😁"))]));
	});

	test("live revisions rehash only changed messages across a page walk", async () => {
		// About 4 MB of visible text in 2000 messages: 60+ pages of 64 KiB.
		const body = "x".repeat(2000);
		const messages: Message[] = Array.from({ length: 2000 }, (_, index) => ({ ...text(index % 2 ? "assistant" : "user", `${index} ${body}`, 1000 + index), id: `m${index}` }));
		const ref = live(messages);
		const digests = revisionWork.messageDigests;
		let result = await readAgentOutput(ref, { agentId: "child", limit: 500 }, {}, noDisk, SCOPE);
		const revision = result.revision;
		let reads = 1;
		while (result.nextOffset !== null) {
			result = await readAgentOutput(ref, { agentId: "child", offset: result.nextOffset, limit: 500 }, {}, noDisk, SCOPE);
			expect(result.revision).toBe(revision);
			reads++;
		}
		expect(reads).toBeGreaterThanOrEqual(30);
		// Each message is hashed once for the whole walk, not once per page.
		expect(revisionWork.messageDigests - digests).toBe(messages.length);
		// A streaming update rehashes only the streaming message.
		const streaming = await readAgentOutput(live(messages, text("assistant", "Draft", 9000)), { agentId: "child" }, {}, noDisk, SCOPE);
		const longer = await readAgentOutput(live(messages, text("assistant", "Draft more", 9000)), { agentId: "child" }, {}, noDisk, SCOPE);
		expect(revisionWork.messageDigests - digests).toBe(messages.length + 2);
		expect(new Set([revision, streaming.revision, longer.revision]).size).toBe(3);
		// An in-place rewrite of an older message is detected, not trusted from object identity.
		(messages[3]!.content as Message[])[0]!.text = "rewritten";
		expect((await readAgentOutput(ref, { agentId: "child", limit: 500 }, {}, noDisk, SCOPE)).revision).not.toBe(revision);
		expect(revisionWork.messageDigests - digests).toBe(messages.length + 3);
	});

	test("parked revisions reuse digests only for content compared equal", async () => {
		const body = "y".repeat(1500);
		let source: Message[] = Array.from({ length: 2000 }, (_, index) => ({ ...text("assistant", `${index} ${body}`, 1000 + index), id: `p${index}` }));
		// Each native load returns fresh message objects, as reloading a file does.
		const api = {
			async loadSessionMessagesReadOnly() { return structuredClone(source); },
			async loadEntriesFromFile() { return []; },
		};
		// The transcript file's metadata never changes in this test: nothing may be trusted from it.
		const readChild = async <T>(_ref: AgentRef, loader: (file: string) => Promise<T>): Promise<T> => loader("/canonical/child.jsonl");
		const ref = parked();
		const digests = revisionWork.messageDigests;
		let result = await readAgentOutput(ref, { agentId: "child", limit: 500 }, api, readChild, SCOPE);
		const revision = result.revision;
		let reads = 1;
		while (result.nextOffset !== null && reads < 40) {
			result = await readAgentOutput(ref, { agentId: "child", offset: result.nextOffset, limit: 500 }, api, readChild, SCOPE);
			expect(result.revision).toBe(revision);
			reads++;
		}
		expect(reads).toBeGreaterThanOrEqual(30);
		// The first read hashes every message; later reads only compare.
		expect(revisionWork.messageDigests - digests).toBe(source.length);
		// A same-size rewrite with an identical file stamp still changes the revision,
		// and only the rewritten message is hashed again.
		const original = source;
		source = source.map((message, index) => index === 7 ? { ...message, content: [{ type: "text", text: `7 ${"z".repeat(1500)}` }] } : message);
		const rewritten = await readAgentOutput(ref, { agentId: "child" }, api, readChild, SCOPE);
		expect(rewritten.revision).not.toBe(revision);
		expect(revisionWork.messageDigests - digests).toBe(source.length + 1);
		source = original;
		expect((await readAgentOutput(ref, { agentId: "child" }, api, readChild, SCOPE)).revision).toBe(revision);
		expect(revisionWork.messageDigests - digests).toBe(source.length + 2);
		// An append hashes only the new message.
		source = [...original, { ...text("assistant", "appended", 9000), id: "tail" }];
		expect((await readAgentOutput(ref, { agentId: "child" }, api, readChild, SCOPE)).revision).not.toBe(revision);
		expect(revisionWork.messageDigests - digests).toBe(original.length + 3);
	});

	test("parked digest cache is bounded by child count and skips empty transcripts", async () => {
		const readChild = async <T>(_ref: AgentRef, loader: (file: string) => Promise<T>): Promise<T> => loader("/canonical/child.jsonl");
		const read = (ref: AgentRef, messages: Message[]) => readAgentOutput(ref, { agentId: "child" }, {
			async loadSessionMessagesReadOnly() { return structuredClone(messages); },
			async loadEntriesFromFile() { return []; },
		}, readChild, SCOPE);
		// Empty and hidden-only transcripts retain nothing, however many children there are.
		const before = snapshotUsage();
		for (let index = 0; index < 3000; index++) {
			await read(parked(), index % 2 ? [] : [{ role: "system", content: "hidden", timestamp: 1 }, { role: "custom", content: "x", display: false, timestamp: 2 }]);
		}
		expect(snapshotUsage()).toEqual(before);
		// At most 1024 children are retained, least recently read evicted first.
		const refs = Array.from({ length: 1100 }, () => parked());
		for (const [index, ref] of refs.entries()) await read(ref, [text("assistant", `child ${index}`)]);
		expect(snapshotUsage().children).toBe(1024);
		const digests = revisionWork.messageDigests;
		await read(refs[refs.length - 1]!, [text("assistant", `child ${refs.length - 1}`)]);
		expect(revisionWork.messageDigests).toBe(digests);
		await read(refs[0]!, [text("assistant", "child 0")]);
		expect(revisionWork.messageDigests).toBe(digests + 1);
		expect(snapshotUsage().children).toBe(1024);
		// Metadata counts toward the budget: each child costs more than its text.
		expect(snapshotUsage().cost).toBeGreaterThan(1024 * 256);
	});

	test("parked digest cache is bounded by retained text and metadata", async () => {
		const readChild = async <T>(_ref: AgentRef, loader: (file: string) => Promise<T>): Promise<T> => loader("/canonical/child.jsonl");
		const read = (ref: AgentRef, messages: Message[]) => readAgentOutput(ref, { agentId: "child" }, {
			async loadSessionMessagesReadOnly() { return structuredClone(messages); },
			async loadEntriesFromFile() { return []; },
		}, readChild, SCOPE);
		const saved = { ...snapshotLimits };
		snapshotLimits.units = 10_000;
		try {
			// Each child costs about 3100 units with its overheads: three fit, a fourth evicts the oldest.
			const body = (index: number) => [text("assistant", `${index} ${"t".repeat(2500)}`)];
			const refs = Array.from({ length: 4 }, () => parked());
			for (const [index, ref] of refs.entries()) await read(ref, body(index));
			expect(snapshotUsage().children).toBe(3);
			expect(snapshotUsage().cost).toBeLessThanOrEqual(10_000);
			const digests = revisionWork.messageDigests;
			await read(refs[3]!, body(3));
			expect(revisionWork.messageDigests).toBe(digests);
			await read(refs[0]!, body(0));
			expect(revisionWork.messageDigests).toBe(digests + 1);
			// Repeated reads of a cached child do not inflate its cost.
			const cost = snapshotUsage().cost;
			for (let index = 0; index < 5; index++) await read(refs[0]!, body(0));
			expect(snapshotUsage().cost).toBe(cost);
			expect(revisionWork.messageDigests).toBe(digests + 1);
			// A child over the budget on its own is never retained.
			const huge = parked();
			const hugeBody = [text("assistant", "h".repeat(20_000))];
			await read(huge, hugeBody);
			await read(huge, hugeBody);
			expect(revisionWork.messageDigests).toBe(digests + 3);
			expect(snapshotUsage().cost).toBe(cost);
			// Span metadata counts too: many tiny segments cost far more than their text.
			const many = parked();
			await read(many, Array.from({ length: 100 }, (_, index) => ({ ...text("assistant", "x", index), id: `segment-${index}` })));
			expect(snapshotUsage().cost).toBeLessThanOrEqual(10_000);
			expect(snapshotUsage().cost).toBeGreaterThan(100 * 64);
		} finally {
			Object.assign(snapshotLimits, saved);
		}
	});

	test("frozen reads serve one revision's older pages while a live child keeps streaming", async () => {
		const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({ ...text("assistant", `line ${index}`, 100 + index), id: `m${index}` }));
		// The same live session object throughout, with a stream that moves on.
		const state: { streamMessage: Message | null } = { streamMessage: { ...text("assistant", "Draft", 900), id: "stream" } };
		const ref = { id: "child", kind: "sub", session: { messages, agent: { state }, sessionManager: { getBranch: () => [] } } } as unknown as AgentRef;
		const read = (params: Partial<AgentOutputParams>) => readAgentOutput(ref, { agentId: "child", limit: 7, ...params }, {}, noDisk, SCOPE);
		const newest = await read({});
		const expected = (await read({ limit: 500 })).text;
		// The stream moves on after the newest page was read, before every older page.
		state.streamMessage = { ...text("assistant", "Draft and more", 900), id: "stream" };
		const moved = await read({});
		expect(moved.revision).not.toBe(newest.revision);
		let assembled = newest.text;
		let next = newest.nextOffset;
		while (next !== null) {
			const older = await read({ offset: next, revision: newest.revision! });
			expect(older.revision).toBe(newest.revision);
			assembled = `${older.text}\n${assembled}`;
			next = older.nextOffset;
		}
		// The frozen pages reassemble exactly the transcript the newest page was cut from.
		expect(assembled).toBe(expected);
	});

	test("frozen reads of parked children never reload the transcript", async () => {
		const prompt = text("user", Array.from({ length: 30 }, (_, index) => `prompt ${index}`).join("\n"), 100);
		const h = diskHarness([prompt], []);
		const ref = parked();
		const newest = await readAgentOutput(ref, { agentId: "child", limit: 5 }, h.api, h.readChild, SCOPE);
		const loads = h.calls.length;
		const older = await readAgentOutput(ref, { agentId: "child", limit: 5, offset: newest.nextOffset!, revision: newest.revision! }, h.api, h.readChild, SCOPE);
		expect(older.revision).toBe(newest.revision);
		expect(older.text).toBe(Array.from({ length: 5 }, (_, index) => `prompt ${20 + index}`).join("\n"));
		expect(h.calls.length).toBe(loads);
	});

	test("an evicted or unknown revision is reported as snapshot_expired", async () => {
		const messages: Message[] = [{ ...text("assistant", "a\nb\nc", 1), id: "m" }];
		const ref = live(messages, null);
		const first = await readAgentOutput(ref, { agentId: "child", limit: 1 }, {}, noDisk, SCOPE);
		await expect(readAgentOutput(ref, { agentId: "child", limit: 1, offset: 2, revision: "sha256:unknown" }, {}, noDisk, SCOPE)).rejects.toMatchObject({ body: { code: "snapshot_expired" } });
		// Two newer revisions push the first out of the per-child limit.
		for (const tail of ["d", "e"]) {
			messages.push({ ...text("assistant", tail, 2), id: `t${tail}` });
			await readAgentOutput(ref, { agentId: "child", limit: 1 }, {}, noDisk, SCOPE);
		}
		await expect(readAgentOutput(ref, { agentId: "child", limit: 1, offset: first.nextOffset!, revision: first.revision! }, {}, noDisk, SCOPE)).rejects.toMatchObject({ body: { code: "snapshot_expired" } });
		for (const revision of ["", "r".repeat(257), 7, null]) {
			await expect(readAgentOutput(ref, { agentId: "child", revision } as AgentOutputParams, {}, noDisk, SCOPE)).rejects.toMatchObject({ body: { code: "bad_request" } });
		}
	});

	test("malformed pagination fails before live or parked reads", async () => {
		for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
			const h = diskHarness([]);
			await expect(readAgentOutput(parked(), { agentId: "child", offset } as AgentOutputParams, h.api, h.readChild, SCOPE)).rejects.toMatchObject({ body: { code: "bad_request" } });
			expect(h.calls).toEqual([]);
			expect(h.reads).toEqual([]);
		}
		for (const limit of [-1, 0, 501, 1.5, NaN, Infinity, "2", null]) {
			await expect(output([], { limit } as Partial<AgentOutputParams>)).rejects.toMatchObject({ body: { code: "bad_request" } });
		}
	});

	test("missing read-only API fails explicitly without calling the wrapper", async () => {
		await expect(readAgentOutput(parked(), { agentId: "child" }, {}, noDisk, SCOPE)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output", reason: "export_missing" } });
		const h = diskHarness([]);
		await expect(readAgentOutput(parked(), { agentId: "child" }, { ...h.api, loadSessionMessagesReadOnly: async () => ({}) }, h.readChild, SCOPE)).rejects.toBeInstanceOf(BridgeError);
		await expect(readAgentOutput(parked(), { agentId: "child" }, { ...h.api, loadEntriesFromFile: async () => ({}) }, h.readChild, SCOPE)).rejects.toBeInstanceOf(BridgeError);
	});

	test("missing live messages or streaming API fails rather than returning an empty fallback", async () => {
		for (const session of [{ agent: { state: { streamMessage: null } } }, { messages: [] }]) {
			const ref = { id: "child", session } as unknown as AgentRef;
			await expect(readAgentOutput(ref, { agentId: "child" }, {}, noDisk, SCOPE)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output" } });
		}
	});

	test("canonical read rejection propagates without bypassing the driver", async () => {
		const h = diskHarness([]);
		const rejectedRead = async <T>(_ref: AgentRef, _loader: (file: string) => Promise<T>): Promise<T> => { throw new BridgeError("stale_session", "ownership changed"); };
		await expect(readAgentOutput(parked(), { agentId: "child" }, h.api, rejectedRead, SCOPE)).rejects.toMatchObject({ body: { code: "stale_session" } });
		expect(h.calls).toEqual([]);
	});
});

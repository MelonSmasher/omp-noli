import { describe, expect, test } from "bun:test";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent";
import { readAgentOutput } from "../src/agent-output";
import { BridgeError } from "../src/bridge";
import type { AgentOutputParams } from "../src/protocol";

type Message = Record<string, unknown>;
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
	return readAgentOutput(live(messages), { agentId: "child", ...params }, {}, noDisk);
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
		const result = await readAgentOutput(live(messages, partial), { agentId: "child" }, {}, noDisk);
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
		const result = await readAgentOutput(live([message], message), { agentId: "child" }, {}, noDisk);
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
		const result = await readAgentOutput(ref, { agentId: "child" }, h.api, h.readChild);
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
		const result = await readAgentOutput(live([first, reply], null, [entry("u", null, first), entry("a", "u", reply)]), { agentId: "child" }, {}, noDisk);
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
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild);
		expect(result.text).toBe("visible");
		expect(result.spans[0]?.id).toBe("visible-id");
	});

	test("compacted same-timestamp messages keep their own entry IDs rather than positional IDs", async () => {
		const old = text("assistant", "old", 100);
		const kept = text("assistant", "kept", 100);
		const h = diskHarness([kept], [entry("old-id", null, old), entry("kept-id", "old-id", kept)]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild);
		expect(result.spans[0]?.id).toBe("kept-id");
	});

	test("entry parent cycles terminate without inventing abandoned content", async () => {
		const h = diskHarness([text("assistant", "answer")], [entry("a", "b", text("assistant", "answer")), { type: "model_change", id: "b", parentId: "a" }]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild);
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
		await expect(readAgentOutput(parked(), { agentId: "child" }, { loadSessionMessagesReadOnly: h.api.loadSessionMessagesReadOnly }, h.readChild)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output", reason: "export_missing" } });
		expect(h.calls).toEqual([]);
		expect(h.reads).toEqual([]);
	});

	test("native message and block IDs win over entry IDs", async () => {
		const message = { ...text("assistant", "answer", 222), id: "message-id", responseId: "response-id" };
		const h = diskHarness([message], [entry("entry-id", null, message)]);
		const result = await readAgentOutput(parked(), { agentId: "child" }, h.api, h.readChild);
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
		expect(await output([])).toEqual({ agentId: "child", text: "", spans: [], nextOffset: null });
		expect(await output([text("assistant", "one\ntwo")], { offset: 0 })).toEqual({ agentId: "child", text: "", spans: [], nextOffset: null });
		const result = await output([text("assistant", "one\ntwo")], { offset: Number.MAX_SAFE_INTEGER, limit: 1 });
		expect(result.text).toBe("two");
		expect(result.nextOffset).toBe(1);
	});

	test("malformed pagination fails before live or parked reads", async () => {
		for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
			const h = diskHarness([]);
			await expect(readAgentOutput(parked(), { agentId: "child", offset } as AgentOutputParams, h.api, h.readChild)).rejects.toMatchObject({ body: { code: "bad_request" } });
			expect(h.calls).toEqual([]);
			expect(h.reads).toEqual([]);
		}
		for (const limit of [-1, 0, 501, 1.5, NaN, Infinity, "2", null]) {
			await expect(output([], { limit } as Partial<AgentOutputParams>)).rejects.toMatchObject({ body: { code: "bad_request" } });
		}
	});

	test("missing read-only API fails explicitly without calling the wrapper", async () => {
		await expect(readAgentOutput(parked(), { agentId: "child" }, {}, noDisk)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output", reason: "export_missing" } });
		const h = diskHarness([]);
		await expect(readAgentOutput(parked(), { agentId: "child" }, { ...h.api, loadSessionMessagesReadOnly: async () => ({}) }, h.readChild)).rejects.toBeInstanceOf(BridgeError);
		await expect(readAgentOutput(parked(), { agentId: "child" }, { ...h.api, loadEntriesFromFile: async () => ({}) }, h.readChild)).rejects.toBeInstanceOf(BridgeError);
	});

	test("missing live messages or streaming API fails rather than returning an empty fallback", async () => {
		for (const session of [{ agent: { state: { streamMessage: null } } }, { messages: [] }]) {
			const ref = { id: "child", session } as unknown as AgentRef;
			await expect(readAgentOutput(ref, { agentId: "child" }, {}, noDisk)).rejects.toMatchObject({ body: { code: "capability_unavailable", capability: "agents.output" } });
		}
	});

	test("canonical read rejection propagates without bypassing the driver", async () => {
		const h = diskHarness([]);
		const rejectedRead = async <T>(_ref: AgentRef, _loader: (file: string) => Promise<T>): Promise<T> => { throw new BridgeError("stale_session", "ownership changed"); };
		await expect(readAgentOutput(parked(), { agentId: "child" }, h.api, rejectedRead)).rejects.toMatchObject({ body: { code: "stale_session" } });
		expect(h.calls).toEqual([]);
	});
});

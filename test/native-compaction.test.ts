import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";
import { DateCwdReminderInjector } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { ReactiveLadder, TRUNCATION_NOTE, apiRounds, compactionPrompt, foldReminderBeforeSummary, formatSummary, nativeSummaryText, promptTooLongGap, renderNativeSummaries, toolNamesUsed } from "../src/native-compaction";

type AgentMessage = ContextEvent["messages"][number];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Minimal synthetic shapes: only the fields the compaction helpers read (role, content, timestamp, stopReason).
const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp }) as unknown as AgentMessage;
const read = (id: string, timestamp: number) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }], stopReason: "toolUse", timestamp }) as unknown as AgentMessage;
const result = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `1\t${id}` }], timestamp }) as unknown as AgentMessage;
const answer = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp }) as unknown as AgentMessage;
const truncationRow = () => ({ role: "developer", content: TRUNCATION_NOTE, attribution: "user", timestamp: 0 }) as unknown as AgentMessage;

// Native oracle captures (official CC 2.1.309, .capture/analysis/full-parity/native-oracle/captures/).
const REPLY = "<analysis>\nSynthetic analysis of the offline fixture conversation.\n</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Read the fixture files and reply with offline-fixture.\n\n8. Current Work:\n   Reading fixture files.\n</summary>";

describe("native compaction prompt (spec §3, captures compact-reactive-ptl / compact-manual)", () => {
	test("control arm bytes match the native fork prompt", () => {
		expect(sha(compactionPrompt(undefined))).toBe("63e2bfb4ded280d5057a66d8a034ef352a73960d97d955b990e78f04f0db1fb0");
		expect(compactionPrompt(undefined).length).toBe(6361);
		// Blank instructions are not spliced (`eve`).
		expect(compactionPrompt("  ")).toBe(compactionPrompt(undefined));
	});
	test("custom instructions splice untrimmed before the reminder tail", () => {
		expect(sha(compactionPrompt("CUSTOM_INSTRUCTIONS"))).toBe("d288cae597b6a4b25ebacdacacf0348edd8465167a7bd43cfe9a4921e8aa5898");
		expect(sha(compactionPrompt("Focus on the fixture file names."))).toBe("5d134b0e85e2902434b714e22317c93c6e4ffb1585e7f8412cd23f9581c1e877");
		// Surrounding whitespace is kept verbatim; only `/compact` trims its arguments before splicing.
		expect(compactionPrompt("  Focus.\n")).toBe(compactionPrompt(undefined).replace(/\n\nREMINDER:/, "\n\nAdditional Instructions:\n  Focus.\n\n\nREMINDER:"));
	});
});

describe("post-compaction summary row (spec §7.2)", () => {
	test("nee() with kept tail matches the native retry's summary text minus the transcript sentence", () => {
		const text = nativeSummaryText({ reply: REPLY, toolNames: ["Read"], headTruncated: false, keptTail: true });
		expect(text.startsWith("This session is being continued from a previous conversation that ran out of context.")).toBe(true);
		expect(text).toContain("<tools-used-before-summary>Read</tools-used-before-summary>\nSummary:\n1. Primary Request and Intent:");
		expect(text).not.toContain("full transcript");
		expect(text.endsWith("Pick up the last task as if the break never happened.\n\nThe messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.")).toBe(true);
	});
	test("spec §7.2 rendered vector with a transcript path", () => {
		const text = nativeSummaryText({ reply: "<analysis>x</analysis>\n<summary>\nS1\n\n\n\nS2\n</summary>", toolNames: ["Bash", "Read"], transcriptPath: "/TP.jsonl", headTruncated: false, keptTail: false });
		expect(sha(text)).toBe("aed8be86820312b0d75ed068f4690623aec25530179eab5faa85889d1feb844a");
		expect(formatSummary("<summary> S </summary>")).toBe("Summary:\nS");
	});
	test("tool names are wire names plus an earlier summary's, filtered and sorted", () => {
		expect(toolNamesUsed([read("a", 1), read("b", 2)], name => `_${name}`, ["Bash", "bad,name"])).toEqual(["Bash", "_read"]);
	});
	test("native summaries render as user rows carrying the summary as one text block; other messages keep their identity", () => {
		const summary = { role: "compactionSummary", summary: "nee text", tokensBefore: 1, timestamp: 5 } as AgentMessage;
		const other = user("x", 6);
		const rendered = renderNativeSummaries([summary, other], new Map([["5\0nee text", { v: 1, kind: "manual", toolNames: [] }]]));
		expect(rendered[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "nee text" }] });
		expect(rendered[1]).toBe(other);
		const untouched = [summary, other];
		expect(renderNativeSummaries(untouched, new Map())).toBe(untouched);
	});
	test("OMP's date/cwd reminder stays its own block and gets CC's row-boundary newline (compact-subagent@a #10)", () => {
		const summary = nativeSummaryText({ reply: REPLY, toolNames: ["Read"], headTruncated: false, keptTail: true });
		const row = { role: "compactionSummary", summary, tokensBefore: 1, timestamp: 5 } as AgentMessage;
		const [rendered] = renderNativeSummaries([row], new Map([[`5\0${summary}`, { v: 1, kind: "reactive", toolNames: ["Read"] }]]));
		// The stock injector, as OMP runs it on every provider request.
		const injected = new DateCwdReminderInjector().transform({ systemPrompt: ["system"], messages: [rendered] } as Parameters<DateCwdReminderInjector["transform"]>[0], "2026-10-30", "/project").messages;
		const blocks = injected[0]!.content as Array<{ type: string; text: string }>;
		expect(blocks.map(block => block.text)).toEqual(["<system-reminder>\nToday: 2026-10-30; current working directory: '/project'. Do not repeat this information in your reply.\n</system-reminder>", summary]);
		const wire = [{ role: "user", content: blocks.map(block => ({ ...block })) }, { role: "assistant", content: [{ type: "text", text: "a" }] }];
		const folded = foldReminderBeforeSummary(wire, new Set([summary]));
		expect(folded).toEqual([{ role: "user", content: [{ type: "text", text: `${blocks[0]!.text}\n` }, { type: "text", text: summary }] }, wire[1]]);
		// Applied once: a reminder that already ends the row, a non-native first text, string content and other roles stay.
		expect(foldReminderBeforeSummary(folded, new Set([summary]))).toBeUndefined();
		expect(foldReminderBeforeSummary(wire, new Set(["other summary"]))).toBeUndefined();
		expect(foldReminderBeforeSummary([{ role: "user", content: `${blocks[0]!.text}\n\n${summary}` }], new Set([summary]))).toBeUndefined();
		expect(foldReminderBeforeSummary([{ role: "assistant", content: wire[0]!.content }], new Set([summary]))).toBeUndefined();
	});
});

describe("reactive message selection (`ive`)", () => {
	// compact-reactive-ptl@a: [U0, A1, U1, A2, U2(prompt), A3, U3, A4, U4] answered 213000 > 200000.
	const history = [user("u0", 1), read("f1", 2), result("f1", 3), answer("offline-fixture", 4), user("u2", 5), read("f2", 6), result("f2", 7), read("f3", 8), result("f3", 9)];
	test("the gap seeds the round ladder: only the earliest groups are summarized", () => {
		expect(apiRounds(history)).toHaveLength(5);
		const gap = promptTooLongGap('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213000 tokens > 200000 maximum"}}');
		expect(gap).toBe(13000);
		const step = new ReactiveLadder(history, gap, truncationRow).next();
		expect("attempt" in step && step.attempt.summarize).toEqual(history.slice(0, 3));
		expect("attempt" in step && step.attempt.keep).toEqual(history.slice(3));
	});
	test("a small gap summarizes all but the last round (compact-reactive-ptl-smallgap)", () => {
		const step = new ReactiveLadder(history, 1, truncationRow).next();
		expect("attempt" in step && step.attempt.summarize).toEqual(history.slice(0, 7));
	});
	test("manual and unparseable gaps keep the last round; prompt-too-long walks the ladder", () => {
		const ladder = new ReactiveLadder(history, undefined, truncationRow);
		const first = ladder.next();
		expect("attempt" in first && first.attempt.keep).toEqual(history.slice(7));
		expect(ladder.promptTooLong(undefined)).toBe(true);
		const second = ladder.next();
		expect("attempt" in second && second.attempt.keep).toEqual(history.slice(5));
	});
	test("fewer than two rounds cannot compact", () => {
		expect(new ReactiveLadder([user("only", 1)], undefined, truncationRow).next()).toEqual({ failure: "too_few_groups" });
	});
});

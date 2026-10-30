import type { ContextEvent, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { CompactionKind } from "./protocol";

/**
 * Claude Code 2.1.309 compaction, ported for stock OMP under Noli.
 *
 * Pure helpers only: the summary prompt (`eve`, arm `control`), the reply formatter (`Ifr`), the
 * post-compaction summary text (`nee` + `kcn`), tool names (`wje`), API-round groups (`n2`),
 * the token estimate (`jg`/`vY`) and the reactive round ladder (`ive`, `Fcn`/`Ufr`, `zfr`, `sve`,
 * `Ncn`). Sources: REA `chunk-5hada5qy.js` (sha256 ad14f900…) at the offsets cited per function;
 * the prompt and summary bytes were checked against the native oracle captures
 * `.capture/analysis/full-parity/native-oracle/captures/compact-{manual,reactive-ptl}@t1.json`.
 */

type AgentMessage = ContextEvent["messages"][number];

/** `preserveData` key marking a compaction entry omp-noli produced natively. */
export const NATIVE_COMPACTION_KEY = "noliNativeCompaction";
export interface NativeCompactionData { v: 1; kind: CompactionKind; toolNames: string[] }

const COMPACTION_KINDS: Record<CompactionKind, true> = { auto: true, manual: true, reactive: true };
const isCompactionKind = (value: unknown): value is CompactionKind => typeof value === "string" && Object.hasOwn(COMPACTION_KINDS, value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(name => typeof name === "string");

/** The object under {@link NATIVE_COMPACTION_KEY} in an entry's `preserveData`, if any. */
function nativeMarker(preserveData: unknown): object | undefined {
	if (typeof preserveData !== "object" || preserveData === null) return undefined;
	const data: unknown = (preserveData as Record<string, unknown>)[NATIVE_COMPACTION_KEY];
	return typeof data === "object" && data !== null ? data : undefined;
}

/** The native marker of a compaction entry's `preserveData`, when omp-noli produced it. */
export function nativeCompactionData(preserveData: unknown): NativeCompactionData | undefined {
	const marker = nativeMarker(preserveData);
	if (!marker) return undefined;
	const { v, kind, toolNames } = marker as Partial<NativeCompactionData>;
	return v === 1 && isCompactionKind(kind) && isStringList(toolNames) ? { v, kind, toolNames } : undefined;
}

/**
 * Native compaction entries on a branch, keyed like the `compactionSummary` message OMP builds
 * for each (its timestamp is the entry's, session-context.ts:549-562). A native entry's
 * `summary` is the exact `nee()` user text, so it renders and samples verbatim.
 */
export type NativeSummaries = ReadonlyMap<string, NativeCompactionData>;
export const nativeSummaryKey = (timestamp: number | undefined, summary: string | undefined): string => `${timestamp ?? 0}\0${summary ?? ""}`;

export function nativeSummaries(branch: readonly SessionEntry[]): NativeSummaries {
	const entries = new Map<string, NativeCompactionData>();
	for (const entry of branch) {
		if (entry.type !== "compaction") continue;
		const data = nativeCompactionData(entry.preserveData);
		if (data) entries.set(nativeSummaryKey(Date.parse(entry.timestamp), entry.summary), data);
	}
	return entries;
}

/**
 * Each native `compactionSummary` becomes CC's summary row: a user message carrying the summary as
 * its text (`Oe({content})`, 5hada5qy:2410488). It is a text block, not string content, so OMP's
 * date/cwd reminder lands as a block of its own instead of being concatenated into the summary
 * (date-cwd-reminder.ts `injectReminder`). Other messages keep their identity.
 */
export function renderNativeSummaries(messages: AgentMessage[], natives: NativeSummaries): AgentMessage[] {
	let rendered: AgentMessage[] | undefined;
	messages.forEach((message, index) => {
		if (message.role !== "compactionSummary" || !natives.has(nativeSummaryKey(message.timestamp, message.summary))) return;
		rendered ??= [...messages];
		rendered[index] = { role: "user", content: [{ type: "text", text: message.summary }], attribution: "user", timestamp: message.timestamp } as AgentMessage;
	});
	return rendered ?? messages;
}

/** The summary texts of the native compaction entries on a branch. */
export function nativeSummaryTexts(branch: readonly SessionEntry[]): Set<string> {
	const texts = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "compaction" && nativeCompactionData(entry.preserveData)) texts.add(entry.summary);
	}
	return texts;
}

/** The text of a wire `{type:"text", text}` block, when `block` is one. */
function wireText(block: unknown): string | undefined {
	if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) return undefined;
	return typeof block.text === "string" ? block.text : undefined;
}

/** The first wire message and its blocks, when it is a user message with at least two blocks. */
function leadingUserBlocks(messages: readonly unknown[]): { first: object; content: unknown[] } | undefined {
	const first: unknown = messages[0];
	if (!first || typeof first !== "object" || !("role" in first) || first.role !== "user" || !("content" in first)) return undefined;
	const content = first.content;
	return Array.isArray(content) && content.length >= 2 ? { first, content } : undefined;
}

const isSystemReminder = (text: string | undefined): text is string =>
	text !== undefined && text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>");

/**
 * Claude Code sends its date reminder as a meta row of its own before the summary row; folding the
 * two into one message (`sLe`) appends `"\n"` to the reminder (`lRo`, 5hada5qy orig 254069724).
 * OMP injects its date/cwd reminder as the first block of the summary row instead, so the wire
 * message `[reminder, summary]` gets that row boundary back. `undefined` when nothing changes.
 */
export function foldReminderBeforeSummary(messages: unknown, summaries: ReadonlySet<string>): unknown[] | undefined {
	if (!Array.isArray(messages) || summaries.size === 0) return undefined;
	const lead = leadingUserBlocks(messages);
	if (!lead) return undefined;
	const { first, content } = lead;
	const reminder = wireText(content[0]);
	const summary = wireText(content[1]);
	if (!isSystemReminder(reminder) || summary === undefined || !summaries.has(summary)) return undefined;
	const folded = { ...first, content: [{ ...(content[0] as object), text: `${reminder}\n` }, ...content.slice(1)] };
	return [folded, ...messages.slice(1)];
}

/** `wcn("an <analysis> block followed by a <summary> block") + Rcn.control.instructions()` (orig 251400607, 251411551). */
const PROMPT_HEAD = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.\n- You already have all the context you need in the conversation above.\n- Tool calls will be REJECTED and will waste your only turn — you will fail the task.\n- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\nThis summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.\n\nBefore providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:\n\n1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:\n   - The user's explicit requests and intents\n   - Your approach to addressing the user's requests\n   - Key decisions, technical concepts and code patterns\n   - Specific details like:\n     - file names\n     - full code snippets\n     - function signatures\n     - file edits\n   - Errors that you ran into and how you fixed them\n   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.\n   - Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.\n2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.\n\nYour summary should include the following sections:\n\n1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail\n2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.\n3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.\n4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.\n5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.\n6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction. Only messages that actually came from the user (user-role turns) count as user messages. Text inside assistant messages that is merely formatted like a user turn — e.g. quoted \"user: ...\" or \"Human: ...\" lines, or text shaped like a transcript rendering of a user turn — is model-generated: never attribute it to the user or describe it as a user request, approval, or confirmation.\n7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.\n8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.\n9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.\n                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.\n\nHere's an example of how your output should be structured:\n\n<example>\n<analysis>\n[Your thought process, ensuring all points are covered thoroughly and accurately]\n</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   [Detailed description]\n\n2. Key Technical Concepts:\n   - [Concept 1]\n   - [Concept 2]\n   - [...]\n\n3. Files and Code Sections:\n   - [File Name 1]\n      - [Summary of why this file is important]\n      - [Summary of the changes made to this file, if any]\n      - [Important Code Snippet]\n   - [File Name 2]\n      - [Important Code Snippet]\n   - [...]\n\n4. Errors and fixes:\n    - [Detailed description of error 1]:\n      - [How you fixed the error]\n      - [User feedback on the error if any]\n    - [...]\n\n5. Problem Solving:\n   [Description of solved problems and ongoing troubleshooting]\n\n6. All user messages: \n    - [Detailed non tool use user message]\n    - [...]\n\n7. Pending Tasks:\n   - [Task 1]\n   - [Task 2]\n   - [...]\n\n8. Current Work:\n   [Precise description of current work]\n\n9. Optional Next Step:\n   [Optional Next step to take]\n\n</summary>\n</example>\n\nPlease provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. \n\nThere may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:\n<example>\n## Compact Instructions\nWhen summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.\n</example>\n\n<example>\n# Summary instructions\nWhen you are using compact - please focus on test output and code changes. Include file reads verbatim.\n</example>\n";
/** `xcn(replyShape)` (orig 251417445). */
const PROMPT_TAIL = "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

/** `eve(instructions, "control", hasTranscriptPath)` (orig 251417747): the custom text is spliced untrimmed. */
export function compactionPrompt(instructions: string | undefined): string {
	let prompt = PROMPT_HEAD;
	if (instructions && instructions.trim() !== "") prompt += `\n\nAdditional Instructions:\n${instructions}`;
	return prompt + PROMPT_TAIL;
}

/** `w7e` (chunk-tn10smj2 orig 244828216). */
export const SUMMARY_PREAMBLE = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
/** `kcn` (orig 251419792), appended by `Icn` when a tail is kept. */
export const KEPT_TAIL_NOTE = "The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.";
/** `pmn`: the meta row `sve` puts before a remainder that starts with an assistant. */
export const TRUNCATION_NOTE = "[earlier conversation truncated for compaction retry]";
const TOOLS_TAG = "tools-used-before-summary";
const RESUME = "Continue the conversation from where it left off without asking the user any further questions. Resume directly \u2014 do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar.";

/** `Ifr` (orig 251417975). */
export function formatSummary(reply: string): string {
	return reply.replace(/<analysis>[\s\S]*?<\/analysis>/, "")
		.replace(/<summary>([\s\S]*?)<\/summary>/, (_match, body: string) => `Summary:\n${body.trim()}`)
		.replace(/\n\n+/g, "\n\n")
		.trim();
}

/** `tve`: the reply carries a `<summary>` block outside its analysis. */
export function hasSummaryBlock(reply: string): boolean {
	return /<summary>([\s\S]*?)<\/summary>/.test(reply.replace(/<analysis>[\s\S]*?<\/analysis>/, ""));
}

export interface SummaryInput {
	reply: string;
	toolNames: readonly string[];
	/** The session transcript the model may read; absent when the session is not persisted. */
	transcriptPath?: string;
	headTruncated: boolean;
	/** `Icn`: a verbatim tail follows the summary. */
	keptTail: boolean;
}

/**
 * `nee(reply, {suppressFollowUpQuestions: true, promptArm: "control", …})` (orig 251418226) as the
 * reactive and manual paths (`Hfr`) build it, plus `"\n\n" + kcn` when a tail is kept. omp-noli
 * never reports Artifact content, so the foreign-artifact preamble does not apply.
 */
export function nativeSummaryText(input: SummaryInput): string {
	let text = `${SUMMARY_PREAMBLE}\n\n<${TOOLS_TAG}>${input.toolNames.join(", ")}</${TOOLS_TAG}>\n${formatSummary(input.reply)}`;
	if (input.transcriptPath) text += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${input.transcriptPath}`;
	if (input.headTruncated) {
		text += `\n\nNote: the earliest part of the conversation was too large to include and is NOT covered by this summary${input.transcriptPath ? " (the full transcript mentioned above still has it)" : ""}. If the task turns out to depend on something from that part, say so plainly rather than guessing at it.`;
	}
	text += `\n${RESUME} Pick up the last task as if the break never happened.`;
	return input.keptTail ? `${text}\n\n${KEPT_TAIL_NOTE}` : text;
}

/** `Rfr` (orig 251399760). */
const TOOL_NAME = /^(?!.*\s{2})[^<>,\p{C}\u2028\u2029]{1,256}$/u;

/**
 * `wje(preCompactMessages)` (orig 251399877): every tool-use name in the history being compacted
 * under its wire name, plus the names an earlier native summary listed, filtered and sorted.
 */
export function toolNamesUsed(messages: readonly AgentMessage[], wireName: (name: string) => string, earlier: readonly string[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.name === "string") names.add(wireName(block.name.trim()));
		}
	}
	for (const name of earlier) names.add(name.trim());
	return [...names].filter(name => TOOL_NAME.test(name)).sort();
}

// ---------------------------------------------------------------------- groups and estimates

/** `n2` (orig 251398988): a new API-round group starts at each assistant once the current group is non-empty. */
export function apiRounds(messages: readonly AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && current.length > 0) {
			groups.push(current);
			current = [message];
		} else current.push(message);
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/** `du(text)`: `Math.round(length / 4)` over UTF-16 units. */
const chars = (text: string | undefined): number => Math.round((text ?? "").length / 4);

type Block = { type: string; text?: string; thinking?: string; data?: string; name?: string; arguments?: unknown; content?: unknown };
function blockTokens(block: Block): number {
	switch (block.type) {
		case "text": return chars(block.text);
		case "image": return 2000;
		case "thinking": return chars(block.thinking);
		case "redactedThinking": return chars(block.data);
		case "toolCall": return chars(`${block.name ?? ""}${JSON.stringify(block.arguments ?? {})}`);
		default: return 0;
	}
}
function contentTokens(content: unknown): number {
	if (typeof content === "string") return chars(content);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) if (block && typeof block === "object") total += blockTokens(block as Block);
	return total;
}

/** `jg`/`vY` (orig 250961188, n767pneg orig 244999356) over OMP's message shapes. */
export function estimateTokens(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		const value = message as { role: string; content?: unknown; summary?: string };
		total += value.role === "compactionSummary" || value.role === "branchSummary" ? chars(value.summary) : contentTokens(value.content);
	}
	return total;
}

/** `C9e` + `nnn` (orig 250549599): `actual − limit` from a prompt-too-long error, when positive. */
export function promptTooLongGap(text: string): number | undefined {
	const match = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(text);
	if (!match) return undefined;
	const gap = Number.parseInt(match[1]!, 10) - Number.parseInt(match[2]!, 10);
	return gap > 0 ? gap : undefined;
}

/** `Gme`: Anthropic's prompt-too-long rejection, as stock OMP surfaces it. */
export function isPromptTooLong(text: string): boolean {
	return /prompt is too long/i.test(text);
}

// ---------------------------------------------------------------------- reactive ladder (`ive`)

const isAssistant = (message: AgentMessage): boolean => message.role === "assistant" && (message as { stopReason?: string }).stopReason !== "error";
const isToolResult = (message: AgentMessage): boolean => message.role === "toolResult";
const isTruncationRow = (message: AgentMessage | undefined): boolean =>
	message?.role === "developer" && (message as { content?: unknown }).content === TRUNCATION_NOTE;
/** `A7e`: a real user prompt (not a tool result, summary or meta row). */
const isUserPrompt = (message: AgentMessage): boolean => message.role === "user";

/** `$cn`: the set carries an assistant turn, or at least 1000 tokens of non-meta user rows (tool results included). */
function substantive(messages: readonly AgentMessage[]): boolean {
	if (messages.some(isAssistant)) return true;
	const users = messages.filter(message => isUserPrompt(message) || isToolResult(message));
	return users.length > 0 && estimateTokens(users) >= 1000;
}
/** `h7e`. */
function viable(summarize: AgentMessage[] | null, keep: readonly AgentMessage[]): AgentMessage[] | null {
	return summarize !== null && substantive([...summarize, ...keep]) ? summarize : null;
}

/** `Fcn` (orig 251424778): tail groups before `end` until `gap` is covered; half when all are needed. */
function groupsCovering(tokens: readonly number[], end: number, gap: number): number {
	let sum = 0;
	let count = 0;
	for (let index = end - 1; index >= 0; index--) {
		sum += tokens[index]!;
		count++;
		if (sum >= gap) break;
	}
	return count >= end - 1 ? Math.max(1, Math.floor(end / 2)) : count;
}

/** `zfr`: summarize everything before the pending user prompt that follows the last turn. */
function splitAtPrompt(messages: readonly AgentMessage[]): { toSummarize: AgentMessage[]; toKeep: AgentMessage[] } {
	const after = 1 + Math.max(messages.findLastIndex(isAssistant), messages.findLastIndex(isToolResult));
	const index = messages.findLastIndex((message, position) => position >= after && isUserPrompt(message));
	return index === -1 ? { toSummarize: [...messages], toKeep: [] } : { toSummarize: messages.slice(0, index), toKeep: messages.slice(index) };
}

/** `sve` (orig 251547526): drop head groups worth `gap` tokens (20% without a gap). */
export function truncateHead(messages: readonly AgentMessage[], gap: number | undefined, truncationRow: () => AgentMessage): AgentMessage[] | null {
	const rest = isTruncationRow(messages[0]) ? messages.slice(1) : messages;
	const groups = apiRounds(rest);
	if (groups.length < 2) return null;
	let drop: number;
	if (gap !== undefined) {
		let sum = 0;
		drop = 0;
		for (const group of groups) {
			sum += estimateTokens(group);
			drop++;
			if (sum >= gap) break;
		}
	} else drop = Math.max(1, Math.floor(groups.length * 0.2));
	drop = Math.min(drop, groups.length - 1);
	if (drop < 1) return null;
	const remainder = groups.slice(drop).flat();
	return remainder[0]?.role === "assistant" ? [truncationRow(), ...remainder] : remainder;
}

/** `S7e·T7e + R7e` plus the 20000 slack `Ncn` requires beyond the gap. */
const OPENING_ROUND_SLACK = 20_000 + 5 * 5_000 + 25_000;
/** `oee`: last-resort head truncations. */
const MAX_HEAD_TRUNCATIONS = 3;

/** One fork attempt: the summarized messages, the verbatim tail and whether the head was cut. */
export interface ForkAttempt { summarize: AgentMessage[]; keep: AgentMessage[]; headTruncated: boolean; openingRoundAlone: boolean }
export type LadderStep = { attempt: ForkAttempt } | { failure: "too_few_groups" | "nothing_to_summarize" | "exhausted" };

/**
 * The reactive core `ive` (orig 251426256) for one compaction: `next()` gives the attempt to
 * send, `promptTooLong(gap)` moves the round ladder (or the last resort's head truncation)
 * after a prompt-too-long reply. Flags at their shipped defaults: no `keepNoRound`, fallback
 * allowed (`tengu_hidden_frog`), no `Kfr` (`tengu_clever_garden` off).
 */
export class ReactiveLadder {
	readonly #groups: AgentMessage[][];
	readonly #tokens: number[];
	readonly #all: AgentMessage[];
	readonly #initialGap: number | undefined;
	readonly #truncationRow: () => AgentMessage;
	#preserve = 1;
	#ladderGap: { gap: number | undefined; summarizeEnd: number } | undefined;
	#lastResort: { toSummarize: AgentMessage[]; toKeep: AgentMessage[]; head: number } | null = null;
	#openingAlone = false;
	#openingGap: number | undefined;
	#afterOpeningGap: number | undefined;

	constructor(history: readonly AgentMessage[], initialGap: number | undefined, truncationRow: () => AgentMessage) {
		this.#all = [...history];
		this.#groups = apiRounds(history);
		this.#tokens = this.#groups.map(estimateTokens);
		this.#initialGap = initialGap;
		this.#truncationRow = truncationRow;
		const total = this.#groups.length;
		if (initialGap !== undefined && total > 3) {
			const gap = initialGap - (this.#tokens[total - 1] ?? 0);
			if (gap > 0) this.#preserve = 1 + groupsCovering(this.#tokens, total - 1, gap);
		}
	}

	next(): LadderStep {
		if (this.#groups.length < 2) return { failure: "too_few_groups" };
		for (;;) {
			if (this.#lastResort !== null) {
				const { toSummarize, toKeep, head } = this.#lastResort;
				return { attempt: { summarize: toSummarize, keep: toKeep, headTruncated: head > 0, openingRoundAlone: false } };
			}
			const end = Math.max(0, this.#groups.length - this.#preserve);
			const summarize = this.#groups.slice(0, end).flat();
			if (summarize.some(isAssistant) || (this.#openingAlone && end === 1)) {
				return { attempt: { summarize, keep: this.#groups.slice(end).flat(), headTruncated: false, openingRoundAlone: this.#openingAlone } };
			}
			const failure = this.#leaveLadder(end);
			if (failure) return failure;
		}
	}

	/**
	 * No assistant turn is left to summarize before `end` (`zfr`): try the opening round alone when
	 * it fits, else take the last resort, head-truncated when a gap is known. A failure when nothing
	 * viable remains; `undefined` to take the next step.
	 */
	#leaveLadder(end: number): LadderStep | undefined {
		const { toSummarize, toKeep } = splitAtPrompt(this.#all);
		const gaps = this.#lastResortGaps(toKeep);
		const truncate = this.#lastResortTruncation(gaps, toKeep);
		if (truncate?.gap !== undefined && end === 1 && this.#openingRoundFits(Math.max(...gaps))) {
			this.#openingAlone = true;
			return undefined;
		}
		const chosen = truncate === undefined ? viable(toSummarize, []) : viable(truncateHead(toSummarize, truncate.gap, this.#truncationRow), toKeep);
		if (chosen === null) return { failure: "nothing_to_summarize" };
		this.#lastResort = { toSummarize: chosen, toKeep, head: truncate === undefined ? 0 : 1 };
		return undefined;
	}

	/** Every gap the ladder learned, measured against the last resort's kept tail. */
	#lastResortGaps(toKeep: readonly AgentMessage[]): number[] {
		const gaps: number[] = [];
		if (this.#ladderGap?.gap !== undefined) gaps.push(this.#ladderGap.gap + this.#sum(this.#ladderGap.summarizeEnd));
		if (this.#initialGap !== undefined) gaps.push(this.#initialGap);
		if (this.#openingGap !== undefined) gaps.push(this.#openingGap + estimateTokens(toKeep));
		if (this.#afterOpeningGap !== undefined) gaps.push(this.#afterOpeningGap + this.#sum(1));
		return gaps;
	}

	/** The head truncation the last resort starts with; `undefined` to summarize everything before the prompt. */
	#lastResortTruncation(gaps: readonly number[], toKeep: readonly AgentMessage[]): { gap: number | undefined } | undefined {
		if (gaps.length === 0) return this.#ladderGap === undefined ? undefined : { gap: undefined };
		const gap = Math.max(...gaps) - estimateTokens(toKeep);
		return gap > 0 ? { gap } : undefined;
	}

	/** The previous attempt (the opening round alone) gave no usable summary: fall back to the last resort. */
	openingRoundFailed(): void {
		this.#preserve = this.#groups.length;
	}

	/** A prompt-too-long reply to the previous attempt; `false` when the ladder is exhausted. */
	promptTooLong(gap: number | undefined): boolean {
		const total = this.#groups.length;
		if (this.#lastResort !== null) {
			const resort = this.#lastResort;
			if (!this.#openingAlone && resort.head === 0 && gap !== undefined && this.#openingRoundFits(gap + estimateTokens(resort.toKeep))) {
				this.#openingAlone = true;
				this.#openingGap = gap;
				this.#lastResort = null;
				this.#preserve = total - 1;
				return true;
			}
			const next = resort.head < MAX_HEAD_TRUNCATIONS ? viable(truncateHead(resort.toSummarize, gap, this.#truncationRow), resort.toKeep) : null;
			if (!next) return false;
			this.#lastResort = { ...resort, toSummarize: next, head: resort.head + 1 };
			return true;
		}
		const summarizeEnd = total - this.#preserve;
		if (this.#openingAlone) this.#afterOpeningGap = gap;
		else this.#ladderGap = { gap, summarizeEnd };
		this.#preserve += gap === undefined ? 1 : groupsCovering(this.#tokens, summarizeEnd, gap);
		return true;
	}

	#sum(from: number): number {
		return this.#tokens.slice(from).reduce((sum, value) => sum + value, 0);
	}

	/** `Ncn`: the opening round alone is large enough to summarize first. */
	#openingRoundFits(gap: number): boolean {
		const opening = this.#groups[0] ?? [];
		const tokens = estimateTokens(opening);
		return substantive(opening) && tokens - Math.ceil(tokens / 10) >= gap + OPENING_ROUND_SLACK;
	}
}
